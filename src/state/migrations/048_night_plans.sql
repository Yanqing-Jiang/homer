-- Night plans table for plan-review-execute flow
CREATE TABLE IF NOT EXISTS night_plans (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  status TEXT DEFAULT 'pending',  -- pending | approved | rejected | expired | executing | completed
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  executed_at TEXT,
  telegram_message_id INTEGER,
  user_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_night_plans_status ON night_plans(status);
CREATE INDEX IF NOT EXISTS idx_night_plans_created ON night_plans(created_at);
