/**
 * Memory Embeddings — generate embeddings for all new/changed memory chunks
 *
 * Runs on dirty flag or safety-net cron. Generates Gemini embedding-001
 * vectors (768d MRL) for all chunks in memory_fts that don't have
 * embeddings yet.
 *
 * This enables hybrid search (FTS5 + vector similarity via RRF).
 */

import { getMemoryIndexer } from "../../memory/indexer.js";
import { logger } from "../../utils/logger.js";
import type { StateManager } from "../../state/manager.js";

export async function runMemoryEmbeddings(stateManager?: StateManager): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  try {
    // Skip if not dirty (when stateManager available)
    if (stateManager && !stateManager.isPipelineDirty("embeddings")) {
      const output = "Embeddings skipped — not dirty";
      logger.info(output);
      return { success: true, output };
    }

    const indexer = getMemoryIndexer();
    const stats = await indexer.generateEmbeddings();

    const output = `Embeddings: ${stats.generated} generated, ${stats.skipped} skipped, ${stats.errors} errors`;
    logger.info({ stats }, output);

    // Clear dirty flag
    if (stateManager) {
      stateManager.clearPipelineDirty("embeddings");
    }

    return { success: true, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "Memory embeddings generation failed");
    return { success: false, output: "", error: message };
  }
}
