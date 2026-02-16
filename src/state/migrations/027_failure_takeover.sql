-- Failure takeover runs: Claude Code sessions that diagnose and retry failed jobs
CREATE TABLE IF NOT EXISTS failure_takeover_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_run_id INTEGER NOT NULL REFERENCES scheduled_job_runs(id),
  job_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  decision TEXT NOT NULL,       -- 'retry' | 'fix_and_retry' | 'report'
  diagnosis TEXT NOT NULL,
  fix_description TEXT,
  takeover_output TEXT,         -- full output (stored but NOT FTS-indexed)
  retry_success INTEGER,        -- NULL if report, 0/1 if retry attempted
  duration_ms INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_takeover_job_id ON failure_takeover_runs(job_id);
CREATE INDEX IF NOT EXISTS idx_takeover_created ON failure_takeover_runs(created_at);

-- FTS5 on structured fields ONLY (not raw output)
CREATE VIRTUAL TABLE IF NOT EXISTS failure_takeover_fts USING fts5(
  job_id, diagnosis, fix_description,
  content='failure_takeover_runs', content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Auto-sync triggers (same pattern as 026)
CREATE TRIGGER IF NOT EXISTS failure_takeover_ai AFTER INSERT ON failure_takeover_runs BEGIN
  INSERT INTO failure_takeover_fts(rowid, job_id, diagnosis, fix_description)
  VALUES (new.rowid, new.job_id, new.diagnosis, new.fix_description);
END;

CREATE TRIGGER IF NOT EXISTS failure_takeover_ad AFTER DELETE ON failure_takeover_runs BEGIN
  INSERT INTO failure_takeover_fts(failure_takeover_fts, rowid, job_id, diagnosis, fix_description)
  VALUES ('delete', old.rowid, old.job_id, old.diagnosis, old.fix_description);
END;

CREATE TRIGGER IF NOT EXISTS failure_takeover_au AFTER UPDATE ON failure_takeover_runs BEGIN
  INSERT INTO failure_takeover_fts(failure_takeover_fts, rowid, job_id, diagnosis, fix_description)
  VALUES ('delete', old.rowid, old.job_id, old.diagnosis, old.fix_description);
  INSERT INTO failure_takeover_fts(rowid, job_id, diagnosis, fix_description)
  VALUES (new.rowid, new.job_id, new.diagnosis, new.fix_description);
END;
