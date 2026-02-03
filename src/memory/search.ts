import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { basename } from "path";
import { logger } from "../utils/logger.js";

/**
 * Paths to search for memory content
 */
const SEARCH_PATHS = [
  "/Users/yj/memory/me.md",
  "/Users/yj/memory/work.md",
  "/Users/yj/memory/life.md",
  "/Users/yj/memory/preferences.md",
  "/Users/yj/memory/tools.md",
];

export interface SearchResult {
  file: string;
  line: number;
  content: string;
  context: string[];
}

/**
 * Search memory files for a query string (case-insensitive)
 * Returns matching lines with surrounding context
 */
export async function searchMemory(
  query: string,
  contextLines: number = 1
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const queryLower = query.toLowerCase();

  for (const filePath of SEARCH_PATHS) {
    if (!existsSync(filePath)) {
      continue;
    }

    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n");
      const fileName = basename(filePath);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line && line.toLowerCase().includes(queryLower)) {
          // Get context lines before and after
          const start = Math.max(0, i - contextLines);
          const end = Math.min(lines.length - 1, i + contextLines);
          const context: string[] = [];

          for (let j = start; j <= end; j++) {
            const contextLine = lines[j];
            if (j !== i && contextLine !== undefined) {
              context.push(contextLine);
            }
          }

          results.push({
            file: fileName,
            line: i + 1,
            content: line,
            context,
          });
        }
      }
    } catch (error) {
      logger.warn({ filePath, error }, "Failed to search file");
    }
  }

  return results;
}

/**
 * Format search results for display in Telegram
 */
export function formatSearchResults(
  results: SearchResult[],
  query: string
): string {
  if (results.length === 0) {
    return `No results found for "${query}"`;
  }

  const maxResults = 10;
  const truncated = results.slice(0, maxResults);

  let output = `*Search: "${query}"*\n\n`;

  for (const result of truncated) {
    output += `**${result.file}:${result.line}**\n`;
    output += `\`${result.content.trim()}\`\n\n`;
  }

  if (results.length > maxResults) {
    output += `_...and ${results.length - maxResults} more results_`;
  }

  return output;
}
