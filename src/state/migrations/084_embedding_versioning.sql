-- 084: embedding versioning — record which model + content produced each vector
-- Without these columns, a model swap or chunk-content change is invisible: a
-- regression in recall looks like the ranker getting worse when really the
-- embeddings are stale. Required precondition for the recall eval set.

ALTER TABLE memory_embeddings ADD COLUMN model TEXT;
ALTER TABLE memory_embeddings ADD COLUMN embed_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memory_embeddings ADD COLUMN content_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_embeddings_model_version ON memory_embeddings(model, embed_version);

-- Backfill known-good defaults for existing rows.
UPDATE memory_embeddings SET model = 'gemini-embedding-001' WHERE model IS NULL;
