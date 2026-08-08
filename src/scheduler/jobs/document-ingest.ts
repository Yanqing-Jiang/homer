/**
 * Document ingestion worker.
 *
 * Two halves, both idempotent:
 *   1. WALK   — find files in the upload landing that have no `documents` row
 *               yet (uploads written before this pipeline existed, Telegram
 *               uploads, anything the web enqueue missed) and enqueue them.
 *   2. DRAIN  — extract text for status='pending' rows and mark ready/error.
 *
 * This replaces the .eml/.msg-only `ingestUploadEmails` helper: email is now
 * one branch of a generic extractor writing to `documents` like every other
 * type. Historical `upload-email` rows in `scrapes` are left exactly as they
 * are — this worker never reads or writes that table.
 *
 * DEBT: that leaves 48 emails represented TWICE — once as an `upload-email`
 * scrape (demoted, head-capped, never embedded) and once as a first-party
 * document. Both copies can therefore surface for the same query, and the
 * document copy outranks the scrape copy by design. Retiring the scrape rows
 * was deliberately out of scope here because they are the only record with a
 * `processed_at`/idea-pipeline history. Upgrade when a search visibly returns
 * the same email twice in one result head, or when Phase 3 touches scrape
 * retention anyway — then delete the 48 rows whose
 * 'doc_' || sha256 already exists in `documents`.
 *
 * NEVER moves, renames or deletes a source file. The landing path is live: the
 * web UI resolves chat attachments, previews and downloads straight off it
 * (homer-web src/web/api/uploads.ts, src/utils/attachments.ts). Cold storage is
 * a later phase with its own path-fallback work.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, extname, join, relative, sep } from "path";
import { config } from "../../config/index.js";
import {
  extractDocument,
  MAX_SOURCE_BYTES,
  SUPPORTED_EXTENSIONS,
  TerminalExtractionError,
} from "../../memory/document-extract.js";
import {
  claimPendingDocuments,
  documentIdForBytes,
  enqueueDocument,
  markDocumentFailed,
  markDocumentReady,
  parseDocumentMetadata,
} from "../../memory/document-store.js";
import type { StateManager } from "../../state/manager.js";
import { logger } from "../../utils/logger.js";

/**
 * Manual-unzip leftovers from a one-off 2026 investigation: ~40 files that are
 * already represented by their parent .docx uploads. Indexing them would double
 * every hit from those documents.
 */
const SKIP_DIRECTORIES = new Set(["docx_extract"]);
/** Landing subtrees that hold real uploads. */
const LANDING_SUBDIRS = ["web", "tg"];
/** Files per drain pass. Bounds one run well inside the job timeout. */
export const DRAIN_BATCH = 40;

export interface DocumentIngestCounters {
  walked: number;
  enqueued: number;
  aliased: number;
  skipped: number;
  drained: number;
  ready: number;
  failed: number;
  retrying: number;
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) return [];
      return walkFiles(join(dir, entry.name));
    }
    return entry.isFile() ? [join(dir, entry.name)] : [];
  });
}

/**
 * Every landing path already represented by a row — hot_path plus each alias
 * path. Without the alias half, a file whose bytes duplicate an earlier upload
 * would be re-read and re-hashed on every single pass.
 */
function knownLandingPaths(db: StateManager["db"]): Set<string> {
  const known = new Set<string>();
  const rows = db.prepare("SELECT hot_path, metadata FROM documents").all() as Array<{
    hot_path: string;
    metadata: string;
  }>;
  for (const row of rows) {
    known.add(row.hot_path);
    for (const alias of parseDocumentMetadata(row.metadata).aliases ?? []) {
      if (alias.path) known.add(alias.path);
    }
  }
  return known;
}

/** Enqueue landing files that have no `documents` row yet. */
function walkLanding(db: StateManager["db"], counters: DocumentIngestCounters): void {
  const root = config.paths.uploadLanding;
  const known = knownLandingPaths(db);

  for (const subdir of LANDING_SUBDIRS) {
    const base = join(root, subdir);
    for (const file of walkFiles(base)) {
      counters.walked++;
      if (known.has(file)) continue;
      if (basename(file).startsWith(".")) { counters.skipped++; continue; }

      try {
        const stat = statSync(file);
        if (stat.size === 0 || stat.size > MAX_SOURCE_BYTES) {
          counters.skipped++;
          logger.warn({ file, size: stat.size }, "Skipping landing file outside size bounds");
          continue;
        }
        const relPath = relative(base, file).split(sep).join("/");
        const outcome = enqueueDocument(db, {
          id: documentIdForBytes(readFileSync(file)),
          filename: basename(file),
          hotPath: file,
          mimeType: null,
          sizeBytes: stat.size,
          alias: {
            sessionId: relPath.includes("/") ? relPath.split("/")[0] : undefined,
            filename: basename(file),
            uploadedAt: stat.mtime.toISOString(),
            path: file,
          },
        });
        if (outcome === "inserted") counters.enqueued++;
        else if (outcome === "alias-added") counters.aliased++;
        else counters.skipped++;
      } catch (error) {
        counters.skipped++;
        logger.warn({ file, error }, "Failed to enqueue landing file");
      }
    }
  }
}

/** Extract text for pending rows. */
async function drainPending(
  db: StateManager["db"],
  counters: DocumentIngestCounters,
  limit: number,
): Promise<Map<string, number>> {
  const errorReasons = new Map<string, number>();
  for (const doc of claimPendingDocuments(db, limit)) {
    counters.drained++;
    const ext = extname(doc.filename).toLowerCase();
    try {
      if (!SUPPORTED_EXTENSIONS.has(ext)) {
        throw new TerminalExtractionError(`unsupported file type: ${ext || "(no extension)"}`);
      }
      const result = await extractDocument(doc.hot_path);
      markDocumentReady(db, doc.id, result);
      counters.ready++;
    } catch (error) {
      const terminal = error instanceof TerminalExtractionError;
      const message = error instanceof Error ? error.message : String(error);
      const outcome = markDocumentFailed(db, doc.id, message, terminal);
      if (outcome.status === "error") counters.failed++;
      else counters.retrying++;
      const reason = `${ext || "(none)"}: ${message.split("\n")[0]?.slice(0, 120) ?? message}`;
      errorReasons.set(reason, (errorReasons.get(reason) ?? 0) + 1);
      logger.warn({ id: doc.id, file: doc.hot_path, terminal, error: message }, "Document extraction failed");
    }
  }
  return errorReasons;
}

export type DocumentIngestResult = DocumentIngestCounters & { errorReasons: Array<[string, number]> };

/**
 * Serializes the two drain entry points. `claimPendingDocuments` is a plain
 * SELECT of status='pending' — no lease, no 'processing' state — and extraction
 * awaits child processes, so the 15-minute job and link-processor's inline
 * catch-up (both fire at 23:00) would otherwise interleave over the same rows:
 * two workers spending two of the three retry attempts in one cycle, or a late
 * failure stamping 'error' over text another worker already extracted.
 *
 * DEBT: single-process guard — both callers live in the daemon process, so a
 * module-level promise is sufficient and honest. Upgrade to a DB-level lease
 * (claimed_at + owner, stale-lease recovery) the moment a second process drains
 * — homer-web, a CLI backfill, or a second daemon instance.
 */
let inFlightIngest: Promise<DocumentIngestResult> | null = null;

export async function runDocumentIngest(
  db: StateManager["db"],
  options: { limit?: number } = {},
): Promise<DocumentIngestResult> {
  if (inFlightIngest) {
    logger.info("Document ingest already running — joining the in-flight run instead of double-draining");
    return inFlightIngest;
  }
  inFlightIngest = (async (): Promise<DocumentIngestResult> => {
    const counters: DocumentIngestCounters = {
      walked: 0, enqueued: 0, aliased: 0, skipped: 0,
      drained: 0, ready: 0, failed: 0, retrying: 0,
    };
    walkLanding(db, counters);
    const errorReasons = await drainPending(db, counters, options.limit ?? DRAIN_BATCH);
    logger.info(counters, "Document ingest complete");
    return { ...counters, errorReasons: [...errorReasons.entries()].sort((a, b) => b[1] - a[1]) };
  })();
  try {
    return await inFlightIngest;
  } finally {
    inFlightIngest = null;
  }
}

export function summarizeDocumentIngest(
  result: DocumentIngestCounters & { errorReasons: Array<[string, number]> },
): string {
  const parts = [
    `documents: ${result.ready} ready, ${result.failed} error, ${result.retrying} retrying`,
    `${result.enqueued} enqueued`,
  ];
  if (result.aliased > 0) parts.push(`${result.aliased} aliased`);
  if (result.errorReasons.length > 0) {
    parts.push(`top error: ${result.errorReasons[0]![0]} (x${result.errorReasons[0]![1]})`);
  }
  return parts.join(", ");
}

/**
 * Scheduler entry point. Drains a larger batch than the inline link-processor
 * call because it owns the whole run.
 */
export async function runDocumentIngestJob(
  stateManager: StateManager,
): Promise<{ success: boolean; output: string; error?: string }> {
  try {
    const result = await runDocumentIngest(stateManager.db, { limit: DRAIN_BATCH });
    const pending = (stateManager.db
      .prepare("SELECT COUNT(*) AS n FROM documents WHERE status = 'pending'")
      .get() as { n: number }).n;
    const backlog = pending > 0 ? `; ${pending} still pending` : "";
    return { success: true, output: `${summarizeDocumentIngest(result)}${backlog}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, output: "", error: message };
  }
}
