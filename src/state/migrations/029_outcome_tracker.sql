-- Outcome tracking for ideas, plans, applications, promotions, improvements
CREATE TABLE IF NOT EXISTS outcome_checks (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK(source_type IN ('idea', 'plan', 'application', 'promotion', 'improvement')),
  source_id TEXT NOT NULL,
  source_title TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  check_at TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'checked', 'skipped')),
  outcome TEXT CHECK(outcome IN ('yes', 'no', 'partial', NULL)),
  outcome_notes TEXT,
  checked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_outcome_checks_status ON outcome_checks(status, check_at);
CREATE INDEX IF NOT EXISTS idx_outcome_checks_source ON outcome_checks(source_type, source_id);
