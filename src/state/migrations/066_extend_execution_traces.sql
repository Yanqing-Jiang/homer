-- Add scheduled_run_id to link execution traces back to scheduled_job_runs.
-- Safe to run on existing empty table.

ALTER TABLE execution_traces ADD COLUMN scheduled_run_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_exec_traces_run ON execution_traces(scheduled_run_id);
