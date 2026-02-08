-- Migration 017: Add next_run_at to scheduled_job_state
ALTER TABLE scheduled_job_state ADD COLUMN next_run_at TEXT;
