-- Pipeline dirty-flag table for debounced reactive triggers.
-- Replaces unconditional DEPENDENCY_TRIGGERS cascade chains with
-- dirty-flag aware scheduling.
CREATE TABLE IF NOT EXISTS pipeline_dirty (
  pipeline TEXT PRIMARY KEY,
  is_dirty INTEGER NOT NULL DEFAULT 1,
  last_trigger TEXT,
  marked_at TEXT NOT NULL DEFAULT (datetime('now')),
  cleared_at TEXT
);
INSERT OR IGNORE INTO pipeline_dirty (pipeline) VALUES ('reindex');
INSERT OR IGNORE INTO pipeline_dirty (pipeline) VALUES ('embeddings');
INSERT OR IGNORE INTO pipeline_dirty (pipeline) VALUES ('context_bridge');
INSERT OR IGNORE INTO pipeline_dirty (pipeline) VALUES ('git_commit');
