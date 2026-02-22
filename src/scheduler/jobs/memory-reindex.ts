/**
 * Memory Reindex — re-index ~/memory/*.md files into memory_fts
 *
 * Runs twice daily at 12:05 PM and 00:05 AM (triggered by session-harvester).
 * Uses content hashing — idempotent, skips unchanged files, cheap to run.
 *
 * Picks up manual edits, overnight promotions, and any other memory file changes
 * that haven't been indexed yet.
 */

import { getMemoryIndexer } from "../../memory/indexer.js";
import { logger } from "../../utils/logger.js";

export async function runMemoryReindex(): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  try {
    const indexer = getMemoryIndexer();
    const stats = await indexer.indexAllMemoryFiles();
    const output = `Reindex: ${stats.indexed} indexed, ${stats.skipped} unchanged, ${stats.errors} errors`;
    logger.info({ stats }, output);
    return { success: true, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "Memory reindex failed");
    return { success: false, output: "", error: message };
  }
}
