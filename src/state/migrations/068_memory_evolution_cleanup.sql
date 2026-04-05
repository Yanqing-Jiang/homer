-- 068: Memory Evolution Cleanup
-- Fix schema drift in promoted_facts and batch-resolve stale outcome checks.

-- Fix target_file drift: normalize 'tools.md' → 'tools', 'preferences.md' → 'preferences'
UPDATE promoted_facts SET target_file = REPLACE(target_file, '.md', '')
  WHERE target_file LIKE '%.md';

-- Selective outcome cleanup: auto-skip stale promotion/improvement checks (>30 days old)
-- Preserves application/idea/plan follow-ups which have different semantics
UPDATE outcome_checks
  SET status = 'skipped',
      outcome_notes = 'auto-skipped: stale >30 days (memory evolution cleanup)',
      checked_at = datetime('now')
  WHERE status = 'pending'
    AND source_type IN ('promotion', 'improvement')
    AND check_at < datetime('now', '-30 days');
