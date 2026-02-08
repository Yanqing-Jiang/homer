-- H.O.M.E.R Phase 5.7: Vector Search Setup
-- Run this in your Supabase SQL Editor

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create table for memory documents
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

-- Vector search function (cosine similarity)
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

-- Full-text search function
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
