ALTER TABLE plan_executions ADD COLUMN chat_id INTEGER;
ALTER TABLE plan_executions ADD COLUMN summary_text TEXT;
ALTER TABLE plan_executions ADD COLUMN diff_summary TEXT;
ALTER TABLE plan_executions ADD COLUMN integration_status TEXT;
ALTER TABLE plan_executions ADD COLUMN deploy_status TEXT;
ALTER TABLE plan_executions ADD COLUMN snooze_until TEXT;
ALTER TABLE plan_executions ADD COLUMN ready_message_id INTEGER;
ALTER TABLE plan_executions ADD COLUMN ready_notified_at TEXT;
ALTER TABLE plan_executions ADD COLUMN pre_merge_sha TEXT;
ALTER TABLE plan_executions ADD COLUMN pre_merge_tag TEXT;
ALTER TABLE plan_executions ADD COLUMN merged_commit_sha TEXT;
ALTER TABLE plan_executions ADD COLUMN merged_at TEXT;
ALTER TABLE plan_executions ADD COLUMN deploy_started_at TEXT;
ALTER TABLE plan_executions ADD COLUMN deployed_at TEXT;
ALTER TABLE plan_executions ADD COLUMN repair_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plan_executions ADD COLUMN last_error TEXT;
ALTER TABLE plan_executions ADD COLUMN final_notified_at TEXT;

CREATE INDEX IF NOT EXISTS idx_plan_exec_integration_status ON plan_executions(integration_status);
CREATE INDEX IF NOT EXISTS idx_plan_exec_deploy_status ON plan_executions(deploy_status);
CREATE INDEX IF NOT EXISTS idx_plan_exec_snooze_until ON plan_executions(snooze_until)
WHERE snooze_until IS NOT NULL;
