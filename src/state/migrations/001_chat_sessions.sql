-- Migration 001: Chat Sessions & Threads
-- Created: 2026-01-30
-- Purpose: Support web UI sessions with multiple threads per session

-- NOTE: Named chat_sessions to avoid collision with existing sessions table
-- (which tracks Telegram bot sessions)
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  archived_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_archived ON chat_sessions(archived_at);

-- Threads within a session
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  chat_session_id TEXT NOT NULL,
  title TEXT,
  provider TEXT NOT NULL,           -- 'claude'|'chatgpt'|'gemini'
  model TEXT,
  status TEXT DEFAULT 'active',     -- 'active'|'expired'|'archived'
  external_session_id TEXT,         -- Claude session_id, CDP session
  parent_thread_id TEXT,            -- For thread branching
  branch_point_message_id TEXT,     -- Where branch started
  last_message_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (chat_session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_thread_id) REFERENCES threads(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_threads_session ON threads(chat_session_id);
CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status);
CREATE INDEX IF NOT EXISTS idx_threads_parent ON threads(parent_thread_id);
CREATE INDEX IF NOT EXISTS idx_threads_provider ON threads(provider);

-- Messages within a thread
CREATE TABLE IF NOT EXISTS thread_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,               -- 'user'|'assistant'|'system'
  content TEXT NOT NULL,
  metadata TEXT,                    -- JSON: tokens, model, etc
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_thread_messages_thread ON thread_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_thread_messages_created ON thread_messages(created_at);
