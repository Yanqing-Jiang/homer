-- Session Summaries: first-class SQLite storage for CLI session memory
-- Sessions bypass daily log entirely, go direct to structured storage + FTS5

CREATE TABLE IF NOT EXISTS session_summaries (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL CHECK(agent IN ('codex','gemini','kimi','claude','opencode')),
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

CREATE INDEX IF NOT EXISTS idx_session_summaries_agent ON session_summaries(agent);
CREATE INDEX IF NOT EXISTS idx_session_summaries_date ON session_summaries(started_at);
CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);

-- FTS5 index for immediate searchability
CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
  title, summary, project,
  content='session_summaries', content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Auto-sync FTS on INSERT
CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
  INSERT INTO session_summaries_fts(rowid, title, summary, project)
  VALUES (new.rowid, new.title, new.summary, new.project);
END;

-- Auto-sync FTS on DELETE
CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
  INSERT INTO session_summaries_fts(session_summaries_fts, rowid, title, summary, project)
  VALUES ('delete', old.rowid, old.title, old.summary, old.project);
END;

-- Auto-sync FTS on UPDATE
CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
  INSERT INTO session_summaries_fts(session_summaries_fts, rowid, title, summary, project)
  VALUES ('delete', old.rowid, old.title, old.summary, old.project);
  INSERT INTO session_summaries_fts(rowid, title, summary, project)
  VALUES (new.rowid, new.title, new.summary, new.project);
END;

-- Extend cli_session_index for sub-agent tracking and metadata
-- Using INSERT OR IGNORE pattern since ALTER TABLE IF NOT EXISTS doesn't exist in SQLite
ALTER TABLE cli_session_index ADD COLUMN is_sub_agent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cli_session_index ADD COLUMN project TEXT DEFAULT '';
ALTER TABLE cli_session_index ADD COLUMN title TEXT;
ALTER TABLE cli_session_index ADD COLUMN model TEXT;
