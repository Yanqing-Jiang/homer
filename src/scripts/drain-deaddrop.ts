/**
 * Work-laptop session dead-drop drain.
 *
 * The work laptop (OpenCode `/mem-push`) uploads plaintext OpenCode **session**
 * docs to the PRIVATE `homer-data` blob container under `worklaptop/sessions/`
 * via a short-lived, write-only SAS — it never holds Cosmos creds or a
 * long-lived storage key. This drainer, run as the nightly
 * `deaddrop_drain` job, inserts each session into local `session_summaries` (tagged
 * origin_device='work-laptop'), marks the embeddings pipeline dirty so the
 * background job vectorizes them, then deletes each blob once fully processed.
 *
 * This REPLACES the former two transports (retired 2026-06-16):
 *   - the curated-claims dead-drop (homer-dead-drop container), and
 *   - the Cosmos-based session transport (laptop cosmos-push → Cosmos → nightly
 *     pull). The laptop now reaches homer.db directly via blob, so Cosmos is no
 *     longer in the laptop session path.
 *
 * Doc shape mirrors sync-to-cosmos `buildSessionDoc` exactly (the laptop emits
 * the same shape minus the `embedding` field, which we backfill via the
 * background memory_embeddings job). The insert mirrors runCosmosPull's
 * session-import mapping so a blob-drained row is byte-identical to a Cosmos-
 * pulled one.
 *
 * Idempotent: `session_summaries.content_hash` is UNIQUE and we dedup on both id
 * and content_hash, so a re-drain of a clean batch is a no-op. A blob that fails
 * mid-parse, or whose batch has any structurally-invalid item, is left in place
 * (no silent data loss). A batch whose only "misses" are policy-filtered
 * (archived/non-searchable new imports) is still deleted — those were handled.
 */

import { BlobServiceClient } from "@azure/storage-blob";
import { logger } from "../utils/logger.js";
import { memoryEvents } from "../events/memory-events.js";
import type { StateManager } from "../state/manager.js";

// Laptop sessions land in the same private container the /mem-pull download
// endpoint reads (homer-data); the SAS is single-blob write-only, and we delete
// each blob after draining. Override via AZURE_STORAGE_CONTAINER to match the
// homer-web blobs.ts containerName.
const CONTAINER = process.env.AZURE_STORAGE_CONTAINER ?? "homer-data";
const SESSIONS_PREFIX = "worklaptop/sessions/";
// Provenance is asserted by the path, not the payload: anything under
// worklaptop/sessions/ is, by construction, from the work laptop.
const ORIGIN_DEVICE = "work-laptop";
// Full session transcripts are much larger than the old claim batches.
const MAX_BLOB_BYTES = 8_000_000; // 8 MB
const MAX_ITEMS = 1000;
const SESSION_STATUSES = new Set(["active", "archived"]);

export interface DeadDropDrainStats {
  blobs: number;            // .json batch blobs seen
  parsed: number;           // blobs successfully parsed
  sessionsUpserted: number; // session_summaries rows inserted or updated
  duplicates: number;       // already present & unchanged (id or content_hash)
  filtered: number;         // policy-skipped (new import not active+searchable)
  invalid: number;          // items dropped (missing/invalid required fields)
  errors: number;           // blob-level processing errors
  deleted: number;          // blobs deleted after success
}

interface SessionItem {
  id?: string;
  source_type?: string;
  content?: string;
  content_hash?: string;
  metadata?: Record<string, any>;
  created_at?: string;
  archived_at?: string;
  status?: string;
  searchable?: number | boolean;
  device_id?: string;
}
interface DeadDropPayload {
  schema?: string;
  op_id?: string;
  client_id?: string;
  device_id?: string;
  kind?: string;
  items?: SessionItem[];
}

// ── coercion helpers (mirror sync-to-cosmos) ──────────────────────────────────
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function toInt(v: unknown, dflt = 0): number {
  if (v === true) return 1;
  if (v === false) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}
// Sentinel: a 0-row UPDATE inside the write transaction (concurrent origin change)
// rolls back the whole row AND is classified as a conflict, not a generic error.
class OriginConflict extends Error {}
// Canonical executor identity (mirror pulledSessionAgent): v2 docs carry the
// real provider under metadata.provider; older docs only have metadata.agent.
function sessionAgent(item: SessionItem): string | null {
  const m = item.metadata ?? {};
  return str(m.provider) ?? str(m.agent) ?? str((item as any).agent);
}
// Mirror localImportId, but FAIL CLOSED on namespace: provenance here is asserted
// from the blob path (work-laptop), so a colon-prefixed payload id is honored
// only inside this device's own session namespace. Accepting an arbitrary
// prefixed id (e.g. `home-mac:session:x`) would let a laptop payload squat a
// foreign primary key and later block a legitimate Cosmos pull of that id
// (Codex MAJOR #2). A bare id is normalized to work-laptop:session:<raw>.
function localId(item: SessionItem): string | null {
  const id = str(item.id);
  if (!id) return null;
  if (id.includes(":")) {
    return id.startsWith(`${ORIGIN_DEVICE}:session:`) ? id : null;
  }
  const raw = id.replace(/^session_/, "");
  return `${ORIGIN_DEVICE}:session:${raw}`;
}

export async function runDeadDropDrain(sm: StateManager): Promise<DeadDropDrainStats> {
  const stats: DeadDropDrainStats = {
    blobs: 0, parsed: 0, sessionsUpserted: 0, duplicates: 0,
    filtered: 0, invalid: 0, errors: 0, deleted: 0,
  };

  const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connStr) {
    logger.warn("AZURE_STORAGE_CONNECTION_STRING not set — session dead-drop drain skipped");
    return stats;
  }

  const db = sm.getDb();
  const container = BlobServiceClient.fromConnectionString(connStr).getContainerClient(CONTAINER);

  const sessById = db.prepare("SELECT id, origin_device, content_hash FROM session_summaries WHERE id = ?");
  // A DIFFERENT row holding this content_hash (UNIQUE column) would make both
  // insert and update throw — detect and skip it as a duplicate.
  const sessByHashExcl = db.prepare("SELECT id FROM session_summaries WHERE content_hash = ? AND id != ?");
  // A content-changing update must drop the now-stale vector so the background
  // embedding job regenerates it — the embedding job only fills MISSING rows, it
  // does not detect a content_hash drift (Codex MAJOR #1).
  const embDelete = db.prepare("DELETE FROM memory_embeddings WHERE file_path = ?");
  const sessInsert = db.prepare(`
    INSERT INTO session_summaries
      (id, agent, native_session_id, started_at, ended_at, model, project, title, message_count,
       summary, raw_excerpt, is_sub_agent, content_hash, created_at, status, archive_reason,
       archived_at, processed_for_promotion, searchable, origin_device)
    VALUES
      (@id, @agent, @native_session_id, @started_at, @ended_at, @model, @project, @title, @message_count,
       @summary, @raw_excerpt, @is_sub_agent, @content_hash, @created_at, @status, @archive_reason,
       @archived_at, @processed_for_promotion, @searchable, @origin_device)`);
  // Only same-origin (work-laptop) rows are ever updated, so a remote edit to a
  // session can't overwrite a locally-authored one (belt-and-suspenders WHERE).
  const sessUpdate = db.prepare(`
    UPDATE session_summaries SET
      agent=@agent, native_session_id=@native_session_id, started_at=@started_at, ended_at=@ended_at,
      model=@model, project=@project, title=@title, message_count=@message_count, summary=@summary,
      is_sub_agent=@is_sub_agent, content_hash=@content_hash, status=@status, archive_reason=@archive_reason,
      archived_at=@archived_at, searchable=@searchable
    WHERE id=@id AND origin_device=@origin_device`);

  for await (const blob of container.listBlobsFlat({ prefix: SESSIONS_PREFIX })) {
    if (!blob.name.endsWith(".json")) continue;          // skip dir markers
    const size = blob.properties.contentLength ?? 0;
    if (size === 0) continue;                             // skip empty placeholders
    stats.blobs++;

    if (size > MAX_BLOB_BYTES) {
      stats.errors++;
      logger.warn({ blob: blob.name, size }, "session dead-drop blob exceeds size cap — left in place");
      continue;
    }

    const blobClient = container.getBlockBlobClient(blob.name);
    try {
      const buf = await blobClient.downloadToBuffer();
      const payload = JSON.parse(buf.toString("utf-8")) as DeadDropPayload;

      // Kind guard (Codex MAJOR #3): a blob under worklaptop/sessions/ whose
      // payload declares a non-sessions kind is a producer bug — leave it, don't
      // coerce it into session_summaries and delete it.
      if (payload.kind && payload.kind !== "sessions") {
        stats.errors++;
        logger.warn({ blob: blob.name, kind: payload.kind }, "session dead-drop blob has non-sessions kind — left in place");
        continue;
      }

      // Schema guard: a valid-JSON-but-wrong-shape blob must NOT be treated as a
      // drained empty batch and deleted. Leave it for inspection.
      if (!Array.isArray(payload.items)) {
        stats.errors++;
        logger.warn({ blob: blob.name }, "session dead-drop blob has no items[] array — left in place");
        continue;
      }
      const items = payload.items;
      if (items.length > MAX_ITEMS) {
        stats.errors++;
        logger.warn({ blob: blob.name, count: items.length }, "session dead-drop batch exceeds item cap — left in place");
        continue;
      }
      stats.parsed++;

      let hadInvalid = false;
      for (const it of items) {
        const id = localId(it);
        const agent = sessionAgent(it);
        const contentHash = str(it.content_hash);
        const status = str(it.status) ?? str(it.metadata?.status) ?? "active";

        // Structural identity — missing required fields or a wrong source_type are
        // producer bugs; leave the blob so a bad pusher never silently drops a
        // session or coerces a wrong-type doc into session_summaries (Codex #3).
        // buildSessionDoc always sets source_type='session_summary'.
        if (!id || !agent || !contentHash || !SESSION_STATUSES.has(status) ||
            it.source_type !== "session_summary") {
          stats.invalid++;
          hadInvalid = true;
          continue;
        }

        const m = it.metadata ?? {};
        const searchable = toInt(it.searchable ?? m.searchable, 1);
        const existing = sessById.get(id) as
          | { id: string; origin_device: string | null; content_hash: string | null }
          | undefined;

        // A new import must be active+searchable (mirror runCosmosPull). This is
        // an expected policy exclusion, NOT a producer bug — so it does NOT block
        // blob deletion (the item was handled, just not stored).
        if (!existing && (status !== "active" || searchable !== 1)) {
          stats.filtered++;
          continue;
        }
        // Never overwrite a non-work-laptop row that happens to share this id.
        if (existing && existing.origin_device !== ORIGIN_DEVICE) {
          stats.invalid++;
          hadInvalid = true;
          continue;
        }
        // Unchanged content → nothing to do.
        if (existing && existing.content_hash === contentHash) {
          stats.duplicates++;
          continue;
        }
        // content_hash is UNIQUE: a DIFFERENT local row already holding it would
        // make the write throw. Skip (genuine cross-id duplicate, not a drop).
        if (sessByHashExcl.get(contentHash, id)) {
          stats.duplicates++;
          continue;
        }

        const row = {
          id,
          agent,
          native_session_id: str(m.native_session_id),
          started_at: str(m.started_at),
          ended_at: str(m.ended_at),
          model: str(m.model),
          project: str(m.project),
          title: str(m.title),
          message_count: toInt(m.message_count),
          summary: str(it.content) ?? str(m.title) ?? "(empty session)",
          raw_excerpt: null as string | null,
          is_sub_agent: toInt(m.is_sub_agent),
          content_hash: contentHash,
          created_at: str(it.created_at) ?? new Date().toISOString(), // NOT NULL column
          status,
          archive_reason: str(m.archive_reason),
          archived_at: str(it.archived_at) ?? str(m.archived_at),
          // Promotion policy: mirror the Cosmos pull — sessions are NOT auto-mined
          // into knowledge_claims on ingest (avoids flooding /review with raw
          // laptop session text). Flip to 0 to let the promotion job mine them.
          processed_for_promotion: 1,
          searchable,
          origin_device: ORIGIN_DEVICE,
        };

        if (existing) {
          // We only reach the update branch when content_hash differs (unchanged
          // rows skipped above), so the stale vector ALWAYS goes. Row update +
          // embedding delete are one transaction: a half-applied row (summary
          // updated, stale vector kept) would read as "unchanged" next run and
          // never self-repair.
          const writeRow = db.transaction(() => {
            const info = sessUpdate.run(row);
            if (info.changes !== 1) throw new OriginConflict();
            embDelete.run(`session:${id}`);
          });
          try {
            writeRow();
          } catch (e) {
            if (e instanceof OriginConflict) { stats.invalid++; hadInvalid = true; continue; }
            throw e;
          }
        } else {
          sessInsert.run(row);
        }
        stats.sessionsUpserted++;
      }

      // Delete ONLY a batch with no structural problems. A policy-filtered item is
      // fine to delete; a missing/invalid item leaves the blob so a producer bug
      // never silently drops a session. The drain is idempotent, so re-draining a
      // clean batch is safe.
      if (!hadInvalid) {
        await blobClient.delete();
        stats.deleted++;
      } else {
        logger.warn({ blob: blob.name }, "session dead-drop batch had invalid items — left in place (no silent drop)");
      }
    } catch (err) {
      stats.errors++;
      logger.warn({ err, blob: blob.name }, "session dead-drop blob processing failed — left in place for retry");
    }
  }

  // New/changed sessions need vectors: mark the embeddings pipeline dirty (durable
  // flag + in-process event) so the background memory_embeddings job backfills
  // them — the laptop ships no embedding, by design (no Gemini key on the laptop).
  if (stats.sessionsUpserted > 0) {
    sm.markPipelineDirty("embeddings", "deaddrop_drain");
    memoryEvents.emitDirty("embeddings", "deaddrop_drain");
  }

  if (stats.blobs > 0) {
    logger.info({ ...stats }, "Session dead-drop drain complete");
  }
  return stats;
}
