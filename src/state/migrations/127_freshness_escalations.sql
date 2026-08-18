CREATE TABLE IF NOT EXISTS freshness_escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL,
  period_key TEXT NOT NULL,
  status TEXT NOT NULL,
  alert_key TEXT NOT NULL,
  dispatched_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN (
    'suppressed',
    'dispatching',
    'agent_succeeded',
    'agent_failed',
    'report_missing'
  )),
  report_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_freshness_escalations_alert_dispatch
  ON freshness_escalations(alert_key, dispatched_at DESC);
