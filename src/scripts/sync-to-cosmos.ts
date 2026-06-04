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
// Cosmos hard-caps an item at 2 MB (UTF-8 JSON). Guard transcript bodies well under
// it; oversized ones are skipped + logged rather than thrown at upsert time. Today's
// largest transcript is ~309 KB, so this only bites if a single session balloons.
const MAX_DOC_BYTES = 1_500_000;

// --- Types ---
export type SyncMode = "migrate" | "reconcile" | "push" | "pull";
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
  transcripts_scanned: number;
  transcripts_synced: number;
  transcripts_skipped_too_large: number;
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

// --- Transcript doc builder (Cosmos id = transcript_hash) ---
// Deliberately separate from buildSessionDoc: transcripts are IMMUTABLE archive
// blobs with NO embedding and NO summary lifecycle (status/searchable/fingerprint).
// id = transcript_hash makes the same transcript dedup globally inside the
// /source_type = "session_transcript" partition and merge conflict-free on pull.
function buildTranscriptDoc(row: any, deviceId: DeviceId): any {
  return {
    id: row.transcript_hash,
    source_type: "session_transcript",
    transcript_hash: row.transcript_hash,
    content_hash: row.content_hash, // link back to the session_summary fingerprint
    device_id: deviceId,
    agent: row.agent,
    native_session_id: row.session_id,
    model: row.model,
    project: row.project,
    started_at: row.started_at,
    ended_at: row.ended_at,
    message_count: row.message_count,
    uncompressed_size: row.uncompressed_size,
    messages_json: row.messages_json,
    sync_version: SYNC_VERSION,
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
  // Full Cosmos docs (passed by runCosmosPull) carry lifecycle under metadata.*
  // rather than the m_* aliases that loadRemoteSummaries projects.
  metadata?: any;
}

function remoteFingerprintFromSummary(s: RemoteSummary): string {
  // Mirror the local fingerprint shape from whatever fields the remote has.
  // For docs written by sync-to-cosmos.ts, s.sync_fingerprint is the authoritative answer.
  if (s.sync_fingerprint) return s.sync_fingerprint;
  // Legacy migration docs predate sync_fingerprint AND store lifecycle fields only
  // under metadata.*, not at top level. Prefer top-level (new schema), fall back to
  // the m_* projection (loadRemoteSummaries) and then raw metadata.* (full pull docs).
  const status = s.status ?? s.m_status ?? s.metadata?.status ?? null;
  const archived_at = s.archived_at ?? s.m_archived_at ?? s.metadata?.archived_at ?? null;
  const is_active = s.is_active ?? s.m_is_active ?? s.metadata?.is_active ?? null;
  const searchable = s.searchable ?? s.m_searchable ?? s.metadata?.searchable ?? null;
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

// --- Transcript push (reconcile-all, no cursor) ---
// Transcripts are immutable + tiny in count, so we scan EVERY locally-authored row
// and upsert by id=transcript_hash. Cosmos upsert is idempotent, so re-running is
// free; there is deliberately NO imported_at cursor and NO per-row `synced` flag —
// both would add a stale-state surface that buys nothing at this scale.
async function pushTranscripts(
  deviceId: DeviceId,
  dryRun: boolean,
): Promise<{ scanned: number; synced: number; skippedTooLarge: number }> {
  let scanned = 0, synced = 0, skippedTooLarge = 0;
  // Preflight: locally-authored rows with NULL transcript_hash mean the migration-099
  // backfill hasn't been run on this device. They'd be silently skipped below — warn
  // loudly so a partial sync can't pass unnoticed. Fix: node dist/scripts/backfill-transcript-hash.js
  const unhashed = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM session_transcripts
       WHERE (origin_device IS NULL OR origin_device = ?) AND transcript_hash IS NULL`
    )
    .get(deviceId) as { n: number };
  if (unhashed.n > 0) {
    console.warn(`⚠️  ${unhashed.n} local transcript(s) have NULL transcript_hash and will NOT sync — run: node dist/scripts/backfill-transcript-hash.js`);
  }
  // Only push locally-authored rows (mirror the nativeWhere filter for summaries).
  // transcript_hash NULL means the backfill hasn't run for that row yet — skip it.
  const rows = getDb()
    .prepare(
      `SELECT * FROM session_transcripts
       WHERE (origin_device IS NULL OR origin_device = ?)
         AND transcript_hash IS NOT NULL`
    )
    .all(deviceId) as any[];

  let batchPushed = 0;
  for (const row of rows) {
    scanned++;
    const doc = buildTranscriptDoc(row, deviceId);
    const bytes = Buffer.byteLength(JSON.stringify(doc), "utf-8");
    if (bytes > MAX_DOC_BYTES) {
      skippedTooLarge++;
      console.warn(`⚠️  transcript ${row.transcript_hash?.slice(0, 12)} is ${bytes} bytes (> ${MAX_DOC_BYTES}) — skipping (Cosmos 2MB limit)`);
      continue;
    }
    if (dryRun) { synced++; continue; }
    await upsertWithRetry(doc);
    synced++;
    batchPushed++;
    if (batchPushed >= BATCH_SIZE) {
      batchPushed = 0;
      await sleep(BATCH_DELAY_MS);
    }
  }
  return { scanned, synced, skippedTooLarge };
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
  if ((opts.mode as string) === "pull") throw new Error("runCosmosSync does not handle 'pull' — use runCosmosPull()");
  const startedAt = new Date();
  const dryRun = !!opts.dryRun;
  metrics = { cosmos_429s: 0, gemini_failures: 0, embeddings_reused: 0, embeddings_generated: 0 };

  // Only push locally-authored rows. Rows with origin_device set were imported FROM
  // Cosmos by runCosmosPull and must NOT be re-published under this device's IDs —
  // that would duplicate/corrupt the source device's corpus. `IS NULL` covers all
  // pre-098 and natively-authored rows; `= deviceId` is a defensive allowance for a
  // device's own rows should they ever be tagged.
  const nativeWhere = "WHERE origin_device IS NULL OR origin_device = ?";
  const claims = getDb().prepare(`SELECT * FROM knowledge_claims ${nativeWhere}`).all(opts.deviceId) as any[];
  const entries = getDb().prepare(`SELECT * FROM memory_entries ${nativeWhere}`).all(opts.deviceId) as any[];
  const sessions = getDb().prepare(`SELECT * FROM session_summaries ${nativeWhere}`).all(opts.deviceId) as any[];

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

  // Transcripts: separate reconcile-all pass, no embeddings, no fingerprint reuse.
  const t = await pushTranscripts(opts.deviceId, dryRun);

  const finishedAt = new Date();
  return {
    mode: opts.mode,
    deviceId: opts.deviceId,
    dryRun,
    claims_scanned: c.scanned, claims_synced: c.synced,
    entries_scanned: e.scanned, entries_synced: e.synced,
    sessions_scanned: s.scanned, sessions_synced: s.synced,
    transcripts_scanned: t.scanned, transcripts_synced: t.synced,
    transcripts_skipped_too_large: t.skippedTooLarge,
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

// ===========================================================================
// PULL: Cosmos -> local SQLite (reverse of runCosmosSync).
//
// Harvests memory authored on OTHER devices (device_id != localDeviceId) into
// the local DB so local retrieval (FTS + session vector search) surfaces it.
// v1 scope: claims + sessions (memory_entries is not in any local search path,
// so importing it would be dead weight — deferred). Imported rows are tagged
// origin_device = <source device> so the push (runCosmosSync) excludes them.
//
// Idempotent: re-runnable via fingerprint comparison against existing local
// rows. Never writes to Cosmos. One bad foreign doc never aborts the run
// (per-row try/catch, no table-wide transaction).
// ===========================================================================

export interface PullOptions {
  localDeviceId: DeviceId;
  sourceDeviceIds?: DeviceId[]; // default: every device that isn't localDeviceId
  dryRun?: boolean;
  json?: boolean;
}

export interface PullSummary {
  localDeviceId: DeviceId;
  sourceDeviceIds: DeviceId[] | "all-foreign";
  dryRun: boolean;
  claims_scanned: number;
  claims_upserted: number;
  sessions_scanned: number;
  sessions_upserted: number;
  transcripts_scanned: number;
  transcripts_upserted: number;
  transcripts_skipped: number;
  embeddings_written: number;
  skipped_unchanged: number;
  skipped_invalid: number;
  skipped_duplicate_hash: number;
  skipped_origin_conflict: number;
  errors: number;
  cosmos_429s: number;
  elapsed_ms: number;
  started_at: string;
  finished_at: string;
}

const CLAIM_TYPES = new Set([
  "fact", "decision", "preference", "hypothesis", "insight", "commitment",
  "question", "lesson", "skill", "cleanup", "replace", "remove",
]);
const CLAIM_STATUSES = new Set(["candidate", "applying", "approved", "rejected", "expired", "stale", "archived"]);
const SESSION_AGENTS = new Set(["codex", "gemini", "kimi", "claude", "opencode", "daemon", "telegram", "web"]);
const SESSION_STATUSES = new Set(["active", "archived"]);
// Lifecycle whitelist — don't import the other device's terminal/noise rows.
const CLAIM_PULL_STATUSES = new Set(["approved", "candidate", "stale"]);

// Inverse of parseEmbedding: number[] -> little-endian Float32 BLOB.
function embeddingToBlob(values: unknown): Buffer | null {
  if (!Array.isArray(values) || values.length < EMBED_DIM) return null;
  const f32 = Float32Array.from(values.slice(0, EMBED_DIM).map(Number));
  if (!f32.every(Number.isFinite)) return null;
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

// Inverse of docId: derive a namespaced local PK from a Cosmos doc.
// Prefixed foreign ids (work-laptop:claim:123) are reused verbatim; legacy
// home-mac bare ids are normalized to deviceId:source:rawId so a symmetric
// pull on another machine cannot collide with that machine's native ids.
function localImportId(doc: { id: string; device_id: string; source_type: string }): string {
  if (doc.id.includes(":")) return doc.id;
  const src = doc.source_type === "session_summary" ? "session" : doc.source_type;
  const raw = doc.id.replace(/^entry_/, "").replace(/^session_/, "");
  return `${doc.device_id}:${src}:${raw}`;
}

function toInt(v: unknown, dflt = 0): number {
  if (v === true) return 1;
  if (v === false) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

// Schemaless-safe scalar coercion for better-sqlite3 named bindings (which reject
// `undefined` and booleans, and where binding NaN is version-dependent).
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown, dflt: number | null = null): number | null {
  if (typeof v === "boolean") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// A valid foreign provenance: a non-empty string that isn't this device. Required
// so imported rows always carry a non-null origin_device — otherwise the push
// filter (origin_device IS NULL) would re-publish them as local. (BLOCKER #1)
function validForeignDevice(deviceId: unknown, localDeviceId: DeviceId): deviceId is string {
  return typeof deviceId === "string" && deviceId.length > 0 && deviceId !== localDeviceId;
}

async function queryForeignDocs(
  sourceType: "claim" | "session_summary" | "session_transcript",
  localDeviceId: DeviceId,
  sourceDeviceIds: DeviceId[] | undefined,
): Promise<any[]> {
  // Partition key is /source_type, so scoping the query to one source_type is a
  // single-partition read; device_id is a within-partition filter.
  const params: any[] = [{ name: "@local", value: localDeviceId }];
  // Defence-in-depth: only pull docs whose device_id is a real, non-empty,
  // foreign string. The row loop validates again (validForeignDevice).
  let where = "IS_DEFINED(c.device_id) AND IS_STRING(c.device_id) AND c.device_id != '' AND c.device_id != @local";
  if (sourceDeviceIds && sourceDeviceIds.length) {
    where += " AND ARRAY_CONTAINS(@sources, c.device_id)";
    params.push({ name: "@sources", value: sourceDeviceIds });
  }
  const out: any[] = [];
  const iter = getContainer().items.query(
    { query: `SELECT * FROM c WHERE ${where}`, parameters: params },
    { partitionKey: sourceType, maxItemCount: 1000 } as any,
  );
  let retries = 0;
  while (iter.hasMoreResults()) {
    try {
      const { resources } = await iter.fetchNext();
      for (const r of resources) out.push(r);
      retries = 0;
    } catch (e: any) {
      if (e?.code === 429 && retries < 8) {
        metrics.cosmos_429s++; retries++;
        await sleep(Math.min((e.retryAfterInMs ?? 1000) * retries, 30000));
        continue;
      }
      throw e;
    }
  }
  return out;
}

export async function runCosmosPull(opts: PullOptions): Promise<PullSummary> {
  const startedAt = new Date();
  const dryRun = !!opts.dryRun;
  metrics = { cosmos_429s: 0, gemini_failures: 0, embeddings_reused: 0, embeddings_generated: 0 };

  const sum = {
    claims_scanned: 0, claims_upserted: 0,
    sessions_scanned: 0, sessions_upserted: 0,
    transcripts_scanned: 0, transcripts_upserted: 0, transcripts_skipped: 0,
    embeddings_written: 0, skipped_unchanged: 0,
    skipped_invalid: 0, skipped_duplicate_hash: 0,
    skipped_origin_conflict: 0, errors: 0,
  };

  // Writable handle — getDb() is opened readonly for the push.
  const wdb = new Database(`${homedir()}/homer/data/homer.db`);
  wdb.pragma("busy_timeout = 5000");

  try {
    // ---- Claims ----
    const claimById = wdb.prepare("SELECT * FROM knowledge_claims WHERE id = ?");
    const claimInsert = wdb.prepare(`
      INSERT INTO knowledge_claims
        (id, content, content_hash, target_file, section, claim_type, confidence, status,
         session_id, source_url, created_at, updated_at, origin_channel, domain, canonical_path,
         event_date, user_explicit, base_priority, promote_score, utility_score, retrieval_weight,
         cluster_key, archived_at, archived_reason, origin_device)
      VALUES
        (@id, @content, @content_hash, @target_file, @section, @claim_type, @confidence, @status,
         @session_id, @source_url, @created_at, @updated_at, @origin_channel, @domain, @canonical_path,
         @event_date, @user_explicit, @base_priority, @promote_score, @utility_score, @retrieval_weight,
         @cluster_key, @archived_at, @archived_reason, @origin_device)`);
    const claimUpdate = wdb.prepare(`
      UPDATE knowledge_claims SET
        content=@content, content_hash=@content_hash, target_file=@target_file, section=@section,
        claim_type=@claim_type, confidence=@confidence, status=@status, session_id=@session_id,
        source_url=@source_url, updated_at=@updated_at, origin_channel=@origin_channel, domain=@domain,
        canonical_path=@canonical_path, event_date=@event_date, user_explicit=@user_explicit,
        base_priority=@base_priority, promote_score=@promote_score, utility_score=@utility_score,
        retrieval_weight=@retrieval_weight, cluster_key=@cluster_key, archived_at=@archived_at,
        archived_reason=@archived_reason
      WHERE id=@id AND origin_device=@origin_device`);

    const claimDocs = await queryForeignDocs("claim", opts.localDeviceId, opts.sourceDeviceIds);
    for (const doc of claimDocs) {
      sum.claims_scanned++;
      try {
        const m = doc.metadata ?? {};
        const status = doc.status ?? m.status;
        if (!validForeignDevice(doc.device_id, opts.localDeviceId)) { sum.skipped_invalid++; continue; }
        if (!CLAIM_PULL_STATUSES.has(status)) { sum.skipped_invalid++; continue; }
        if (!CLAIM_TYPES.has(m.claim_type) || !CLAIM_STATUSES.has(status)) { sum.skipped_invalid++; continue; }
        if (!str(doc.content) || !str(doc.content_hash) || !str(m.target_file)) { sum.skipped_invalid++; continue; }

        const localId = localImportId(doc);
        const existing = claimById.get(localId) as any | undefined;
        const remoteFp = doc.sync_fingerprint ?? remoteFingerprintFromSummary(doc);
        if (existing) {
          if (claimFingerprint(existing) === remoteFp) { sum.skipped_unchanged++; continue; }
        }
        const row = {
          id: localId, content: doc.content, content_hash: doc.content_hash,
          target_file: m.target_file, section: str(m.section), claim_type: m.claim_type,
          confidence: num(m.confidence), status,
          session_id: str(m.session_id), source_url: str(m.source_url),
          created_at: str(doc.created_at) ?? new Date().toISOString(), // NOT NULL column
          updated_at: str(doc.updated_at) ?? str(doc.created_at),
          origin_channel: str(m.origin_channel), domain: str(m.domain), canonical_path: str(m.canonical_path),
          event_date: str(m.event_date), user_explicit: toInt(m.user_explicit),
          base_priority: num(m.base_priority, 1.0), promote_score: num(m.promote_score),
          utility_score: num(m.utility_score), retrieval_weight: num(m.retrieval_weight, 1.0),
          cluster_key: str(m.cluster_key), archived_at: str(doc.archived_at) ?? str(m.archived_at),
          archived_reason: str(m.archived_reason), origin_device: doc.device_id,
        };
        if (!dryRun) {
          if (existing) {
            // Guarded UPDATE: zero changes means an id collision with a row of a
            // different origin (e.g. a native NULL-origin row). Don't count as upsert.
            const info = claimUpdate.run(row);
            if (info.changes !== 1) { sum.skipped_origin_conflict++; continue; }
          } else {
            claimInsert.run(row);
          }
        }
        sum.claims_upserted++;
      } catch (e: any) {
        sum.errors++;
      }
    }

    // ---- Sessions ----
    const sessById = wdb.prepare("SELECT * FROM session_summaries WHERE id = ?");
    // Find a DIFFERENT row holding this content_hash (UNIQUE column) — guards both
    // insert and update against a UNIQUE collision throw.
    const sessByHashExcl = wdb.prepare("SELECT id FROM session_summaries WHERE content_hash = ? AND id != ?");
    const embDelete = wdb.prepare("DELETE FROM memory_embeddings WHERE file_path = ?");
    const sessInsert = wdb.prepare(`
      INSERT INTO session_summaries
        (id, agent, native_session_id, started_at, ended_at, model, project, title, message_count,
         summary, raw_excerpt, is_sub_agent, content_hash, created_at, status, archive_reason,
         archived_at, processed_for_promotion, searchable, origin_device)
      VALUES
        (@id, @agent, @native_session_id, @started_at, @ended_at, @model, @project, @title, @message_count,
         @summary, @raw_excerpt, @is_sub_agent, @content_hash, @created_at, @status, @archive_reason,
         @archived_at, @processed_for_promotion, @searchable, @origin_device)`);
    const sessUpdate = wdb.prepare(`
      UPDATE session_summaries SET
        agent=@agent, native_session_id=@native_session_id, started_at=@started_at, ended_at=@ended_at,
        model=@model, project=@project, title=@title, message_count=@message_count, summary=@summary,
        is_sub_agent=@is_sub_agent, content_hash=@content_hash, status=@status, archive_reason=@archive_reason,
        archived_at=@archived_at, searchable=@searchable
      WHERE id=@id AND origin_device=@origin_device`);
    const embUpsert = wdb.prepare(`
      INSERT OR REPLACE INTO memory_embeddings
        (file_path, chunk_index, embedding, dimensions, model, embed_version, content_hash, updated_at)
      VALUES (@file_path, 0, @embedding, 768, 'gemini-embedding-001', 1, @content_hash, @updated_at)`);

    const sessDocs = await queryForeignDocs("session_summary", opts.localDeviceId, opts.sourceDeviceIds);
    for (const doc of sessDocs) {
      sum.sessions_scanned++;
      try {
        const m = doc.metadata ?? {};
        const status = doc.status ?? m.status ?? "active";
        const searchable = toInt(doc.searchable ?? m.searchable, 1);
        if (!validForeignDevice(doc.device_id, opts.localDeviceId)) { sum.skipped_invalid++; continue; }
        if (status !== "active" || searchable !== 1) { sum.skipped_invalid++; continue; }
        if (!SESSION_AGENTS.has(m.agent) || !SESSION_STATUSES.has(status)) { sum.skipped_invalid++; continue; }
        if (!str(doc.content_hash)) { sum.skipped_invalid++; continue; }
        const summary = str(doc.content) ?? str(m.title) ?? "(empty session)";

        const localId = localImportId(doc);
        const existing = sessById.get(localId) as any | undefined;
        const remoteFp = doc.sync_fingerprint ?? remoteFingerprintFromSummary(doc);
        if (existing) {
          if (sessionFingerprint(existing) === remoteFp) { sum.skipped_unchanged++; continue; }
        }
        // content_hash is UNIQUE: if a DIFFERENT local row already holds it, both
        // insert and update would throw — skip (genuine cross-id duplicate).
        const dup = sessByHashExcl.get(doc.content_hash, localId) as { id: string } | undefined;
        if (dup) { sum.skipped_duplicate_hash++; continue; }

        const row = {
          id: localId, agent: m.agent, native_session_id: str(m.native_session_id),
          started_at: str(m.started_at), ended_at: str(m.ended_at), model: str(m.model),
          project: str(m.project), title: str(m.title), message_count: toInt(m.message_count),
          summary, raw_excerpt: null, is_sub_agent: toInt(m.is_sub_agent),
          content_hash: doc.content_hash, created_at: str(doc.created_at) ?? new Date().toISOString(),
          status, archive_reason: str(m.archive_reason), archived_at: str(doc.archived_at) ?? str(m.archived_at),
          processed_for_promotion: 1, // already promoted on its origin device — don't re-promote here
          searchable, origin_device: doc.device_id,
        };
        const blob = embeddingToBlob(doc.embedding);
        if (!dryRun) {
          if (existing) {
            const info = sessUpdate.run(row);
            if (info.changes !== 1) { sum.skipped_origin_conflict++; continue; }
          } else {
            sessInsert.run(row);
          }
          if (blob) {
            embUpsert.run({ file_path: `session:${localId}`, embedding: blob, content_hash: doc.content_hash, updated_at: Date.now() });
            sum.embeddings_written++;
          } else if (existing && existing.content_hash !== doc.content_hash) {
            // Content changed but no valid remote embedding — drop the now-stale
            // vector so the background embedding job regenerates it. Only when the
            // content_hash actually drifted; a metadata-only update keeps its vector.
            embDelete.run(`session:${localId}`);
          }
        } else if (blob) {
          sum.embeddings_written++;
        }
        sum.sessions_upserted++;
      } catch (e: any) {
        sum.errors++;
      }
    }

    // ---- Transcripts ----
    // Conflict-free union: transcripts are immutable, so a foreign doc is either
    // already present locally (by content_hash PK) or new. INSERT OR IGNORE keyed
    // on the existing content_hash PK never overwrites a local row and never throws
    // on collision. No fingerprint compare, no embeddings, no lifecycle — distinct
    // from the session_summary path above (kept separate on purpose).
    const transcriptInsert = wdb.prepare(`
      INSERT OR IGNORE INTO session_transcripts
        (content_hash, agent, session_id, messages_json, native_file_path,
         source_mtime_ms, model, project, started_at, ended_at,
         message_count, uncompressed_size, transcript_hash, origin_device)
      VALUES
        (@content_hash, @agent, @session_id, @messages_json, NULL,
         NULL, @model, @project, @started_at, @ended_at,
         @message_count, @uncompressed_size, @transcript_hash, @origin_device)`);
    // content_hash PK already present locally => INSERT OR IGNORE is a no-op. Check up
    // front so dry-run accounting matches the real run (count it as a duplicate skip,
    // not a phantom upsert).
    const transcriptExists = wdb.prepare("SELECT 1 FROM session_transcripts WHERE content_hash = ?");

    const transcriptDocs = await queryForeignDocs("session_transcript", opts.localDeviceId, opts.sourceDeviceIds);
    for (const doc of transcriptDocs) {
      sum.transcripts_scanned++;
      try {
        if (!validForeignDevice(doc.device_id, opts.localDeviceId)) { sum.skipped_invalid++; continue; }
        if (!str(doc.content_hash) || !str(doc.transcript_hash) || !str(doc.messages_json) || !SESSION_AGENTS.has(doc.agent)) {
          sum.skipped_invalid++; continue;
        }
        // Defence-in-depth: a doc that exceeds the size guard should never have been
        // pushed, but if one slipped through, don't let it bloat the local DB.
        if (Buffer.byteLength(doc.messages_json, "utf-8") > MAX_DOC_BYTES) { sum.transcripts_skipped++; continue; }
        if (transcriptExists.get(doc.content_hash)) { sum.skipped_duplicate_hash++; continue; }

        const row = {
          content_hash: doc.content_hash,
          agent: doc.agent,
          session_id: str(doc.native_session_id) ?? doc.content_hash,
          messages_json: doc.messages_json,
          model: str(doc.model),
          project: str(doc.project),
          started_at: str(doc.started_at),
          ended_at: str(doc.ended_at),
          message_count: toInt(doc.message_count),
          uncompressed_size: toInt(doc.uncompressed_size, Buffer.byteLength(doc.messages_json, "utf-8")),
          transcript_hash: doc.transcript_hash,
          origin_device: doc.device_id,
        };
        if (!dryRun) {
          const info = transcriptInsert.run(row);
          if (info.changes !== 1) { sum.skipped_duplicate_hash++; continue; }
        }
        sum.transcripts_upserted++;
      } catch (e: any) {
        sum.errors++;
      }
    }
  } finally {
    wdb.close();
  }

  const finishedAt = new Date();
  return {
    localDeviceId: opts.localDeviceId,
    sourceDeviceIds: opts.sourceDeviceIds ?? "all-foreign",
    dryRun,
    ...sum,
    cosmos_429s: metrics.cosmos_429s,
    elapsed_ms: finishedAt.getTime() - startedAt.getTime(),
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
  };
}

// --- CLI ---
function parseArgs(argv: string[]): SyncOptions & { sourceDeviceIds?: DeviceId[] } {
  const opts: Partial<SyncOptions> & { json?: boolean; sourceDeviceIds?: DeviceId[] } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") { opts.mode = argv[++i] as SyncMode; }
    else if (a === "--device-id") { opts.deviceId = argv[++i] as DeviceId; }
    else if (a === "--source-device") { opts.sourceDeviceIds = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean) as DeviceId[]; }
    else if (a === "--dry-run") { opts.dryRun = true; }
    else if (a === "--json") { opts.json = true; }
    else if (a === "--help" || a === "-h") {
      console.log("Usage: sync-to-cosmos --mode migrate|reconcile|push|pull --device-id <id> [--source-device a,b] [--dry-run] [--json]");
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  if (!opts.mode) throw new Error("--mode required");
  if (!opts.deviceId) throw new Error("--device-id required");
  if (!["migrate", "reconcile", "push", "pull"].includes(opts.mode)) throw new Error(`Invalid mode: ${opts.mode}`);
  return opts as SyncOptions & { sourceDeviceIds?: DeviceId[] };
}

async function cliMain(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.mode === "pull") {
    const summary = await runCosmosPull({
      localDeviceId: opts.deviceId,
      sourceDeviceIds: opts.sourceDeviceIds,
      dryRun: opts.dryRun,
    });
    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`=== Cosmos pull (device=${opts.deviceId}${opts.dryRun ? ", DRY-RUN" : ""}) ===`);
      console.log(`  claims:    ${summary.claims_upserted}/${summary.claims_scanned} upserted`);
      console.log(`  sessions:  ${summary.sessions_upserted}/${summary.sessions_scanned} upserted`);
      console.log(`  transcripts: ${summary.transcripts_upserted}/${summary.transcripts_scanned} upserted (skipped ${summary.transcripts_skipped})`);
      console.log(`  embeddings: ${summary.embeddings_written} written`);
      console.log(`  skipped:   unchanged=${summary.skipped_unchanged}, invalid=${summary.skipped_invalid}, hashDup=${summary.skipped_duplicate_hash}, originConflict=${summary.skipped_origin_conflict}, errors=${summary.errors}`);
      console.log(`  retries:   cosmos_429=${summary.cosmos_429s}`);
      console.log(`  elapsed:   ${summary.elapsed_ms} ms`);
    }
    return;
  }

  const summary = await runCosmosSync(opts);
  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`=== Cosmos sync (${opts.mode}, device=${opts.deviceId}${opts.dryRun ? ", DRY-RUN" : ""}) ===`);
    console.log(`  claims:    ${summary.claims_synced}/${summary.claims_scanned} synced`);
    console.log(`  entries:   ${summary.entries_synced}/${summary.entries_scanned} synced`);
    console.log(`  sessions:  ${summary.sessions_synced}/${summary.sessions_scanned} synced`);
    console.log(`  transcripts: ${summary.transcripts_synced}/${summary.transcripts_scanned} synced (too-large ${summary.transcripts_skipped_too_large})`);
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
