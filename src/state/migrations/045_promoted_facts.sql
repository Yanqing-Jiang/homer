-- CAS (content-addressable storage) dedup for memory promotion pipeline.
-- Tracks every promoted fact by content hash to prevent duplicates across
-- nightly-memory, weekly-consolidation, and memory_promote MCP tool.

CREATE TABLE IF NOT EXISTS promoted_facts (
  fact_hash TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  target_file TEXT NOT NULL,
  section TEXT,
  promoted_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL DEFAULT 'unknown'
    CHECK(source IN ('nightly', 'weekly', 'mcp', 'unknown'))
);

CREATE INDEX IF NOT EXISTS idx_promoted_facts_file ON promoted_facts(target_file);
CREATE INDEX IF NOT EXISTS idx_promoted_facts_date ON promoted_facts(promoted_at);
