-- 072: Outcome check cleanup + drop memory_file_snapshots + plan_revision_feedback

-- Auto-expire stale pending outcome checks (>14 days)
UPDATE outcome_checks
  SET status = 'skipped',
      outcome_notes = 'auto-expired: pending >14 days',
      checked_at = datetime('now')
  WHERE status = 'pending'
    AND check_at < datetime('now', '-14 days');

-- Drop memory_file_snapshots (git handles version control)
DROP TABLE IF EXISTS memory_file_snapshots;

-- Drop plan_revision_feedback (0 rows, callers wrapped in try/catch)
DROP TABLE IF EXISTS plan_revision_feedback;
