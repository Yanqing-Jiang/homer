-- 132: Scheduler-owned deferred outcome and one-shot retry.
--
-- A job may now finish in a third state beside success and failure: `deferred`,
-- meaning "did not run to completion because a resource it needs was held, retry at
-- retry_at". ABVP is the first producer (download-architecture-refactor v2, ship-order
-- step 4). A deferral must not write last_success_at, must not reset or increment
-- consecutive_failures, must not fire success dependencies, and must not trigger
-- failure takeover or the circuit breaker -- so it needs its own row value rather than
-- being squeezed into the success boolean.
--
-- retry_at lives beside next_run_at because it is the same kind of fact: when the
-- scheduler should next fire this job. It is one-shot -- cleared when the job starts --
-- and is reconciled on daemon startup and every compensation cycle, so it survives a
-- restart.
ALTER TABLE scheduled_job_runs ADD COLUMN outcome TEXT;
ALTER TABLE scheduled_job_state ADD COLUMN retry_at TEXT;
ALTER TABLE scheduled_job_state ADD COLUMN retry_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_scheduled_job_state_retry_at
  ON scheduled_job_state(retry_at)
  WHERE retry_at IS NOT NULL;
