-- Phase 5: canonical memory (me/work/preferences/tools/patterns) moves into
-- memory_documents. The document CONTENT is backfilled at runtime by
-- ensureCanonicalDocuments() (src/memory/documents.ts) — deliberately not
-- embedded here, because migrations are git-tracked and the canonical files
-- hold personal data.
--
-- What this migration does is the structural half: drop the file-scan index
-- entries for the five canonical .md paths so memory_fts / memory_embeddings /
-- memory_index_meta stop serving chunks keyed by a path that no longer exists.
-- The indexer re-populates them under the `document:<key>` namespace.

DELETE FROM memory_fts
WHERE file_path LIKE '%/memory/me.md'
   OR file_path LIKE '%/memory/work.md'
   OR file_path LIKE '%/memory/preferences.md'
   OR file_path LIKE '%/memory/tools.md'
   OR file_path LIKE '%/memory/patterns.md'
   OR file_path LIKE '%/memory/session-bootstrap.md';

DELETE FROM memory_embeddings
WHERE file_path LIKE '%/memory/me.md'
   OR file_path LIKE '%/memory/work.md'
   OR file_path LIKE '%/memory/preferences.md'
   OR file_path LIKE '%/memory/tools.md'
   OR file_path LIKE '%/memory/patterns.md'
   OR file_path LIKE '%/memory/session-bootstrap.md';

DELETE FROM memory_index_meta
WHERE file_path LIKE '%/memory/me.md'
   OR file_path LIKE '%/memory/work.md'
   OR file_path LIKE '%/memory/preferences.md'
   OR file_path LIKE '%/memory/tools.md'
   OR file_path LIKE '%/memory/patterns.md'
   OR file_path LIKE '%/memory/session-bootstrap.md';

CREATE INDEX IF NOT EXISTS idx_memory_documents_updated
  ON memory_documents(updated_at DESC);
