-- Watermark for the session-harvester's todo digest emitter.
-- Replaces the previous 12-hour sliding window in emitTodoDigest, which silently
-- dropped done-with-notes todos whenever a harvester run was >12h after completion.
-- Singleton row (id=1); stores the max completed_at of todos that have already
-- been bundled into a session_summaries todo_digest_* row.

CREATE TABLE IF NOT EXISTS todo_digest_watermark (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_completed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
