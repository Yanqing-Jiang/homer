/**
 * Memory Reindex — re-index ~/memory/*.md files into memory_fts
 *
 * Runs on dirty flag or safety-net cron. Uses content hashing — idempotent,
 * skips unchanged files, cheap to run.
 *
 * Picks up manual edits, overnight promotions, and any other memory file changes
 * that haven't been indexed yet.
 */

import { getMemoryIndexer } from "../../memory/indexer.js";
import { logger } from "../../utils/logger.js";
import type { StateManager } from "../../state/manager.js";
import { memoryEvents } from "../../events/memory-events.js";

export async function runMemoryReindex(stateManager?: StateManager): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  try {
    // Skip if not dirty (when stateManager available)
    if (stateManager && !stateManager.isPipelineDirty("reindex")) {
      const output = "Reindex skipped — not dirty";
      logger.info(output);
      return { success: true, output };
    }

    const indexer = getMemoryIndexer();
    const stats = await indexer.indexAllMemoryFiles();
    const output = `Reindex: ${stats.indexed} indexed, ${stats.skipped} unchanged, ${stats.errors} errors`;
    logger.info({ stats }, output);

    // Clear dirty flag
    if (stateManager) {
      stateManager.clearPipelineDirty("reindex");
    }

    // If anything was indexed, mark embeddings dirty + emit event for reactive trigger
    if (stats.indexed > 0 && stateManager) {
      stateManager.markPipelineDirty("embeddings", "memory-reindex");
      memoryEvents.emitDirty("embeddings", "memory-reindex");
    }

    return { success: true, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "Memory reindex failed");
    return { success: false, output: "", error: message };
  }
}
