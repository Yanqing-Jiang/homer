import { appendFile, access, mkdir } from "fs/promises";
import { constants } from "fs";
import { dirname } from "path";
import { logger } from "../utils/logger.js";

/**
 * Memory file paths by target
 */
const MEMORY_PATHS: Record<string, string> = {
  work: "/Users/yj/work/memory.md",
  life: "/Users/yj/life/memory.md",
  global: "/Users/yj/memory/facts.md",
  default: "/Users/yj/memory/facts.md",
};

/**
 * Ensure directory exists for a file path
 */
async function ensureDirectory(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  try {
    await access(dir, constants.W_OK);
  } catch {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Append content to a memory file with timestamp
 */
async function appendToMemoryFile(target: string, content: string): Promise<void> {
  const filePath = MEMORY_PATHS[target] ?? MEMORY_PATHS.default;

  if (!filePath) {
    logger.warn({ target }, "No memory file path for target");
    return;
  }

  try {
    await ensureDirectory(filePath);

    const timestamp = new Date().toISOString().split("T")[0];
    const formattedContent = `\n\n<!-- Updated: ${timestamp} -->\n${content}`;

    await appendFile(filePath, formattedContent, "utf-8");
    logger.info({ target, filePath, contentLength: content.length }, "Memory file updated");
  } catch (error) {
    logger.error({ error, target, filePath }, "Failed to write memory file");
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
