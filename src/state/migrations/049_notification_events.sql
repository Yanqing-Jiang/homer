CREATE TABLE IF NOT EXISTS notification_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL DEFAULT 'telegram',
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  job_run_id INTEGER REFERENCES scheduled_job_runs(id) ON DELETE SET NULL,
  intent TEXT NOT NULL,
  decision TEXT NOT NULL,
  title TEXT,
  message_text TEXT NOT NULL,
  reason TEXT,
  metadata_json TEXT,
  telegram_message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notification_events_source
  ON notification_events(source_type, source_id, created_at);

CREATE INDEX IF NOT EXISTS idx_notification_events_job_run_id
  ON notification_events(job_run_id);

CREATE INDEX IF NOT EXISTS idx_notification_events_decision
  ON notification_events(decision);

CREATE INDEX IF NOT EXISTS idx_notification_events_created_at
  ON notification_events(created_at);
