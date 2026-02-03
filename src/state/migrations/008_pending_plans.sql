-- Migration 008: Pending plans for implementation approval
-- Stores plans that require user approval before execution

CREATE TABLE IF NOT EXISTS pending_plans (
  job_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_plans_created ON pending_plans(created_at);
