-- Application tracker for the /auto-apply pipeline: one row per position applied to.
-- Doubles as the duplicate-apply guard (Phase 1a checks url/folder before starting).
CREATE TABLE IF NOT EXISTS job_applications (
  url TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  role TEXT NOT NULL,
  folder TEXT NOT NULL,            -- per-application dir under ~/Desktop/job-applications/
  status TEXT NOT NULL,            -- tailored | submitted | blocked | skipped
  submitted_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
