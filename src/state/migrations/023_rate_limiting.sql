-- Migration: 023_rate_limiting.sql
-- Purpose: Rate limiting and circuit breaker state tables for job hunt.

CREATE TABLE IF NOT EXISTS rate_limit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  site TEXT,
  timestamp TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rate_action ON rate_limit_log(action, timestamp);
CREATE INDEX IF NOT EXISTS idx_rate_site ON rate_limit_log(action, site, timestamp);

CREATE TABLE IF NOT EXISTS circuit_breaker_state (
  name TEXT PRIMARY KEY,
  state TEXT DEFAULT 'closed',
  failure_count INTEGER DEFAULT 0,
  last_failure TEXT,
  opened_at TEXT
);
