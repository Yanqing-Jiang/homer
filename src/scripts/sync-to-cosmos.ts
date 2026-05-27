/**
 * Homer Memory → Cosmos DB sync.
 *
 * One canonical surface, three modes:
 *   - migrate   : full bulk upsert (legacy ETL behavior, for disaster recovery)
 *   - reconcile : fingerprint dedup — Cosmos summaries queried, only changed
 *                 docs upserted, embeddings reused on content_hash match.
 *                 Used by Mac mini nightly cron and interactive bulk refresh.
 *   - push      : simple per-row upsert with no read-side dedup pass.
 *                 Used by work-laptop /cosmos-push slash command.
 *
 * Identity rule:
 *   - `home-mac` keeps legacy document IDs to preserve the 1,668 docs from
 *     the 2026-05-21 ETL: `row.id`, `entry_${row.id}`, `session_${row.id}`.
 *   - Any other device uses prefixed IDs to avoid collisions when two
 *     independent SQLite databases hand out the same row.id:
 *     `${deviceId}:claim:${row.id}` etc.
 *
 * Fingerprint (deliberately small):
 *   - claim:   content_hash + status + archived_at
 *   - entry:   content_hash + is_active
 *   - session: content_hash + status + archived_at + searchable
 *   Excludes usage_count, last_retrieved_at, line_start, ordinal, _etag, _ts,
 *   device_id. Those don't drive the v1 sync goal.
 *
 * Auth: AAD only (Cosmos has disableLocalAuth=true). Uses DefaultAzureCredential.
 *
 * Invoked from src/scheduler/internal-handlers.ts (case "cosmos_sync") for the
 * nightly cron. Direct CLI usage:
 *   node dist/scripts/sync-to-cosmos.js \
 *     --mode reconcile --device-id home-mac --dry-run --json
 */

import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import { CosmosClient, type Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { homedir } from "os";
import { createHash } from "crypto";
import { GoogleGenerativeAI, TaskType } from "@google/generative-ai";

// --- Config ---
const COSMOS_ENDPOINT = "https://homer-memory.documents.azure.com:443/";
const DATABASE = "homer";
const CONTAINER = "memory";
const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 1000;
const EMBED_DIM = 768;
const SYNC_VERSION = 1;

// --- Types ---
export type SyncMode = "migrate" | "reconcile" | "push";
export type DeviceId = "home-mac" | "work-laptop" | (string & {});

export interface SyncOptions {
  mode: SyncMode;
  deviceId: DeviceId;
  dryRun?: boolean;
  json?: boolean;
}

export interface SyncSummary {
  mode: SyncMode;
  deviceId: DeviceId;
  dryRun: boolean;
  claims_scanned: number;
  claims_synced: number;
  entries_scanned: number;
  entries_synced: number;
  sessions_scanned: number;
  sessions_synced: number;
  skipped_unchanged: number;
  embeddings_reused: number;
  embeddings_generated: number;
  cosmos_429s: number;
  gemini_failures: number;
  elapsed_ms: number;
  started_at: string;
  finished_at: string;
}

// --- Module state (initialized lazily, reset per run) ---
let db: Database.Database | null = null;
let container: Container | null = null;
let genAI: GoogleGenerativeAI | null = null;
let metrics = { cosmos_429s: 0, gemini_failures: 0, embeddings_reused: 0, embeddings_generated: 0 };

function getDb(): Database.Database {
  if (!db) db = new Database(`${homedir()}/homer/data/homer.db`, { readonly: true });
  return db;
}

function getContainer(): Container {
  if (!container) {
    const client = new CosmosClient({
      endpoint: COSMOS_ENDPOINT,
      aadCredentials: new DefaultAzureCredential(),
    });
    container = client.database(DATABASE).container(CONTAINER);
  }
  return container;
}

function getGenAI(): GoogleGenerativeAI {
  if (!genAI) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY not set");
    genAI = new GoogleGenerativeAI(key);
  }
  return genAI;
}

// --- Helpers ---
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function parseEmbedding(buf: Buffer | null | undefined): number[] | null {
  if (!buf || buf.length === 0) return null;
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f32).slice(0, EMBED_DIM);
}

async function embedText(text: string): Promise<number[]> {
  const model = getGenAI().getGenerativeModel({ model: "gemini-embedding-001" });
  const res = await model.embedContent({
    content: { parts: [{ text }], role: "user" },
    taskType: TaskType.RETRIEVAL_DOCUMENT,
  });
  return res.embedding.values.slice(0, EMBED_DIM);
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
        metrics.gemini_failures++;
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
      await getContainer().items.upsert(doc);
      return;
    } catch (e: any) {
      if (e.code === 429 && i < retries - 1) {
        metrics.cosmos_429s++;
        const wait = (e.retryAfterInMs ?? 1000) * (i + 1);
        await sleep(wait);
      } else {
        throw e;
      }
    }
  }
}

// --- ID rule ---
function docId(deviceId: DeviceId, source: "claim" | "entry" | "session", rowId: string): string {
  if (deviceId === "home-mac") {
    if (source === "claim") return rowId;
    return `${source}_${rowId}`;
  }
  return `${deviceId}:${source}:${rowId}`;
}

// --- Fingerprint ---
function fp(...parts: Array<string | number | null | undefined>): string {
  return createHash("sha256")
    .update(parts.map((p) => (p == null ? "" : String(p))).join("|"))
    .digest("hex")
    .slice(0, 16);
}

function claimFingerprint(row: any): string {
  return fp(SYNC_VERSION, "claim", row.content_hash, row.status, row.archived_at);
}
function entryFingerprint(row: any): string {
  return fp(SYNC_VERSION, "entry", row.entry_hash, row.is_active);
}
function sessionFingerprint(row: any): string {
  return fp(SYNC_VERSION, "session", row.content_hash, row.status, row.archived_at, row.searchable);
}

// --- Document builders ---
function buildClaimDoc(row: any, deviceId: DeviceId, embedding: number[]): any {
  return {
    id: docId(deviceId, "claim", row.id),
    source_type: "claim",
    content: row.content,
    embedding,
    metadata: {
      claim_type: row.claim_type, target_file: row.target_file, section: row.section,
      confidence: row.confidence, status: row.status, session_id: row.session_id,
      source_url: row.source_url, domain: row.domain, origin_channel: row.origin_channel,
      canonical_path: row.canonical_path, event_date: row.event_date,
      user_explicit: row.user_explicit, base_priority: row.base_priority,
      promote_score: row.promote_score, utility_score: row.utility_score,
      retrieval_weight: row.retrieval_weight, cluster_key: row.cluster_key,
      archived_at: row.archived_at, archived_reason: row.archived_reason,
    },
    device_id: deviceId,
    sync_fingerprint: claimFingerprint(row),
    sync_version: SYNC_VERSION,
    op_id: `op_sync_claim_${row.id}`,
    content_hash: row.content_hash,
    status: row.status,
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function buildEntryDoc(row: any, deviceId: DeviceId, embedding: number[]): any {
  return {
    id: docId(deviceId, "entry", row.id),
    source_type: "entry",
    content: row.entry_text,
    embedding,
    metadata: {
      file_key: row.file_key, relative_path: row.relative_path, section_path: row.section_path,
      entry_kind: row.entry_kind, line_start: row.line_start, line_end: row.line_end,
      ordinal_in_file: row.ordinal_in_file, promoted_at: row.promoted_at,
      last_reviewed_at: row.last_reviewed_at, last_retrieved_at: row.last_retrieved_at,
      usage_count: row.usage_count, is_active: row.is_active,
    },
    device_id: deviceId,
    sync_fingerprint: entryFingerprint(row),
    sync_version: SYNC_VERSION,
    op_id: `op_sync_entry_${row.id}`,
    content_hash: row.entry_hash,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function buildSessionDoc(row: any, deviceId: DeviceId, embedding: number[]): any {
  return {
    id: docId(deviceId, "session", row.id),
    source_type: "session_summary",
    content: row.summary ?? row.title ?? "",
    embedding,
    metadata: {
      agent: row.agent, native_session_id: row.native_session_id, model: row.model,
      project: row.project, title: row.title, started_at: row.started_at, ended_at: row.ended_at,
      message_count: row.message_count, is_sub_agent: row.is_sub_agent, status: row.status,
      searchable: row.searchable, archive_reason: row.archive_reason, archived_at: row.archived_at,
    },
    device_id: deviceId,
    sync_fingerprint: sessionFingerprint(row),
    sync_version: SYNC_VERSION,
    op_id: `op_sync_session_${row.id}`,
    content_hash: row.content_hash,
    status: row.status,
    archived_at: row.archived_at,
    searchable: row.searchable,
    created_at: row.created_at,
    updated_at: row.created_at,
  };
}

// --- Remote-fingerprint helpers (reconcile only) ---
interface RemoteSummary {
  id: string;
  source_type: string;
  content_hash?: string | null;
  sync_fingerprint?: string | null;
  device_id?: string | null;
  // New schema (top-level mirrors written by sync-to-cosmos.ts going forward)
  status?: string | null;
  archived_at?: string | null;
  is_active?: number | null;
  searchable?: number | null;
  // Legacy schema (migrated docs from 2026-05-21 ETL — only under metadata.*)
  m_status?: string | null;
  m_archived_at?: string | null;
  m_is_active?: number | null;
  m_searchable?: number | null;
}

function remoteFingerprintFromSummary(s: RemoteSummary): string {
  // Mirror the local fingerprint shape from whatever fields the remote has.
  // For docs written by sync-to-cosmos.ts, s.sync_fingerprint is the authoritative answer.
  if (s.sync_fingerprint) return s.sync_fingerprint;
  // Legacy migration docs predate sync_fingerprint AND store lifecycle fields only
  // under metadata.*, not at top level. Prefer top-level (new schema), fall back to
  // metadata-projected fields (legacy schema).
  const status = s.status ?? s.m_status ?? null;
  const archived_at = s.archived_at ?? s.m_archived_at ?? null;
  const is_active = s.is_active ?? s.m_is_active ?? null;
  const searchable = s.searchable ?? s.m_searchable ?? null;
  if (s.source_type === "claim") return fp(SYNC_VERSION, "claim", s.content_hash, status, archived_at);
  if (s.source_type === "entry") return fp(SYNC_VERSION, "entry", s.content_hash, is_active);
  if (s.source_type === "session_summary") return fp(SYNC_VERSION, "session", s.content_hash, status, archived_at, searchable);
  return "";
}

async function loadRemoteSummaries(deviceId: DeviceId): Promise<Map<string, RemoteSummary>> {
  const map = new Map<string, RemoteSummary>();
  const q = `SELECT c.id, c.source_type, c.content_hash, c.sync_fingerprint, c.device_id,
                    c.status, c.archived_at, c.is_active, c.searchable,
                    c.metadata.status AS m_status, c.metadata.archived_at AS m_archived_at,
                    c.metadata.is_active AS m_is_active, c.metadata.searchable AS m_searchable
             FROM c
             WHERE c.source_type IN ('claim','entry','session_summary')
               AND c.device_id = @deviceId`;
  const iter = getContainer().items.query(
    { query: q, parameters: [{ name: "@deviceId", value: deviceId }] },
    { maxItemCount: 1000 }
  );
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources as RemoteSummary[]) map.set(r.id, r);
  }
  return map;
}

async function pointReadEmbedding(id: string, partitionKey: string): Promise<number[] | null> {
  try {
    const { resource } = await getContainer().item(id, partitionKey).read<any>();
    if (resource?.embedding && Array.isArray(resource.embedding)) return resource.embedding;
  } catch {
    // 404 etc. — fall through.
  }
  return null;
}

// --- Embedding resolution (reuse → BLOB → Gemini) ---
async function resolveClaimEmbedding(row: any, remote: RemoteSummary | undefined, allowRemoteReuse: boolean): Promise<number[]> {
  if (allowRemoteReuse && remote && remote.content_hash === row.content_hash) {
    const e = await pointReadEmbedding(remote.id, remote.source_type);
    if (e) { metrics.embeddings_reused++; return e; }
  }
  const blob = getDb()
    .prepare("SELECT embedding FROM memory_embeddings WHERE file_path = 'claim:' || ? LIMIT 1")
    .get(row.id) as { embedding: Buffer } | undefined;
  const parsed = parseEmbedding(blob?.embedding);
  if (parsed && parsed.length === EMBED_DIM) { metrics.embeddings_reused++; return parsed; }
  metrics.embeddings_generated++;
  return embedWithRetry(row.content);
}

async function resolveEntryEmbedding(row: any, remote: RemoteSummary | undefined, allowRemoteReuse: boolean): Promise<number[]> {
  if (allowRemoteReuse && remote && remote.content_hash === row.entry_hash) {
    const e = await pointReadEmbedding(remote.id, remote.source_type);
    if (e) { metrics.embeddings_reused++; return e; }
  }
  // No local BLOB cache for entries (per migrate-to-cosmos.ts line 146 — file-path
  // BLOBs are per-chunk, not per-entry). Always call Gemini if no remote reuse.
  metrics.embeddings_generated++;
  return embedWithRetry(row.entry_text);
}

async function resolveSessionEmbedding(row: any, remote: RemoteSummary | undefined, allowRemoteReuse: boolean): Promise<number[]> {
  const text = row.summary ?? row.title ?? "";
  if (allowRemoteReuse && remote && remote.content_hash === row.content_hash) {
    const e = await pointReadEmbedding(remote.id, remote.source_type);
    if (e) { metrics.embeddings_reused++; return e; }
  }
  const blob = getDb()
    .prepare("SELECT embedding FROM memory_embeddings WHERE file_path = 'session:' || ? LIMIT 1")
    .get(row.id) as { embedding: Buffer } | undefined;
  const parsed = parseEmbedding(blob?.embedding);
  if (parsed && parsed.length === EMBED_DIM) { metrics.embeddings_reused++; return parsed; }
  metrics.embeddings_generated++;
  return embedWithRetry(text || "(empty session)");
}

// --- Sync engine ---
async function syncTable<TRow>(
  rows: TRow[],
  deviceId: DeviceId,
  mode: SyncMode,
  dryRun: boolean,
  remote: Map<string, RemoteSummary> | null,
  localFp: (r: TRow) => string,
  localId: (r: TRow) => string,
  resolveEmb: (r: TRow, remote: RemoteSummary | undefined) => Promise<number[]>,
  buildDoc: (r: TRow, deviceId: DeviceId, embedding: number[]) => any,
): Promise<{ scanned: number; synced: number; skipped: number }> {
  let scanned = 0, synced = 0, skipped = 0;
  let batchPushed = 0;
  for (const row of rows) {
    scanned++;
    const id = localId(row);
    if (mode === "reconcile") {
      const remoteSummary = remote!.get(id);
      const localFingerprint = localFp(row);
      const remoteFp = remoteSummary ? remoteFingerprintFromSummary(remoteSummary) : null;
      if (remoteFp && remoteFp === localFingerprint) { skipped++; continue; }
    }
    if (dryRun) { synced++; continue; }
    const remoteSummary = remote?.get(id);
    const embedding = await resolveEmb(row, remoteSummary);
    const doc = buildDoc(row, deviceId, embedding);
    await upsertWithRetry(doc);
    synced++;
    batchPushed++;
    if (batchPushed >= BATCH_SIZE) {
      batchPushed = 0;
      await sleep(BATCH_DELAY_MS);
    }
  }
  return { scanned, synced, skipped };
}

// --- Seed doc (migrate mode only — prevents empty-index hang on diskANN) ---
async function insertSeedDoc(deviceId: DeviceId, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  const text = "This is a warmup document to initialize the diskANN vector index.";
  metrics.embeddings_generated++;
  const embedding = await embedWithRetry(text);
  await upsertWithRetry({
    id: "seed_warmup_001",
    source_type: "system",
    content: text,
    embedding,
    metadata: { purpose: "index_warmup" },
    device_id: deviceId,
    sync_version: SYNC_VERSION,
    op_id: "op_seed_001",
    content_hash: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

// --- Public entrypoint ---
export async function runCosmosSync(opts: SyncOptions): Promise<SyncSummary> {
  const startedAt = new Date();
  const dryRun = !!opts.dryRun;
  metrics = { cosmos_429s: 0, gemini_failures: 0, embeddings_reused: 0, embeddings_generated: 0 };

  const claims = getDb().prepare("SELECT * FROM knowledge_claims").all() as any[];
  const entries = getDb().prepare("SELECT * FROM memory_entries").all() as any[];
  const sessions = getDb().prepare("SELECT * FROM session_summaries").all() as any[];

  const allowRemoteReuse = opts.mode === "reconcile" || opts.mode === "push";
  let remote: Map<string, RemoteSummary> | null = null;
  if (opts.mode === "reconcile") {
    remote = await loadRemoteSummaries(opts.deviceId);
  }

  if (opts.mode === "migrate") await insertSeedDoc(opts.deviceId, dryRun);

  const c = await syncTable(
    claims, opts.deviceId, opts.mode, dryRun, remote,
    claimFingerprint,
    (r: any) => docId(opts.deviceId, "claim", r.id),
    (r, rs) => resolveClaimEmbedding(r, rs, allowRemoteReuse),
    buildClaimDoc,
  );
  const e = await syncTable(
    entries, opts.deviceId, opts.mode, dryRun, remote,
    entryFingerprint,
    (r: any) => docId(opts.deviceId, "entry", r.id),
    (r, rs) => resolveEntryEmbedding(r, rs, allowRemoteReuse),
    buildEntryDoc,
  );
  const s = await syncTable(
    sessions, opts.deviceId, opts.mode, dryRun, remote,
    sessionFingerprint,
    (r: any) => docId(opts.deviceId, "session", r.id),
    (r, rs) => resolveSessionEmbedding(r, rs, allowRemoteReuse),
    buildSessionDoc,
  );

  const finishedAt = new Date();
  return {
    mode: opts.mode,
    deviceId: opts.deviceId,
    dryRun,
    claims_scanned: c.scanned, claims_synced: c.synced,
    entries_scanned: e.scanned, entries_synced: e.synced,
    sessions_scanned: s.scanned, sessions_synced: s.synced,
    skipped_unchanged: c.skipped + e.skipped + s.skipped,
    embeddings_reused: metrics.embeddings_reused,
    embeddings_generated: metrics.embeddings_generated,
    cosmos_429s: metrics.cosmos_429s,
    gemini_failures: metrics.gemini_failures,
    elapsed_ms: finishedAt.getTime() - startedAt.getTime(),
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
  };
}

// --- CLI ---
function parseArgs(argv: string[]): SyncOptions {
  const opts: Partial<SyncOptions> & { json?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") { opts.mode = argv[++i] as SyncMode; }
    else if (a === "--device-id") { opts.deviceId = argv[++i] as DeviceId; }
    else if (a === "--dry-run") { opts.dryRun = true; }
    else if (a === "--json") { opts.json = true; }
    else if (a === "--help" || a === "-h") {
      console.log("Usage: sync-to-cosmos --mode migrate|reconcile|push --device-id <id> [--dry-run] [--json]");
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  if (!opts.mode) throw new Error("--mode required");
  if (!opts.deviceId) throw new Error("--device-id required");
  if (!["migrate", "reconcile", "push"].includes(opts.mode)) throw new Error(`Invalid mode: ${opts.mode}`);
  return opts as SyncOptions;
}

async function cliMain(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const summary = await runCosmosSync(opts);
  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`=== Cosmos sync (${opts.mode}, device=${opts.deviceId}${opts.dryRun ? ", DRY-RUN" : ""}) ===`);
    console.log(`  claims:    ${summary.claims_synced}/${summary.claims_scanned} synced`);
    console.log(`  entries:   ${summary.entries_synced}/${summary.entries_scanned} synced`);
    console.log(`  sessions:  ${summary.sessions_synced}/${summary.sessions_scanned} synced`);
    console.log(`  skipped:   ${summary.skipped_unchanged}`);
    console.log(`  embeddings: ${summary.embeddings_reused} reused, ${summary.embeddings_generated} generated`);
    console.log(`  retries:   cosmos_429=${summary.cosmos_429s}, gemini_fail=${summary.gemini_failures}`);
    console.log(`  elapsed:   ${summary.elapsed_ms} ms`);
  }
}

// CLI guard: only run main() when invoked directly (not when imported by the scheduler).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  cliMain().catch((e) => {
    console.error("❌ Sync failed:", e);
    process.exit(1);
  });
}
