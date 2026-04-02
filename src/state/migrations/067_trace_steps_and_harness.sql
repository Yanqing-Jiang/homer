-- Phase 2A: Add per-step tracing and code version tracking to execution_traces.
-- Phase 4A: Add harness versioning and evaluation scoring tables.

-- Extend traces for per-step instrumentation
ALTER TABLE execution_traces ADD COLUMN trace_kind TEXT DEFAULT 'job';
ALTER TABLE execution_traces ADD COLUMN step_name TEXT;
ALTER TABLE execution_traces ADD COLUMN prompt_hash TEXT;
ALTER TABLE execution_traces ADD COLUMN git_commit TEXT;

-- Harness version tracking: what prompt/config was active for a job
CREATE TABLE IF NOT EXISTS job_harness_versions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'candidate' | 'archived' | 'rolled_back'
  prompt_manifest TEXT,                    -- JSON: section_name -> content_hash
  config_manifest TEXT,                    -- JSON: evolvable config fields
  source_hash TEXT,                        -- SHA-256 of the job handler source file
  parent_version_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  created_by TEXT DEFAULT 'migration'      -- 'human' | 'proposer' | 'migration'
);

CREATE INDEX IF NOT EXISTS idx_harness_job_status ON job_harness_versions(job_id, status);
CREATE INDEX IF NOT EXISTS idx_harness_job_version ON job_harness_versions(job_id, version);

-- Per-run evaluation scores linked to harness version
CREATE TABLE IF NOT EXISTS job_eval_scores (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,                    -- links to execution_traces.chain_id or scheduled_job_runs.id
  job_id TEXT NOT NULL,
  harness_version_id TEXT,                 -- links to job_harness_versions.id
  score_name TEXT NOT NULL,                -- e.g. 'critique_pass_rate', 'packet_yield'
  score_value REAL NOT NULL,
  score_components TEXT,                   -- JSON breakdown
  label_source TEXT DEFAULT 'automatic',   -- 'automatic' | 'human' | 'downstream'
  scored_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_eval_job_score ON job_eval_scores(job_id, score_name, scored_at);
CREATE INDEX IF NOT EXISTS idx_eval_run ON job_eval_scores(run_id);
CREATE INDEX IF NOT EXISTS idx_eval_harness ON job_eval_scores(harness_version_id);

-- Link execution traces to harness version
ALTER TABLE execution_traces ADD COLUMN harness_version_id TEXT;
