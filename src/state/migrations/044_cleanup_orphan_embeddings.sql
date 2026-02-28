-- Migration 044: Clean stale orphan embeddings
-- One-time cleanup for embeddings with no matching FTS chunk or session

-- Remove non-session embeddings with no matching FTS entry
DELETE FROM memory_embeddings
WHERE file_path NOT LIKE 'session:%'
  AND NOT EXISTS (
    SELECT 1 FROM memory_fts f
    WHERE f.file_path = memory_embeddings.file_path
      AND f.chunk_index = memory_embeddings.chunk_index
  );

-- Remove session embeddings where the session no longer exists
DELETE FROM memory_embeddings
WHERE file_path LIKE 'session:%'
  AND NOT EXISTS (
    SELECT 1 FROM session_summaries s
    WHERE memory_embeddings.file_path = 'session:' || s.id
  );
