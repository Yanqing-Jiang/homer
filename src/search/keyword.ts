import { createClient } from "@supabase/supabase-js";
import { logger } from "../utils/logger.js";
import type { SearchResult, SearchConfig } from "./types.js";

/**
 * Keyword search using PostgreSQL full-text and trigram
 */
export async function keywordSearch(
  query: string,
  config: SearchConfig,
  limit: number = 10
): Promise<SearchResult[]> {
  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);

  // Use ILIKE for simple keyword matching
  // For better results, use ts_rank with to_tsvector
  const { data, error } = await supabase
    .from("memory_documents")
    .select("file_path, chunk_index, content, context")
    .ilike("content", `%${query}%`)
    .limit(limit);

  if (error) {
    logger.error({ error }, "Keyword search failed");
    throw new Error(`Keyword search failed: ${error.message}`);
  }

  // Calculate simple relevance score based on match count
  return (data || []).map((row: {
    file_path: string;
    chunk_index: number;
    content: string;
    context: string;
  }) => {
    const matches = (row.content.toLowerCase().match(new RegExp(query.toLowerCase(), "g")) || []).length;
    return {
      filePath: row.file_path,
      chunkIndex: row.chunk_index,
      content: row.content,
      context: row.context,
      score: Math.min(1, matches * 0.2), // Normalize score
      source: "keyword" as const,
    };
  });
}

/**
 * Full-text search using PostgreSQL ts_rank
 */
export async function fullTextSearch(
  query: string,
  config: SearchConfig,
  limit: number = 10
): Promise<SearchResult[]> {
  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);

  // Use RPC for proper full-text search
  const { data, error } = await supabase.rpc("search_memory_fulltext", {
    search_query: query,
    match_count: limit,
  });

  if (error) {
    // Fall back to simple keyword search
    logger.warn({ error }, "Full-text search failed, falling back to keyword");
    return keywordSearch(query, config, limit);
  }

  return (data || []).map((row: {
    file_path: string;
    chunk_index: number;
    content: string;
    context: string;
    rank: number;
  }) => ({
    filePath: row.file_path,
    chunkIndex: row.chunk_index,
    content: row.content,
    context: row.context,
    score: row.rank,
    source: "keyword" as const,
  }));
}

/**
 * SQL for full-text search function
 */
export const FULLTEXT_SEARCH_SQL = `
CREATE OR REPLACE FUNCTION search_memory_fulltext(
  search_query TEXT,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  file_path TEXT,
  chunk_index INTEGER,
  content TEXT,
  context TEXT,
  rank float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    md.id,
    md.file_path,
    md.chunk_index,
    md.content,
    md.context,
    ts_rank(to_tsvector('english', md.content), plainto_tsquery('english', search_query)) AS rank
  FROM memory_documents md
  WHERE to_tsvector('english', md.content) @@ plainto_tsquery('english', search_query)
  ORDER BY rank DESC
  LIMIT match_count;
END;
$$;
`;
