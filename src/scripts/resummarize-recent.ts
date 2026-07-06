/**
 * Reparse and resummarize recent CLI sessions in place.
 *
 * Run:
 *   npx tsx src/scripts/resummarize-recent.ts [--days 30] [--dry-run]
 *
 * This updates session_summaries only. FTS is maintained by the
 * session_summaries_au trigger; if the trigger is missing, this script rebuilds
 * session_summaries_fts after updates.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { fileURLToPath } from "url";
import {
  parseClaudeSession,
  parseCodexSession,
  parseOpencodeSession,
  type ParsedSession,
} from "../cli-sessions/parsers.js";
import { buildRawExcerpt, generateTitle, summarizeSession } from "../cli-sessions/summarizer.js";
import { memoryEvents } from "../events/memory-events.js";
import { StateManager } from "../state/manager.js";

const DB_PATH = `${homedir()}/homer/data/homer.db`;

type ReparseAgent = "claude" | "codex" | "opencode";

interface SessionRow {
  id: string;
  agent: ReparseAgent;
  native_session_id: string | null;
  started_at: string | null;
  content_hash: string | null;
  model: string | null;
  native_file_path: string | null;
}

interface ResummarizeOptions {
  dbPath?: string;
  days: number;
  dryRun: boolean;
  signal?: AbortSignal;
}

interface ResummarizeStats {
  scanned: number;
  updated: number;
  skipped: number;
  errors: number;
}

export async function resummarizeRecent(options: ResummarizeOptions): Promise<ResummarizeStats> {
  const sm = new StateManager(options.dbPath ?? DB_PATH);
  const db = sm.getDb();
  const stats: ResummarizeStats = { scanned: 0, updated: 0, skipped: 0, errors: 0 };

  try {
    const cutoff = new Date(Date.now() - options.days * 24 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare(`
      SELECT
        ss.id,
        ss.agent,
        ss.native_session_id,
        ss.started_at,
        ss.content_hash,
        ss.model,
        ci.native_file_path
      FROM session_summaries ss
      LEFT JOIN cli_session_index ci ON ci.content_hash = ss.content_hash
      WHERE ss.agent IN ('claude', 'codex', 'opencode')
        AND ss.started_at IS NOT NULL
        AND datetime(ss.started_at) >= datetime(?)
      ORDER BY ss.started_at ASC
    `).all(cutoff) as SessionRow[];

    stats.scanned = rows.length;

    const update = db.prepare(`
      UPDATE session_summaries
      SET summary = ?,
          title = ?,
          raw_excerpt = ?,
          model = ?
      WHERE id = ?
    `);

    for (const row of rows) {
      if (options.signal?.aborted) break;

      if (!row.native_file_path || !existsSync(row.native_file_path)) {
        stats.skipped++;
        continue;
      }

      try {
        const session = reparse(row.agent, row.native_file_path);
        if (!session) {
          stats.skipped++;
          continue;
        }

        const title = generateTitle(session);
        const rawExcerpt = buildRawExcerpt(session);
        const summary = await summarizeSession(session, options.signal);
        const model = session.model || row.model;

        if (!options.dryRun) {
          update.run(summary, title, rawExcerpt, model, row.id);
        }
        stats.updated++;
      } catch (error) {
        stats.errors++;
        console.warn(`Failed to resummarize ${row.agent}:${row.native_session_id ?? row.id}: ${String(error)}`);
      }
    }

    if (!options.dryRun && stats.updated > 0) {
      ensureFtsSynced(db);
      sm.markPipelineDirty("reindex", "resummarize_recent");
      sm.markPipelineDirty("embeddings", "resummarize_recent");
      memoryEvents.emitDirty("reindex", "resummarize_recent");
      memoryEvents.emitDirty("embeddings", "resummarize_recent");
    }

    return stats;
  } finally {
    sm.close();
  }
}

function reparse(agent: ReparseAgent, filePath: string): ParsedSession | null {
  if (agent === "claude") {
    return parseClaudeSession(filePath, { archiveFidelity: true });
  }
  if (agent === "codex") {
    return parseCodexSession(filePath);
  }
  return parseOpencodeSession(filePath);
}

function ensureFtsSynced(db: ReturnType<StateManager["getDb"]>): void {
  const hasFts = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_summaries_fts'"
  ).get();
  if (!hasFts) return;

  const hasUpdateTrigger = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'session_summaries_au'"
  ).get();
  if (hasUpdateTrigger) return;

  db.prepare("INSERT INTO session_summaries_fts(session_summaries_fts) VALUES('rebuild')").run();
}

function parseArgs(argv: string[]): ResummarizeOptions {
  let days = 30;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--days") {
      const value = argv[i + 1];
      if (!value) throw new Error("--days requires a value");
      days = Number.parseInt(value, 10);
      i++;
    } else if (arg?.startsWith("--days=")) {
      days = Number.parseInt(arg.slice("--days=".length), 10);
    }
  }

  if (!Number.isFinite(days) || days <= 0) {
    throw new Error("--days must be a positive integer");
  }

  return { days, dryRun };
}

const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  const stats = await resummarizeRecent(options);
  console.log(
    `resummarize-recent${options.dryRun ? " (dry-run)" : ""}: ` +
    `${stats.updated}/${stats.scanned} updated, ${stats.skipped} skipped, ${stats.errors} errors`
  );
}
