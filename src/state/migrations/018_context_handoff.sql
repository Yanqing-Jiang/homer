-- Context Handoff Tables
-- Supports executor switching with conversation context preservation

-- Lane messages for telegram (stores conversation history per lane)
CREATE TABLE IF NOT EXISTS lane_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lane TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  executor TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lane_messages_lane ON lane_messages(lane, created_at DESC);

-- Pending context for executor handoffs
-- Stores context to inject on next message when message_count = 0
CREATE TABLE IF NOT EXISTS pending_context (
  lane TEXT PRIMARY KEY,
  context TEXT NOT NULL,
  source_executor TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
