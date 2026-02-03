import { logger } from "./logger.js";
import { processMemoryUpdates } from "../memory/writer.js";
import { getMemoryIndexer } from "../memory/indexer.js";

export interface ProcessedResponse {
  cleanedContent: string;
  hadMemoryUpdates: boolean;
}

/**
 * Centralized response processor for all flows (web, voice, bot)
 *
 * Processes memory updates and triggers reindexing
 *
 * @param response - The raw response from Claude
 * @param context - Context for memory updates (work, life, general)
 * @returns Cleaned response with memory tags removed
 */
export async function processResponse(
  response: string,
  context: string = "general"
): Promise<ProcessedResponse> {
  // Process memory updates
  const { cleanedResponse, updatesWritten, targets } = await processMemoryUpdates(
    response,
    context
  );

  if (updatesWritten > 0) {
    logger.info(
      { updatesWritten, targets },
      "Memory updates processed, triggering reindex"
    );

    // Trigger memory reindex in background
    const indexer = getMemoryIndexer();
    if (indexer) {
      // Run reindex asynchronously without blocking
      indexer.reindexAll().catch((error) => {
        logger.error({ error }, "Failed to reindex memory after update");
      });
    }
  }

  return {
    cleanedContent: cleanedResponse,
    hadMemoryUpdates: updatesWritten > 0,
  };
}
