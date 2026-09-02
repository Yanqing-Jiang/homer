/**
 * Which armed one-shot retries this cycle should fire. Pure, so the dedup window and the
 * per-cycle cap are testable without instantiating a Scheduler.
 *
 * A `deferred` outcome arms `retry_at` in the same transaction that releases the run lock.
 * `getDueRetries` already excludes a running or disabled job; this adds the two guards
 * `compensateMissedFires` has.
 *
 * The dedup window MUST exceed the cycle period, or it cannot suppress anything: at 5 minutes
 * against a 10-minute cycle every armed retry was always outside the window and re-fired on
 * every cycle, so the storm bound this docstring used to claim did not exist. It also dedups on
 * the last TRIGGER, not the last run start: `fireDueRetries` records a trigger for every retry
 * it fires, so a retry that never reaches `recordScheduledJobStart` — the exact case the guard
 * is for — is still seen and still suppressed.
 */
export const RETRY_CYCLE_MS = 10 * 60 * 1000;
export const RETRY_DEDUP_WINDOW_MS = RETRY_CYCLE_MS + 5 * 60 * 1000;
export const MAX_RETRIES_PER_CYCLE = 5;

export interface ArmedRetry {
  jobId: string;
  retryAt: string;
  retryReason: string | null;
}

export function selectRetriesToFire(
  due: readonly ArmedRetry[],
  opts: {
    now: number;
    /**
     * The most recent of the job's last start and its last TRIGGER, or null when neither has
     * happened. A trigger that never became a start must still count, or the dedup guard is
     * blind to precisely the failure it exists to bound.
     */
    lastRunAt: (jobId: string) => string | null | undefined;
    /** False for a job that is not registered or is disabled. */
    isFireable: (jobId: string) => boolean;
    dedupWindowMs?: number;
    cap?: number;
  },
): ArmedRetry[] {
  const dedup = opts.dedupWindowMs ?? RETRY_DEDUP_WINDOW_MS;
  const cap = opts.cap ?? MAX_RETRIES_PER_CYCLE;
  const out: ArmedRetry[] = [];
  for (const row of due) {
    if (out.length >= cap) break;
    if (!opts.isFireable(row.jobId)) continue;
    const last = opts.lastRunAt(row.jobId);
    if (last) {
      const lastMs = Date.parse(last);
      if (Number.isFinite(lastMs) && opts.now - lastMs < dedup) continue;
    }
    out.push(row);
  }
  return out;
}

/**
 * Restart retry for a job cut down by a daemon restart.
 *
 * `cleanupOrphanedJobRuns` only flips the run row; nothing armed a wake-up, so an ABVP run
 * killed mid-download rested until the next weekly cron, where `decideResume` found a stale
 * slot and superseded it — a lost week with zero Telegram. A job with a durable, resumable run
 * state gets one scheduler-owned re-fire shortly after boot instead. Its own ceilings still
 * apply on that tick (`run_attempts`, deferrals, the slot budget), so this cannot loop.
 *
 * Scoped by handler on purpose: only ABVP keeps a run state a restart can resume. Widening
 * it to every internal job would re-fire nightly batch work five minutes after every deploy.
 */
export const RESTART_RETRY_DELAY_MS = 5 * 60 * 1000;
export const RESTART_RETRY_REASON = "daemon_restart";
export const RESTART_RETRY_HANDLERS: ReadonlySet<string> = new Set(["abvp_refresh"]);

export function selectRestartRetries(
  orphanedJobIds: readonly string[],
  jobs: ReadonlyArray<{ id: string; handler?: string; enabled: boolean }>,
): string[] {
  const orphaned = new Set(orphanedJobIds);
  return jobs
    .filter((j) => orphaned.has(j.id) && j.enabled && j.handler !== undefined && RESTART_RETRY_HANDLERS.has(j.handler))
    .map((j) => j.id);
}
