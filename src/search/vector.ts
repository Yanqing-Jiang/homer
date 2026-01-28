import { createClient } from "@supabase/supabase-js";
import { logger } from "../utils/logger.js";
import type { SearchResult, SearchConfig } from "./types.js";
import { generateEmbedding } from "./embeddings.js";

/**
 * Vector search using pgvector
 */
export async function vectorSearch(
  query: string,
  config: SearchConfig,
  limit: number = 10
): Promise<SearchResult[]> {
  const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);

  // Generate query embedding
  const queryEmbedding = await generateEmbedding(
    query,
    config.openaiApiKey,
    config.embeddingModel
  );

  // Search using cosine similarity
  const { data, error } = await supabase.rpc("match_memory_documents", {
    query_embedding: queryEmbedding,
    match_threshold: 0.3,
    match_count: limit,
  });

  if (error) {
    logger.error({ error }, "Vector search failed");
    throw new Error(`Vector search failed: ${error.message}`);
  }

  return (data || []).map((row: {
    file_path: string;
    chunk_index: number;
    content: string;
    context: string;
    similarity: number;
  }) => ({
    filePath: row.file_path,
    chunkIndex: row.chunk_index,
    content: row.content,
    context: row.context,
    score: row.similarity,
    source: "vector" as const,
  }));
}

/**
 * Initialize vector search (create RPC function if needed)
 * This SQL should be run once in Supabase
 */
export const VECTOR_SEARCH_SQL = `
-- Enable extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create table
CREATE TABLE IF NOT EXISTS memory_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_path TEXT NOT NULL,
  chunk_index INTEGER DEFAULT 0,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  context TEXT NOT NULL,
  embedding vector(1536),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(file_path, chunk_index)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_memory_docs_embedding
  ON memory_documents USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_memory_docs_content_trgm
  ON memory_documents USING gin (content gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_memory_docs_file_path
  ON memory_documents (file_path);

-- Create search function
CREATE OR REPLACE FUNCTION match_memory_documents(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.3,
  match_count int DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  file_path TEXT,
  chunk_index INTEGER,
  content TEXT,
  context TEXT,
  similarity float
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
    1 - (md.embedding <=> query_embedding) AS similarity
  FROM memory_documents md
  WHERE 1 - (md.embedding <=> query_embedding) > match_threshold
  ORDER BY md.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
`;
