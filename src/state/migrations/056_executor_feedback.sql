-- Executor feedback: persistent execution tracking for adaptive routing
CREATE TABLE IF NOT EXISTS executor_feedback (
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL,
  executor TEXT NOT NULL,
  model TEXT,
  success INTEGER NOT NULL,
  duration_ms INTEGER,
  error_category TEXT,
  prompt_tokens INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_executor_feedback_lookup
  ON executor_feedback(task_type, executor, created_at);
