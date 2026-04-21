CREATE TABLE IF NOT EXISTS outbound_call_intents (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source TEXT NOT NULL,
  source_ref TEXT,
  to_number TEXT NOT NULL,
  recipient_name TEXT NOT NULL DEFAULT 'there',
  call_purpose TEXT NOT NULL,
  requested_by TEXT NOT NULL DEFAULT 'Yanqing',
  agent_id TEXT NOT NULL,
  agent_phone_number_id TEXT NOT NULL,
  conversation_id TEXT,
  call_sid TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  provider_error TEXT,
  verification_status TEXT,
  verification_reason TEXT,
  purpose_delivered INTEGER,
  first_agent_turn TEXT,
  first_user_turn TEXT,
  termination_reason TEXT,
  duration_secs INTEGER
);

CREATE INDEX IF NOT EXISTS idx_outbound_intents_conversation_id
  ON outbound_call_intents(conversation_id);

CREATE INDEX IF NOT EXISTS idx_outbound_intents_status_created
  ON outbound_call_intents(status, created_at);
