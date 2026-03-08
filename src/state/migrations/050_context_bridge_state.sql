CREATE TABLE IF NOT EXISTS context_bridge_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source_hash TEXT,
  output_hash TEXT,
  dirty INTEGER NOT NULL DEFAULT 1,
  last_started_at TEXT,
  last_completed_at TEXT,
  last_trigger_source TEXT,
  last_method TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
