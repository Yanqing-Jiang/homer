/**
 * Session Harvester — batch import all CLI sessions into session_summaries
 *
 * Runs twice daily at 12:00 PM and 12:00 AM. Scans all CLIs (Claude, Codex,
 * Gemini, Kimi, OpenCode), parses conversations, filters sub-agents, summarizes
 * (Gemini Flash), and INSERTs directly into session_summaries SQLite table with
 * FTS5 indexing.
 *
 * Sessions are immediately searchable via memory_search after this job completes.
 * Triggers memory-reindex → memory-embeddings chain after each run.
 */

import Database from "better-sqlite3";
import { homedir } from "os";
import { CLISessionImporter } from "../../cli-sessions/importer.js";
import { StateManager } from "../../state/manager.js";
import { logger } from "../../utils/logger.js";

const DB_PATH = `${homedir()}/homer/data/homer.db`;
const CLI_AGENTS = ["codex", "kimi", "claude", "opencode"] as const;
const MAX_BACKFILL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days cap for first run

export async function runSessionHarvester(
  db?: Database.Database
): Promise<{ success: boolean; output: string; error?: string }> {
  const ownDb = !db;
  const database = db ?? new Database(DB_PATH);

  try {
    const sm = new StateManager(DB_PATH);
    const ownSm = true; // always owned — sm is created locally for watermark ops

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

      const parts: string[] = [];
      parts.push(`Scanned: ${stats.scanned}`);
      parts.push(`Imported: ${stats.imported}`);
      if (stats.subAgents > 0) parts.push(`Sub-agents skipped: ${stats.subAgents}`);
      if (stats.skipped > 0) parts.push(`Duplicates: ${stats.skipped}`);
      if (stats.errors > 0) parts.push(`Errors: ${stats.errors}`);

      const output = `Session harvest: ${parts.join(", ")}`;
      logger.info({ stats }, output);

      return { success: true, output };
    } finally {
      if (ownSm) sm.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "Session harvester failed");
    return { success: false, output: "", error: message };
  } finally {
    if (ownDb) database.close();
  }
}
