-- Applicant profile for job applications (auto-apply agents read this instead of
-- asking Yanqing per run). Key-value so new form fields need no schema change.
-- Canonical peer of person.application_profile in the tailor-resume ground-truth YAML;
-- update both when a fact changes.
CREATE TABLE IF NOT EXISTS job_application_profile (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
