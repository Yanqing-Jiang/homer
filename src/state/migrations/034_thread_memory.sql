-- Migration 034: Thread Memory — Make Telegram + Web UI conversations searchable
-- 1. Expand session_summaries + cli_session_index CHECK to include 'telegram' and 'web'
-- 2. Create thread_import_watermark for incremental harvesting
-- 3. Create thread_messages_fts for real-time search

PRAGMA foreign_keys=OFF;

-- ============================================================
-- 1a. Rebuild session_summaries with expanded CHECK constraint
-- ============================================================

-- Drop FTS triggers first (they reference the old table)
DROP TRIGGER IF EXISTS session_summaries_ai;
DROP TRIGGER IF EXISTS session_summaries_ad;
DROP TRIGGER IF EXISTS session_summaries_au;

-- Drop FTS table (will be recreated)
DROP TABLE IF EXISTS session_summaries_fts;

CREATE TABLE session_summaries_new (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL CHECK(agent IN ('codex','gemini','kimi','claude','opencode','telegram','web')),
  native_session_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  model TEXT,
  project TEXT,
  title TEXT,
  message_count INTEGER DEFAULT 0,
  summary TEXT NOT NULL,
  raw_excerpt TEXT,
  is_sub_agent INTEGER DEFAULT 0,
  content_hash TEXT UNIQUE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO session_summaries_new SELECT * FROM session_summaries;
DROP TABLE session_summaries;
ALTER TABLE session_summaries_new RENAME TO session_summaries;

CREATE INDEX idx_session_summaries_agent ON session_summaries(agent);
CREATE INDEX idx_session_summaries_date ON session_summaries(started_at);
CREATE INDEX idx_session_summaries_project ON session_summaries(project);

-- Recreate FTS5 table + backfill
CREATE VIRTUAL TABLE session_summaries_fts USING fts5(
  title, summary, project,
  content='session_summaries', content_rowid='rowid',
  tokenize='porter unicode61'
);

INSERT INTO session_summaries_fts(rowid, title, summary, project)
  SELECT rowid, title, summary, project FROM session_summaries;

-- Recreate auto-sync triggers
CREATE TRIGGER session_summaries_ai AFTER INSERT ON session_summaries BEGIN
  INSERT INTO session_summaries_fts(rowid, title, summary, project)
  VALUES (new.rowid, new.title, new.summary, new.project);
END;

CREATE TRIGGER session_summaries_ad AFTER DELETE ON session_summaries BEGIN
  INSERT INTO session_summaries_fts(session_summaries_fts, rowid, title, summary, project)
  VALUES ('delete', old.rowid, old.title, old.summary, old.project);
END;

CREATE TRIGGER session_summaries_au AFTER UPDATE ON session_summaries BEGIN
  INSERT INTO session_summaries_fts(session_summaries_fts, rowid, title, summary, project)
  VALUES ('delete', old.rowid, old.title, old.summary, old.project);
  INSERT INTO session_summaries_fts(rowid, title, summary, project)
  VALUES (new.rowid, new.title, new.summary, new.project);
END;

-- ============================================================
-- 1b. Rebuild cli_session_index with expanded CHECK constraint
-- ============================================================

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
  status TEXT DEFAULT 'imported' CHECK(status IN ('imported', 'skipped', 'error')),
  error TEXT,
  is_sub_agent INTEGER NOT NULL DEFAULT 0,
  project TEXT DEFAULT '',
  title TEXT,
  model TEXT
);

INSERT INTO cli_session_index_new SELECT * FROM cli_session_index;
DROP TABLE cli_session_index;
ALTER TABLE cli_session_index_new RENAME TO cli_session_index;

CREATE INDEX idx_cli_sessions_date ON cli_session_index(log_date);
CREATE INDEX idx_cli_sessions_agent ON cli_session_index(agent, log_date);
CREATE INDEX idx_cli_sessions_hash ON cli_session_index(content_hash);
CREATE INDEX idx_cli_sessions_status ON cli_session_index(status, imported_at);

PRAGMA foreign_keys=ON;

-- ============================================================
-- 2. Thread import watermark for incremental harvesting
-- ============================================================

CREATE TABLE IF NOT EXISTS thread_import_watermark (
  thread_id TEXT PRIMARY KEY,
  last_imported_message_id TEXT NOT NULL,
  last_imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  total_imported INTEGER NOT NULL DEFAULT 0
);

-- ============================================================
-- 3. FTS5 on thread_messages for real-time search
-- ============================================================

CREATE VIRTUAL TABLE IF NOT EXISTS thread_messages_fts USING fts5(
  content,
  content='thread_messages', content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Backfill: index only user and assistant messages (skip system)
INSERT INTO thread_messages_fts(rowid, content)
  SELECT rowid, content FROM thread_messages
  WHERE role IN ('user', 'assistant');

-- Auto-sync on INSERT (only for user/assistant roles)
CREATE TRIGGER IF NOT EXISTS thread_messages_fts_ai AFTER INSERT ON thread_messages
  WHEN new.role IN ('user', 'assistant')
BEGIN
  INSERT INTO thread_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- Auto-sync on DELETE
CREATE TRIGGER IF NOT EXISTS thread_messages_fts_ad AFTER DELETE ON thread_messages
  WHEN old.role IN ('user', 'assistant')
BEGIN
  INSERT INTO thread_messages_fts(thread_messages_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
END;

-- Auto-sync on UPDATE
CREATE TRIGGER IF NOT EXISTS thread_messages_fts_au AFTER UPDATE ON thread_messages
  WHEN old.role IN ('user', 'assistant')
BEGIN
  INSERT INTO thread_messages_fts(thread_messages_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
  INSERT INTO thread_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
