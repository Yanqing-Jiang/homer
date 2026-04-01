-- Unified execution traces: captures every sub-agent invocation across scheduler and router paths.
-- Each row = one attempt in a fallback chain. chain_id groups attempts from the same run.

CREATE TABLE IF NOT EXISTS execution_traces (
  id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  job_id TEXT,
  source TEXT NOT NULL DEFAULT 'scheduler',
  executor TEXT NOT NULL,
  model TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  exit_code INTEGER,
  error_type TEXT,
  error_summary TEXT,
  fallback_used INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_exec_traces_chain ON execution_traces(chain_id);
CREATE INDEX IF NOT EXISTS idx_exec_traces_job ON execution_traces(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_exec_traces_executor ON execution_traces(executor, success, created_at);
CREATE INDEX IF NOT EXISTS idx_exec_traces_created ON execution_traces(created_at);
