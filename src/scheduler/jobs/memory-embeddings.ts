/**
 * Memory Embeddings — generate embeddings for all new/changed memory chunks
 *
 * Runs daily at 02:30, after nightly-memory has promoted facts.
 * Generates Gemini embedding-001 vectors (768d MRL) for all chunks
 * in memory_fts that don't have embeddings yet.
 *
 * This enables hybrid search (FTS5 + vector similarity via RRF).
 */

import { getMemoryIndexer } from "../../memory/indexer.js";
import { logger } from "../../utils/logger.js";

export async function runMemoryEmbeddings(): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  try {
    const indexer = getMemoryIndexer();
    const stats = await indexer.generateEmbeddings();

    const output = `Embeddings: ${stats.generated} generated, ${stats.skipped} skipped, ${stats.errors} errors`;
    logger.info({ stats }, output);

    return { success: true, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "Memory embeddings generation failed");
    return { success: false, output: "", error: message };
  }
}
