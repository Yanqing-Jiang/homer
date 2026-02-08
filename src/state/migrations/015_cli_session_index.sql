-- CLI Session Import Tracking
-- Tracks imported sessions from Codex, Gemini, Kimi CLIs to prevent duplicates

CREATE TABLE IF NOT EXISTS cli_session_index (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL CHECK(agent IN ('codex', 'gemini', 'kimi', 'claude')),
  native_session_id TEXT,
  native_file_path TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  content_hash TEXT NOT NULL UNIQUE,
  log_date TEXT NOT NULL,
  message_count INTEGER DEFAULT 0,
  token_estimate INTEGER,
  status TEXT DEFAULT 'imported' CHECK(status IN ('imported', 'skipped', 'error')),
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_cli_sessions_date ON cli_session_index(log_date);
CREATE INDEX IF NOT EXISTS idx_cli_sessions_agent ON cli_session_index(agent, log_date);
CREATE INDEX IF NOT EXISTS idx_cli_sessions_hash ON cli_session_index(content_hash);
CREATE INDEX IF NOT EXISTS idx_cli_sessions_status ON cli_session_index(status, imported_at);
