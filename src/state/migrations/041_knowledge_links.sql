-- Migration 041: Knowledge Links
-- Cross-reference table for videos ↔ ideas ↔ sessions ↔ plans ↔ memory.

CREATE TABLE IF NOT EXISTS knowledge_links (
  id TEXT PRIMARY KEY,
  src_type TEXT NOT NULL,   -- youtube|idea|session|plan|memory
  src_id   TEXT NOT NULL,
  dst_type TEXT NOT NULL,
  dst_id   TEXT NOT NULL,
  link_type TEXT NOT NULL,  -- inspired|references|related_to|implements|supports
  strength REAL,
  evidence TEXT,
  created_by TEXT,          -- youtube_pipeline_v2|idea_dedup|user
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(src_type, src_id, dst_type, dst_id, link_type)
);

CREATE INDEX IF NOT EXISTS idx_kl_src ON knowledge_links(src_type, src_id);
CREATE INDEX IF NOT EXISTS idx_kl_dst ON knowledge_links(dst_type, dst_id);
