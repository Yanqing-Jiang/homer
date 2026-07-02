-- Allow parse-bad session files to be quarantined without blocking harvester watermarks.

PRAGMA foreign_keys=OFF;

CREATE TABLE cli_session_index_new (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL CHECK(agent IN ('codex','gemini','kimi','claude','opencode','telegram','web')),
  native_session_id TEXT,
  native_file_path TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  content_hash TEXT NOT NULL UNIQUE,
  log_date TEXT NOT NULL,
  message_count INTEGER DEFAULT 0,
  token_estimate INTEGER,
  status TEXT DEFAULT 'imported' CHECK(status IN ('imported', 'skipped', 'error', 'parse-error')),
  error TEXT,
  is_sub_agent INTEGER NOT NULL DEFAULT 0,
  project TEXT DEFAULT '',
  title TEXT,
  model TEXT
);

INSERT INTO cli_session_index_new (
  id, agent, native_session_id, native_file_path, started_at, ended_at,
  imported_at, content_hash, log_date, message_count, token_estimate,
  status, error, is_sub_agent, project, title, model
)
SELECT
  id, agent, native_session_id, native_file_path, started_at, ended_at,
  imported_at, content_hash, log_date, message_count, token_estimate,
  status, error, is_sub_agent, project, title, model
FROM cli_session_index;

DROP TABLE cli_session_index;
ALTER TABLE cli_session_index_new RENAME TO cli_session_index;

CREATE INDEX idx_cli_sessions_date ON cli_session_index(log_date);
CREATE INDEX idx_cli_sessions_agent ON cli_session_index(agent, log_date);
CREATE INDEX idx_cli_sessions_hash ON cli_session_index(content_hash);
CREATE INDEX idx_cli_sessions_status ON cli_session_index(status, imported_at);

PRAGMA foreign_keys=ON;
