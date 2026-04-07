-- FTS5 index over session_transcripts for verbatim conversation search.
-- Closes the retrieval gap: session_summaries compress ~30:1, losing exact
-- details (env vars, file paths, one-off commands, precise tradeoff wording).
-- This makes the raw archive searchable as a fallback tier behind curated memory.

-- Track which transcripts have been chunked and indexed
CREATE TABLE IF NOT EXISTS transcript_index_meta (
  content_hash TEXT PRIMARY KEY,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- FTS5 virtual table for verbatim transcript search
CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
  content,
  content_hash UNINDEXED,
  chunk_index UNINDEXED,
  agent UNINDEXED,
  project UNINDEXED,
  started_at UNINDEXED,
  tokenize='porter unicode61'
);
