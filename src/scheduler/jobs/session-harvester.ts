/**
 * Session Harvester — batch import all CLI sessions into session_summaries
 *
 * Runs twice daily at 12:00 PM and 12:00 AM. Scans all CLIs (Claude, Codex,
 * Gemini, Kimi, OpenCode), parses conversations, filters sub-agents, summarizes
 * (Gemini Flash), and INSERTs directly into session_summaries SQLite table with
 * FTS5 indexing.
 *
 * Sessions are immediately searchable via memory_search after this job completes.
 * Sets dirty flags for reindex/embeddings pipelines.
 */

import { homedir } from "os";
import { createHash } from "crypto";
import { CLISessionImporter } from "../../cli-sessions/importer.js";
import { StateManager } from "../../state/manager.js";
import { logger } from "../../utils/logger.js";
import { memoryEvents } from "../../events/memory-events.js";

const DB_PATH = `${homedir()}/homer/data/homer.db`;
const CLI_AGENTS = ["codex", "claude", "opencode"] as const;
const MAX_BACKFILL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days cap for first run

export async function runSessionHarvester(
  stateManager?: StateManager,
  signal?: AbortSignal
): Promise<{ success: boolean; output: string; error?: string }> {
  const sm = stateManager ?? new StateManager(DB_PATH);
  const ownSm = !stateManager;
  const database = sm.getDb();

  try {
    const importer = new CLISessionImporter(database, homedir());

    // Load per-agent watermarks
    const cutoffPerAgent: Record<string, number> = {};
    for (const agent of CLI_AGENTS) {
      const watermark = sm.getHarvestWatermark(agent);
      if (watermark !== null) {
        cutoffPerAgent[agent] = watermark;
      } else {
        // First run: cap at 30 days backfill
        cutoffPerAgent[agent] = Date.now() - MAX_BACKFILL_MS;
      }
    }

    logger.info({ cutoffPerAgent }, "Loaded harvest watermarks");

    const stats = await importer.import({
      sinceDays: 1, // fallback for thread sessions (no cutoffPerAgent support)
      agent: "all",
      dryRun: false,
      cutoffPerAgent,
      signal,
    });

    // Update watermarks only if no errors — avoids permanently skipping errored sessions
    if (stats.errors === 0) {
      const now = Date.now();
      for (const agent of CLI_AGENTS) {
        sm.setHarvestWatermark(agent, now);
      }
    } else {
      logger.warn({ errors: stats.errors }, "Skipping watermark update — errors occurred, sessions will be retried");
    }

    if (stats.imported > 0) {
      sm.markPipelineDirty("reindex", "session_harvester");
      sm.markPipelineDirty("embeddings", "session_harvester");
      // Emit events for debounced reactive triggers
      memoryEvents.emitDirty("reindex", "session_harvester");
      memoryEvents.emitDirty("embeddings", "session_harvester");
    }

    // Gap B fix: emit a digest of done-with-comment todos so they land in
    // session_summaries (FTS-searchable). Idempotent via content_hash UNIQUE.
    // Wrapped to ensure a digest failure does not poison the harvester run.
    let digestNote = "";
    try {
      const n = emitTodoDigest(database);
      if (n > 0) digestNote = `, todo-digest: ${n}`;
    } catch (err) {
      logger.warn({ err }, "Todo digest emit failed (non-fatal)");
    }

    const parts: string[] = [];
    parts.push(`Scanned: ${stats.scanned}`);
    parts.push(`Imported: ${stats.imported}`);
    if (stats.subAgents > 0) parts.push(`Sub-agents skipped: ${stats.subAgents}`);
    if (stats.skipped > 0) parts.push(`Duplicates: ${stats.skipped}`);
    if (stats.errors > 0) parts.push(`Errors: ${stats.errors}`);

    const output = `Session harvest: ${parts.join(", ")}` + digestNote;
    logger.info({ stats }, output);

    return { success: true, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "Session harvester failed");
    return { success: false, output: "", error: message };
  } finally {
    if (ownSm) sm.close();
  }
}

/**
 * Gap B: emit a session_summaries row containing today's done-with-comment todos.
 * Picks up todos completed since the last watermark, with notes != ''.
 * Idempotent via content_hash UNIQUE — re-running with the same set is a no-op.
 *
 * Runs from the session-harvester at 00:00 + 12:00 cadence. Searchable via FTS
 * immediately after insert. Tagged agent='daemon', project='todos' so it does
 * not pollute user-facing session lists.
 *
 * Watermark (todo_digest_watermark, singleton row id=1) replaces the previous
 * 12-hour sliding window, which dropped completions whenever a run was >12h
 * late. First run with no watermark backfills 30 days.
 */
function emitTodoDigest(db: ReturnType<StateManager["getDb"]>): number {
  const watermarkRow = db.prepare(
    "SELECT last_completed_at FROM todo_digest_watermark WHERE id = 1"
  ).get() as { last_completed_at: string } | undefined;

  // First run: backfill 30 days. Subsequent runs: strictly newer than watermark.
  const since = watermarkRow?.last_completed_at
    ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);

  const rows = db.prepare(`
    SELECT id, title, category, priority, notes, completed_at
    FROM todo_index
    WHERE status = 'done'
      AND completed_at > @since
      AND COALESCE(notes, '') != ''
    ORDER BY completed_at DESC
  `).all({ since }) as Array<{
    id: string; title: string; category: string; priority: string;
    notes: string; completed_at: string;
  }>;

  if (rows.length === 0) return 0;

  const lines = rows.map(r => {
    const noteFirstLine = (r.notes.split(/\r?\n/)[0] ?? "").slice(0, 220);
    const restCount = r.notes.length > noteFirstLine.length ? ` …(+${r.notes.length - noteFirstLine.length}c)` : "";
    return `- [${r.category}-${r.priority}] **${r.title}** (done ${r.completed_at})\n  ${noteFirstLine}${restCount}`;
  });
  const summary = `Completed todos with comments (since ${since}):\n\n${lines.join("\n\n")}`;
  const contentHash = createHash("sha256").update(summary).digest("hex");

  // Use a stable id per snapshot window so multiple harvester runs in quick
  // succession (shouldn't happen, but defensive) UPSERT instead of bloat.
  const snapshotId = `todo_digest_${new Date().toISOString().slice(0, 13).replace(/[-T:]/g, "")}`;

  const result = db.prepare(`
    INSERT OR IGNORE INTO session_summaries (
      id, agent, native_session_id, started_at, ended_at,
      project, title, message_count, summary, content_hash,
      created_at, status, processed_for_promotion, searchable
    ) VALUES (
      @id, 'daemon', @id, @started_at, @ended_at,
      'todos', @title, @message_count, @summary, @content_hash,
      CURRENT_TIMESTAMP, 'active', 0, 1
    )
  `).run({
    id: snapshotId,
    started_at: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
    ended_at: new Date().toISOString(),
    title: `Todo digest ${new Date().toISOString().slice(0, 10)} (${rows.length} done)`,
    message_count: rows.length,
    summary,
    content_hash: contentHash,
  });

  if (result.changes > 0) {
    logger.info({ digestId: snapshotId, todoCount: rows.length }, "Emitted todo digest into session_summaries");
  } else {
    logger.debug({ digestId: snapshotId }, "Todo digest already present (content_hash dedup)");
  }

  // Advance watermark to the newest completion we just bundled. Done even on
  // content_hash dedup — those rows are already promoted, no reason to re-scan.
  const newWatermark = rows[0]!.completed_at; // rows ORDER BY completed_at DESC
  db.prepare(`
    INSERT INTO todo_digest_watermark (id, last_completed_at, updated_at)
    VALUES (1, @wm, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      last_completed_at = excluded.last_completed_at,
      updated_at = excluded.updated_at
  `).run({ wm: newWatermark });

  return result.changes > 0 ? rows.length : 0;
}
