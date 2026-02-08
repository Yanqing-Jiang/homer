-- Tracks sync state for ingesting ideas from legacy ideas.md to ~/memory/ideas/ directory
CREATE TABLE IF NOT EXISTS idea_sync_state (
  id TEXT PRIMARY KEY DEFAULT 'default',
  last_synced_at TEXT,
  last_line_number INTEGER DEFAULT 0
);

-- Initialize with default entry
INSERT OR IGNORE INTO idea_sync_state (id, last_synced_at, last_line_number)
VALUES ('default', NULL, 0);
