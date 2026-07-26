-- Shared document store for canonical memory (Phase 5) and retired-subsystem
-- archives (Phase 3). Deliberately minimal: one row per logical document,
-- addressed by a stable human-readable key. Chunking/embedding lives in the
-- existing memory_embeddings namespace, keyed off `document:<id>` — nothing
-- here is indexed automatically, callers opt in.
--
-- `kind` partitions consumers (e.g. 'canonical', 'retired-archive').
-- `context` is free-form JSON for consumer-specific metadata.
-- `source_ref` records provenance (file path, table name, job id).
-- `archived_at` marks a document as historical: retained, not injectable.

CREATE TABLE IF NOT EXISTS memory_documents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  context TEXT,
  source_ref TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_documents_kind
  ON memory_documents(kind, updated_at DESC);
