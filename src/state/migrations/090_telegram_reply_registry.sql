-- 090: telegram_messages — shared registry for replyable outgoing Telegram messages
--
-- Enables Telegram quote-reply to work as conversational context: when the user
-- replies to one of Homer's messages, the main text handler looks up the quoted
-- message here, pulls thread/session/message text, and injects a <replying-to>
-- block into the executor prompt. Survives daemon restart (unlike the in-memory
-- Maps in bot/handlers/approval.ts).

CREATE TABLE IF NOT EXISTS telegram_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  telegram_message_id INTEGER NOT NULL,
  lane TEXT NOT NULL,
  role TEXT NOT NULL,                 -- 'assistant' | 'system' | 'prompt'
  message_kind TEXT NOT NULL,         -- 'conversation' for now; extend later
  thread_id TEXT,
  thread_message_id TEXT,
  run_id TEXT,
  session_id TEXT,
  message_text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  UNIQUE(chat_id, telegram_message_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_messages_lane
  ON telegram_messages(lane, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_messages_expiry
  ON telegram_messages(expires_at);
