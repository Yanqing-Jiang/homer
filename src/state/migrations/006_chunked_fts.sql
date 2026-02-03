-- Migration 006: Chunked FTS5 for memory search
-- Adds chunk_index to support granular search results (6x token reduction)

-- Drop and recreate FTS5 table with chunk support
DROP TABLE IF EXISTS memory_fts;

CREATE VIRTUAL TABLE memory_fts USING fts5(
  file_path,
  chunk_index UNINDEXED,
  content,
  context UNINDEXED,
  entry_date UNINDEXED,
  tokenize='porter unicode61'
);

-- Recreate metadata table with chunk tracking
DROP TABLE IF EXISTS memory_index_meta;

CREATE TABLE memory_index_meta (
  file_path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 1,
  indexed_at TEXT NOT NULL,
  context TEXT NOT NULL
);
