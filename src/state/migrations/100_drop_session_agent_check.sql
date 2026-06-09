-- 100_drop_session_agent_check.sql
-- Cross-device Cosmos pull imports sessions authored on other devices under
-- their own agent/provider taxonomy (e.g. "build", "explore", "general",
-- provider "github-copilot"). The closed CHECK(agent IN (...)) on
-- session_summaries rejected every such row at INSERT time, so the agent enum
-- was acting as an unintended sync boundary. Provenance (origin_device /
-- validForeignDevice) is the real safety check; agent is descriptive metadata.
--
-- SQLite can't ALTER a CHECK in place, so rebuild the table: rename, recreate
-- WITHOUT the agent CHECK (every other column/constraint preserved), copy data,
-- drop the old table, then recreate indexes + triggers and rebuild the
-- external-content FTS index (rowids change on rebuild).

ALTER TABLE session_summaries RENAME TO session_summaries_old;

CREATE TABLE session_summaries (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
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
  processed_for_promotion INTEGER NOT NULL DEFAULT 0 CHECK(processed_for_promotion IN (0,1)),
  searchable INTEGER NOT NULL DEFAULT 1,
  origin_device TEXT
);

INSERT INTO session_summaries
  (id, agent, native_session_id, started_at, ended_at, model, project, title,
   message_count, summary, raw_excerpt, is_sub_agent, content_hash, created_at,
   status, archive_reason, archived_at, processed_for_promotion, searchable, origin_device)
SELECT
  id, agent, native_session_id, started_at, ended_at, model, project, title,
  message_count, summary, raw_excerpt, is_sub_agent, content_hash, created_at,
  status, archive_reason, archived_at, processed_for_promotion, searchable, origin_device
FROM session_summaries_old;

DROP TABLE session_summaries_old;

CREATE INDEX idx_session_summaries_agent ON session_summaries(agent);
CREATE INDEX idx_session_summaries_date ON session_summaries(started_at);
CREATE INDEX idx_session_summaries_project ON session_summaries(project);
CREATE INDEX idx_session_summaries_status ON session_summaries(status);
CREATE INDEX idx_session_summaries_promotion_queue ON session_summaries(processed_for_promotion, status);
CREATE INDEX idx_session_summaries_searchable ON session_summaries(status, searchable);
CREATE INDEX idx_ss_origin_device ON session_summaries(origin_device);

-- NOTE: BEGIN is kept on its OWN line in every trigger below. The whole-file
-- fast path runs fine either way, but the runner's lenient statement-by-statement
-- retry (execStatementsLenient) only tracks trigger-body depth when "BEGIN" is a
-- standalone line — an inline `CREATE TRIGGER ... BEGIN` would be split at the
-- first inner semicolon and corrupt the retry. Standalone BEGIN keeps both paths safe.
CREATE TRIGGER session_summaries_ai AFTER INSERT ON session_summaries
BEGIN
  INSERT INTO session_summaries_fts(rowid, title, summary, project)
  VALUES (new.rowid, new.title, new.summary, new.project);
END;
CREATE TRIGGER session_summaries_ad AFTER DELETE ON session_summaries
BEGIN
  INSERT INTO session_summaries_fts(session_summaries_fts, rowid, title, summary, project)
  VALUES ('delete', old.rowid, old.title, old.summary, old.project);
END;
CREATE TRIGGER session_summaries_au AFTER UPDATE ON session_summaries
BEGIN
  INSERT INTO session_summaries_fts(session_summaries_fts, rowid, title, summary, project)
  VALUES ('delete', old.rowid, old.title, old.summary, old.project);
  INSERT INTO session_summaries_fts(rowid, title, summary, project)
  VALUES (new.rowid, new.title, new.summary, new.project);
END;

-- Table rebuild reassigned rowids; resync the external-content FTS index.
INSERT INTO session_summaries_fts(session_summaries_fts) VALUES('rebuild');
