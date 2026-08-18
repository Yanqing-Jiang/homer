-- Roles Yanqing has already applied to, been rejected from, or explicitly
-- dismissed. Keyed by digest key (normalized company|title, no state bucket,
-- legal suffixes stripped) so re-cut requisitions of the same role stay
-- suppressed permanently across posting ids and states.
CREATE TABLE IF NOT EXISTS job_scan_dismissals (
  digest_key TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'dismissed',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
