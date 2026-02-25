-- Migration 039: session_summaries lifecycle columns
-- Adds: daemon agent type, status/archive tracking, processed_for_promotion flag
-- Required for session memory pipeline refactor (collapse 4 jobs → 2)

-- 1. Drop FTS5 triggers
DROP TRIGGER IF EXISTS session_summaries_ai;
DROP TRIGGER IF EXISTS session_summaries_ad;
DROP TRIGGER IF EXISTS session_summaries_au;

-- 2. Drop FTS5 table
DROP TABLE IF EXISTS session_summaries_fts;

-- 3. Create new table with lifecycle columns
CREATE TABLE session_summaries_new (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL CHECK(agent IN ('codex','gemini','kimi','claude','opencode','daemon','telegram','web')),
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
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  archive_reason TEXT,
  archived_at TEXT,
  processed_for_promotion INTEGER NOT NULL DEFAULT 0 CHECK(processed_for_promotion IN (0,1))
);

-- 4. Copy existing data (defaults: status='active', processed_for_promotion=0)
INSERT INTO session_summaries_new (
  id, agent, native_session_id, started_at, ended_at, model, project,
  title, message_count, summary, raw_excerpt, is_sub_agent, content_hash, created_at,
  status, processed_for_promotion
)
SELECT
  id, agent, native_session_id, started_at, ended_at, model, project,
  title, message_count, summary, raw_excerpt, is_sub_agent, content_hash, created_at,
  'active', 0
FROM session_summaries;

-- 5. Drop old, rename new
DROP TABLE session_summaries;
ALTER TABLE session_summaries_new RENAME TO session_summaries;

-- 6. Recreate existing indexes + new ones
CREATE INDEX idx_session_summaries_agent ON session_summaries(agent);
CREATE INDEX idx_session_summaries_date ON session_summaries(started_at);
CREATE INDEX idx_session_summaries_project ON session_summaries(project);
CREATE INDEX idx_session_summaries_status ON session_summaries(status);
CREATE INDEX idx_session_summaries_promotion_queue ON session_summaries(processed_for_promotion, status);

-- 7. Recreate FTS5 table
CREATE VIRTUAL TABLE session_summaries_fts USING fts5(
  title, summary, project,
  content='session_summaries', content_rowid='rowid',
  tokenize='porter unicode61'
);

-- 7b. Backfill FTS5 from existing data
INSERT INTO session_summaries_fts(rowid, title, summary, project)
SELECT rowid, title, summary, project FROM session_summaries;

-- 7c. Recreate triggers
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

-- 8. Backfill: mark old sessions as already processed
UPDATE session_summaries SET processed_for_promotion = 1
WHERE started_at < date('now', '-2 days');
