ALTER TABLE plan_executions ADD COLUMN review_status TEXT;
ALTER TABLE plan_executions ADD COLUMN review_session_id TEXT;
ALTER TABLE plan_executions ADD COLUMN review_started_at TEXT;
ALTER TABLE plan_executions ADD COLUMN review_completed_at TEXT;
ALTER TABLE plan_executions ADD COLUMN review_summary TEXT;
ALTER TABLE plan_executions ADD COLUMN review_output TEXT;
ALTER TABLE plan_executions ADD COLUMN review_patch_commit_sha TEXT;
ALTER TABLE plan_executions ADD COLUMN review_last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_plan_exec_review_status ON plan_executions(review_status);
