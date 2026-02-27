-- Migration 042: Process Lifecycle Management
-- Track HOMER-spawned processes, cleanup audit trail, and investigation rate limits.

CREATE TABLE IF NOT EXISTS managed_processes (
  pid INTEGER PRIMARY KEY,
  pgid INTEGER,
  command TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'executor',
  spawned_at INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL,
  last_activity INTEGER NOT NULL,
  source TEXT NOT NULL,
  run_id TEXT,
  job_id TEXT,
  settled INTEGER NOT NULL DEFAULT 0,
  settled_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_managed_processes_active
  ON managed_processes(settled) WHERE settled = 0;

CREATE TABLE IF NOT EXISTS process_cleanup_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  trigger TEXT NOT NULL,
  processes_scanned INTEGER NOT NULL DEFAULT 0,
  processes_killed INTEGER NOT NULL DEFAULT 0,
  processes_spared INTEGER NOT NULL DEFAULT 0,
  details TEXT
);

CREATE TABLE IF NOT EXISTS investigation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  executor_used TEXT,
  success INTEGER,
  output_path TEXT
);
