-- Migration 007: Memory embeddings table for hybrid search
-- Stores Gemini embedding-001 vectors (768 dimensions by default)

CREATE TABLE IF NOT EXISTS memory_embeddings (
  file_path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  dimensions INTEGER NOT NULL DEFAULT 768,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (file_path, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_embeddings_updated ON memory_embeddings(updated_at);
