-- Migration 047: Add scheduler catch-up columns for DB-driven missed fire compensation
ALTER TABLE scheduled_job_state ADD COLUMN next_run_at_ms INTEGER;
ALTER TABLE scheduled_job_state ADD COLUMN last_triggered_at TEXT;

CREATE INDEX IF NOT EXISTS idx_scheduled_job_next_run_ms
  ON scheduled_job_state(next_run_at_ms)
  WHERE next_run_at_ms IS NOT NULL AND is_running = 0;
