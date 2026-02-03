-- Migration 012: CLI Runs + Executor Session State
-- Created: 2026-02-03
-- Purpose: Track non-streaming CLI runs and executor session IDs

-- Track CLI runs for status + output
CREATE TABLE IF NOT EXISTS cli_runs (
  id TEXT PRIMARY KEY,
  lane TEXT NOT NULL,
  executor TEXT NOT NULL,
  thread_id TEXT,
  status TEXT NOT NULL,        -- 'pending'|'running'|'completed'|'failed'|'cancelled'
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  exit_code INTEGER,
  output TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_cli_runs_lane ON cli_runs(lane, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cli_runs_status ON cli_runs(status);

-- Add session_id to executor_state (for CLI resume)
ALTER TABLE executor_state ADD COLUMN session_id TEXT;
