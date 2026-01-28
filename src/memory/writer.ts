import { logger } from "../utils/logger.js";
import { appendDailyLog, createDailyEntry } from "./daily.js";

/**
 * Map target to context type for daily log
 */
function targetToContext(target: string): "work" | "life" | "general" {
  switch (target) {
    case "work":
      return "work";
    case "life":
      return "life";
    case "global":
    case "default":
    default:
      return "general";
  }
}

/**
 * Append content to daily log instead of direct memory files
 * The 3 AM organization job will move entries to appropriate memory files
 */
async function appendToMemoryFile(target: string, content: string): Promise<void> {
  const context = targetToContext(target);

  try {
    const entry = createDailyEntry(content, context, "conversation");
    await appendDailyLog(entry);
    logger.info({ target, context, contentLength: content.length }, "Memory update added to daily log");
  } catch (error) {
    logger.error({ error, target }, "Failed to write to daily log");
    throw error;
  }
}

export interface MemoryUpdateResult {
  cleanedResponse: string;
  updatesWritten: number;
  targets: string[];
}

/**
 * Parse and process memory update tags from Claude response
 *
 * Tags format:
 * <memory-update>content</memory-update>           - writes to context memory
 * <memory-update target="work">content</memory-update>  - writes to work memory
 * <memory-update target="life">content</memory-update>  - writes to life memory
 * <memory-update target="global">content</memory-update> - writes to global memory
 */
export async function processMemoryUpdates(
  response: string,
  context: string
): Promise<MemoryUpdateResult> {
  const regex = /<memory-update(?:\s+target="(work|life|global)")?>([\s\S]*?)<\/memory-update>/g;
  let match;
  let updatesWritten = 0;
  let cleanedResponse = response;
  const targets: string[] = [];

  // Collect all matches first to avoid regex state issues
  const matches: Array<{ full: string; target: string; content: string }> = [];
  while ((match = regex.exec(response)) !== null) {
    const content = match[2];
    matches.push({
      full: match[0],
      target: match[1] || context,
      content: content ? content.trim() : "",
    });
  }

  // Process each match
  for (const m of matches) {
    if (m.content) {
      try {
        await appendToMemoryFile(m.target, m.content);
        updatesWritten++;
        targets.push(m.target);
      } catch {
        // Error already logged in appendToMemoryFile
      }
    }
    // Remove the tag from the response
    cleanedResponse = cleanedResponse.replace(m.full, "");
  }

  // Clean up any extra whitespace from removed tags
  cleanedResponse = cleanedResponse.replace(/\n{3,}/g, "\n\n").trim();

  return {
    cleanedResponse,
    updatesWritten,
    targets,
  };
}
