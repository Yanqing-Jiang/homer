-- 062: Server-authoritative unread system + run event persistence
-- Fixes: red dot inconsistency across browsers, rename triggering unread,
--        steps disappearing on session switch, no process visibility

-- 1. Add activity_at to chat_sessions (only bumped by message creation)
ALTER TABLE chat_sessions ADD COLUMN activity_at TEXT;

-- Backfill: set activity_at = updated_at for existing sessions
UPDATE chat_sessions SET activity_at = updated_at;

-- 2. Server-owned read state (replaces localStorage-based tracking)
CREATE TABLE IF NOT EXISTS session_reads (
  session_id TEXT PRIMARY KEY,
  read_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

-- 3. Run event persistence (step timeline replay after navigation)
CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT,
  label_done TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_run_events_thread ON run_events(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_activity ON chat_sessions(activity_at);
