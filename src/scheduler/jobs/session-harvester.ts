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

    const parts: string[] = [];
    parts.push(`Scanned: ${stats.scanned}`);
    parts.push(`Imported: ${stats.imported}`);
    if (stats.subAgents > 0) parts.push(`Sub-agents skipped: ${stats.subAgents}`);
    if (stats.skipped > 0) parts.push(`Duplicates: ${stats.skipped}`);
    if (stats.errors > 0) parts.push(`Errors: ${stats.errors}`);

    const output = `Session harvest: ${parts.join(", ")}`;
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
