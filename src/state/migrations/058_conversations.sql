-- Cross-gateway conversation identity layer
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  context_summary TEXT,       -- LLM-generated 2-sentence summary
  task_ids TEXT,              -- JSON array of linked task IDs
  gateway_origin TEXT,        -- which gateway started this conversation
  last_gateway TEXT,          -- most recent gateway used
  status TEXT DEFAULT 'active',  -- active, abandoned, completed
  created_at TEXT DEFAULT (datetime('now')),
  last_active TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversation_channels (
  conversation_id TEXT NOT NULL,
  gateway TEXT NOT NULL,       -- telegram, web, mcp, cli, api
  channel_id TEXT NOT NULL,    -- tg:chatId, web:sessionId, mcp:threadId
  PRIMARY KEY (conversation_id, gateway),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conversations_last_active ON conversations(last_active);
CREATE INDEX IF NOT EXISTS idx_conversation_channels_channel ON conversation_channels(channel_id);
