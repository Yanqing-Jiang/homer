-- 082: memory_mutations — append-only ledger of every write to ~/memory/*.md
-- Recording pre/post SHA256 lets rollback verify the file matches what we last wrote
-- before applying the inverse, so we never silently overwrite an external edit.

CREATE TABLE IF NOT EXISTS memory_mutations (
  id TEXT PRIMARY KEY,
  claim_id TEXT REFERENCES knowledge_claims(id),
  target_file TEXT NOT NULL,                       -- absolute path, e.g. /Users/yj/memory/work.md
  section TEXT,
  operation TEXT NOT NULL CHECK(operation IN ('append','replace','remove','write')),
  old_text TEXT,                                   -- replace/remove: the substring matched
  new_text TEXT,                                   -- append/replace/write: the new content
  pre_hash TEXT NOT NULL,                          -- SHA256 of file content before mutation
  post_hash TEXT NOT NULL,                         -- SHA256 of file content after mutation
  source TEXT NOT NULL,                            -- 'mcp' | 'nightly' | 'weekly' | 'cleanup' | 'audit' | 'undo'
  actor TEXT NOT NULL DEFAULT 'system',            -- 'user' | 'auto-approve' | 'system' | undo claim id
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mm_claim ON memory_mutations(claim_id);
CREATE INDEX IF NOT EXISTS idx_mm_file_created ON memory_mutations(target_file, created_at);
CREATE INDEX IF NOT EXISTS idx_mm_post_hash ON memory_mutations(post_hash);
