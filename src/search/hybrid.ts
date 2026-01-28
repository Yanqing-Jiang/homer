import { logger } from "../utils/logger.js";
import type { SearchResult, SearchConfig } from "./types.js";
import { vectorSearch } from "./vector.js";
import { keywordSearch } from "./keyword.js";
import { searchMemory } from "../memory/search.js";

/**
 * Hybrid search combining vector (0.7) and keyword (0.3) results
 * Uses Reciprocal Rank Fusion (RRF) for score combination
 */
export async function hybridSearch(
  query: string,
  config: SearchConfig,
  limit: number = 10
): Promise<SearchResult[]> {
  // Check if Supabase is configured
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    logger.debug("Supabase not configured, falling back to grep");
    return grepFallback(query, limit);
  }

  try {
    // Run vector and keyword search in parallel
    const [vectorResults, keywordResults] = await Promise.all([
      vectorSearch(query, config, limit * 2).catch((err) => {
        logger.warn({ error: err }, "Vector search failed");
        return [] as SearchResult[];
      }),
      keywordSearch(query, config, limit * 2).catch((err) => {
        logger.warn({ error: err }, "Keyword search failed");
        return [] as SearchResult[];
      }),
    ]);

    // If both failed, fall back to grep
    if (vectorResults.length === 0 && keywordResults.length === 0) {
      logger.debug("Both searches empty, falling back to grep");
      return grepFallback(query, limit);
    }

    // Combine using RRF
    const combined = rrfCombine(vectorResults, keywordResults, 0.7, 0.3);

    // Take top results
    return combined.slice(0, limit).map((r) => ({
      ...r,
      source: "hybrid" as const,
    }));
  } catch (error) {
    logger.error({ error }, "Hybrid search failed, falling back to grep");
    return grepFallback(query, limit);
  }
}

/**
 * Reciprocal Rank Fusion
 * Combines rankings from multiple sources with weights
 */
function rrfCombine(
  vectorResults: SearchResult[],
  keywordResults: SearchResult[],
  vectorWeight: number,
  keywordWeight: number,
  k: number = 60
): SearchResult[] {
  const scores = new Map<string, { result: SearchResult; score: number }>();

  // Add vector scores
  vectorResults.forEach((result, rank) => {
    const key = `${result.filePath}:${result.chunkIndex}`;
    const rrfScore = vectorWeight * (1 / (k + rank + 1));

    if (scores.has(key)) {
      scores.get(key)!.score += rrfScore;
    } else {
      scores.set(key, { result, score: rrfScore });
    }
  });

  // Add keyword scores
  keywordResults.forEach((result, rank) => {
    const key = `${result.filePath}:${result.chunkIndex}`;
    const rrfScore = keywordWeight * (1 / (k + rank + 1));

    if (scores.has(key)) {
      scores.get(key)!.score += rrfScore;
    } else {
      scores.set(key, { result, score: rrfScore });
    }
  });

  // Sort by combined score
  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(({ result, score }) => ({ ...result, score }));
}

/**
 * Fallback to grep-based search
 */
async function grepFallback(query: string, limit: number): Promise<SearchResult[]> {
  const grepResults = await searchMemory(query);

  return grepResults.slice(0, limit).map((r) => ({
    filePath: `/Users/yj/memory/${r.file}`,
    chunkIndex: 0,
    content: r.content,
    context: r.context.join("\n"),
    score: 1,
    source: "keyword" as const,
  }));
}

/**
 * Format hybrid search results for display
 */
export function formatHybridResults(
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
    const fileName = result.filePath.split("/").pop() || result.filePath;
    const preview = result.content.slice(0, 200).replace(/\n/g, " ");
    const scoreStr = (result.score * 100).toFixed(0);

    output += `**${fileName}** (${scoreStr}%)\n`;
    output += `\`${preview}${preview.length >= 200 ? "..." : ""}\`\n\n`;
  }

  if (results.length > maxResults) {
    output += `_...and ${results.length - maxResults} more results_`;
  }

  return output;
}
