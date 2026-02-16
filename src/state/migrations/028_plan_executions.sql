-- Track plan execution attempts and outcomes
CREATE TABLE IF NOT EXISTS plan_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  plan_text TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',  -- running | success | build_failed | error
  executor_output TEXT,
  build_output TEXT,
  files_changed TEXT,                       -- JSON array of file paths
  user_instructions TEXT,                   -- appended via "Add Instructions" button
  started_at TEXT DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_plan_exec_job ON plan_executions(job_id);
CREATE INDEX IF NOT EXISTS idx_plan_exec_status ON plan_executions(status);
CREATE INDEX IF NOT EXISTS idx_plan_exec_date ON plan_executions(started_at);
