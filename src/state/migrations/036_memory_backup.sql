-- Full session transcripts (raw parsed messages, no truncation)
CREATE TABLE IF NOT EXISTS session_transcripts (
  content_hash TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  messages_json TEXT NOT NULL,
  native_file_path TEXT,
  source_mtime_ms INTEGER,
  model TEXT,
  project TEXT,
  started_at TEXT,
  ended_at TEXT,
  message_count INTEGER NOT NULL,
  uncompressed_size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Point-in-time snapshots of ~/memory/ files
CREATE TABLE IF NOT EXISTS memory_file_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  reason TEXT NOT NULL,
  job_run_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(file_name, snapshot_date, reason)
);

-- Audit trail for DB backup runs
CREATE TABLE IF NOT EXISTS backup_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  backup_type TEXT NOT NULL,
  backup_path TEXT NOT NULL,
  db_size_bytes INTEGER NOT NULL,
  backup_size_bytes INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  integrity_check TEXT NOT NULL,
  retention_tier TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Generic job artifact storage (LLM outputs, decision trails)
CREATE TABLE IF NOT EXISTS job_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_run_id INTEGER NOT NULL,
  job_name TEXT NOT NULL,
  stage TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_session_transcripts_agent ON session_transcripts(agent);
CREATE INDEX IF NOT EXISTS idx_session_transcripts_started ON session_transcripts(started_at);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_file ON memory_file_snapshots(file_name, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_backup_runs_type ON backup_runs(backup_type, created_at);
CREATE INDEX IF NOT EXISTS idx_job_artifacts_run ON job_artifacts(job_run_id);
CREATE INDEX IF NOT EXISTS idx_job_artifacts_job ON job_artifacts(job_name, created_at);
