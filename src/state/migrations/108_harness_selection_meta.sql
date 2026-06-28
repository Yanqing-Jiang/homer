-- 108_harness_selection_meta — durable marker for the internal-baseline seed-once guard.
--
-- The harness-independence cutover seeds INTERNAL_JOB_HARNESS_BASELINES into harness_selection
-- as job-scope rows ONCE (so deliberate per-job tuning is preserved + visible in the Jobs tab,
-- while a global "switch all" can still move everything). The seed is guarded by a marker row
-- here so that after a user does switch-all (clearing the job rows), a daemon restart can NEVER
-- silently re-seed them. Seed predicate is marker-existence-only.
--
-- No widening of harness_selection / harness_audit CHECK constraints is needed: seed rows use the
-- already-allowed source='runtime', and the marker lives in this side table — so no table rebuild.

CREATE TABLE IF NOT EXISTS harness_selection_meta (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
