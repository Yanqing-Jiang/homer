import Database from "better-sqlite3";
import { CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { homedir } from "os";
import { GoogleGenerativeAI, TaskType } from "@google/generative-ai";

// --- Config ---
const COSMOS_ENDPOINT = "https://homer-memory.documents.azure.com:443/";
const DATABASE = "homer";
const CONTAINER = "memory";
const BATCH_SIZE = 50;
const DELAY_MS = 1000;
const EMBED_DIM = 768;

// --- Clients ---
const db = new Database(`${homedir()}/homer/data/homer.db`, { readonly: true });
const cosmos = new CosmosClient({
  endpoint: COSMOS_ENDPOINT,
  aadCredentials: new DefaultAzureCredential(),
});
const container = cosmos.database(DATABASE).container(CONTAINER);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// --- Helpers ---
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function embedText(text: string): Promise<number[]> {
  const model = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
  const res = await model.embedContent({
    content: { parts: [{ text }], role: "user" },
    taskType: TaskType.RETRIEVAL_DOCUMENT,
  });
  return res.embedding.values.slice(0, EMBED_DIM);
}

function parseEmbedding(buf: Buffer | null | undefined): number[] | null {
  if (!buf || buf.length === 0) return null;
  // BLOB is a packed Float32Array
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const arr = Array.from(f32);
  return arr.slice(0, EMBED_DIM);
}

async function embedWithRetry(text: string, retries = 8): Promise<number[]> {
  let backoff = 2000;
  for (let i = 0; i < retries; i++) {
    try {
      const v = await embedText(text);
      await sleep(100); // gentle on Gemini
      return v;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const status = e?.status;
      const transient =
        status === 429 || status === 500 || status === 502 || status === 503 || status === 504 ||
        /429|5\d\d|RESOURCE_EXHAUSTED|UNAVAILABLE|quota|rate|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(msg);
      if (i < retries - 1 && transient) {
        console.log(`  gemini transient (${status ?? "?"}) — waiting ${backoff}ms: ${msg.slice(0, 100)}`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60000);
      } else {
        throw e;
      }
    }
  }
  throw new Error("embedWithRetry exhausted");
}

async function upsertWithRetry(doc: any, retries = 4): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await container.items.upsert(doc);
      return;
    } catch (e: any) {
      if (e.code === 429 && i < retries - 1) {
        const wait = (e.retryAfterInMs ?? 1000) * (i + 1);
        console.log(`  cosmos 429 — waiting ${wait}ms`);
        await sleep(wait);
      } else {
        throw e;
      }
    }
  }
}

// --- Migration functions ---

async function migrateClaims() {
  const claims = db.prepare("SELECT * FROM knowledge_claims").all() as any[];
  console.log(`\n📋 Migrating ${claims.length} claims...`);
  const lookup = db.prepare(
    "SELECT embedding FROM memory_embeddings WHERE file_path = 'claim:' || ? LIMIT 1"
  );

  for (let i = 0; i < claims.length; i += BATCH_SIZE) {
    const batch = claims.slice(i, i + BATCH_SIZE);
    for (const row of batch) {
      const embRow = lookup.get(row.id) as { embedding: Buffer } | undefined;
      let embedding = parseEmbedding(embRow?.embedding);
      if (!embedding || embedding.length !== EMBED_DIM) {
        embedding = await embedWithRetry(row.content);
      }

      await upsertWithRetry({
        id: row.id,
        source_type: "claim",
        content: row.content,
        embedding,
        metadata: {
          claim_type: row.claim_type,
          target_file: row.target_file,
          section: row.section,
          confidence: row.confidence,
          status: row.status,
          session_id: row.session_id,
          source_url: row.source_url,
          domain: row.domain,
          origin_channel: row.origin_channel,
          canonical_path: row.canonical_path,
          event_date: row.event_date,
          user_explicit: row.user_explicit,
          base_priority: row.base_priority,
          promote_score: row.promote_score,
          utility_score: row.utility_score,
          retrieval_weight: row.retrieval_weight,
          cluster_key: row.cluster_key,
          archived_at: row.archived_at,
          archived_reason: row.archived_reason,
        },
        device_id: "home-mac",
        op_id: `op_migrate_${row.id}`,
        content_hash: row.content_hash,
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
    }
    console.log(`  claims: ${Math.min(i + BATCH_SIZE, claims.length)}/${claims.length}`);
    await sleep(DELAY_MS);
  }
}

async function migrateEntries() {
  const entries = db.prepare("SELECT * FROM memory_entries").all() as any[];
  console.log(`\n📝 Migrating ${entries.length} entries...`);
  // entry-level embeddings aren't stored separately; fall back to re-embed entry_text
  // (file-path embeddings in memory_embeddings are per-file-chunk, not aligned to entries)

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    for (const row of batch) {
      const embedding = await embedWithRetry(row.entry_text);

      await upsertWithRetry({
        id: `entry_${row.id}`,
        source_type: "entry",
        content: row.entry_text,
        embedding,
        metadata: {
          file_key: row.file_key,
          relative_path: row.relative_path,
          section_path: row.section_path,
          entry_kind: row.entry_kind,
          line_start: row.line_start,
          line_end: row.line_end,
          ordinal_in_file: row.ordinal_in_file,
          promoted_at: row.promoted_at,
          last_reviewed_at: row.last_reviewed_at,
          last_retrieved_at: row.last_retrieved_at,
          usage_count: row.usage_count,
          is_active: row.is_active,
        },
        device_id: "home-mac",
        op_id: `op_migrate_entry_${row.id}`,
        content_hash: row.entry_hash,
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
    }
    console.log(`  entries: ${Math.min(i + BATCH_SIZE, entries.length)}/${entries.length}`);
    await sleep(DELAY_MS);
  }
}

async function migrateSessionSummaries() {
  const sessions = db.prepare("SELECT * FROM session_summaries").all() as any[];
  console.log(`\n🗂️  Migrating ${sessions.length} session summaries...`);
  const lookup = db.prepare(
    "SELECT embedding FROM memory_embeddings WHERE file_path = 'session:' || ? LIMIT 1"
  );

  for (let i = 0; i < sessions.length; i += BATCH_SIZE) {
    const batch = sessions.slice(i, i + BATCH_SIZE);
    for (const row of batch) {
      const embRow = lookup.get(row.id) as { embedding: Buffer } | undefined;
      let embedding = parseEmbedding(embRow?.embedding);
      const text = row.summary ?? row.title ?? "";
      if (!embedding || embedding.length !== EMBED_DIM) {
        embedding = await embedWithRetry(text || "(empty session)");
      }

      await upsertWithRetry({
        id: `session_${row.id}`,
        source_type: "session_summary",
        content: text,
        embedding,
        metadata: {
          agent: row.agent,
          native_session_id: row.native_session_id,
          model: row.model,
          project: row.project,
          title: row.title,
          started_at: row.started_at,
          ended_at: row.ended_at,
          message_count: row.message_count,
          is_sub_agent: row.is_sub_agent,
          status: row.status,
          searchable: row.searchable,
          archive_reason: row.archive_reason,
          archived_at: row.archived_at,
        },
        device_id: "home-mac",
        op_id: `op_migrate_session_${row.id}`,
        content_hash: row.content_hash,
        created_at: row.created_at,
        updated_at: row.created_at,
      });
    }
    console.log(`  sessions: ${Math.min(i + BATCH_SIZE, sessions.length)}/${sessions.length}`);
    await sleep(DELAY_MS);
  }
}

// --- Seed document (prevents empty-index hang on diskANN) ---
async function insertSeedDoc() {
  console.log("\n🌱 Inserting seed/warmup document...");
  const seedText = "This is a warmup document to initialize the diskANN vector index.";
  const embedding = await embedWithRetry(seedText);
  await upsertWithRetry({
    id: "seed_warmup_001",
    source_type: "system",
    content: seedText,
    embedding,
    metadata: { purpose: "index_warmup" },
    device_id: "home-mac",
    op_id: "op_seed_001",
    content_hash: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

// --- Main ---
async function main() {
  console.log("=== Homer Memory → Cosmos DB Migration ===\n");

  await insertSeedDoc();
  await migrateClaims();
  await migrateEntries();
  await migrateSessionSummaries();

  console.log("\n✅ Migration complete.");
}

main().catch((e) => {
  console.error("❌ Migration failed:", e);
  process.exit(1);
});
