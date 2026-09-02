/**
 * Per-lane admission for non-blocking Telegram dispatch.
 *
 * grammy's built-in long polling handles updates sequentially, so awaiting an executor
 * turn inside the handler froze the whole chat. Dispatch is now fire-and-forget — but that
 * moved two decisions off the synchronous path:
 *
 *  - "is something already running on this lane?" was read from `CLIRunManager.getActiveRun`,
 *    which only becomes true inside `startRun`, several awaits later. Two messages from one
 *    getUpdates batch both saw an idle lane, so both opened a streaming draft and a typing
 *    loop.
 *  - lane order was then decided by whichever `sendThinkingIndicator` round trip returned
 *    first, not by arrival order.
 *
 * A ticket is claimed here SYNCHRONOUSLY at dispatch, before any await, so `queued` is
 * correct immediately and each dispatch enters `startRun` only after its predecessor has.
 * The wait is bounded by the predecessor's pre-run work (one Telegram round trip), never by
 * its turn — the poller is not involved either way.
 *
 * DEBT (N11): `wait` has no timeout. It resolves only when the predecessor calls `release()`,
 * and the predecessor's pre-run work (`sendThinkingIndicator`, `loadBootstrapFiles`) runs
 * before its release with no client-side timeout on grammy's `bot.api`, so a hung socket
 * parks every later message on that lane indefinitely. Not a regression — the poller itself
 * used to block on the whole turn — but it is a new place to wedge. Upgrade to a timeout race
 * on `wait` if a lane is ever observed stuck with no active run.
 */

export interface LaneAdmission {
  /** True when something already holds or is claiming this lane. Decided synchronously. */
  queued: boolean;
  /** Resolves once the predecessor dispatch has entered startRun (or given up). */
  wait: Promise<void>;
  /** Idempotent. Call once startRun has been reached, and again on any exit path. */
  release: () => void;
}

const laneTail = new Map<string, Promise<void>>();
const laneDepth = new Map<string, number>();

export function claimLaneAdmission(lane: string, hasActiveRun: (lane: string) => boolean): LaneAdmission {
  const depth = laneDepth.get(lane) ?? 0;
  laneDepth.set(lane, depth + 1);
  const prior = laneTail.get(lane) ?? Promise.resolve();
  let signal!: () => void;
  const mine = new Promise<void>((resolve) => { signal = resolve; });
  // Settled or rejected, the predecessor must not strand its successors.
  const tail = prior.then(() => mine, () => mine);
  laneTail.set(lane, tail);

  let released = false;
  return {
    queued: depth > 0 || hasActiveRun(lane),
    wait: prior,
    release: () => {
      if (released) return;
      released = true;
      signal();
      const remaining = (laneDepth.get(lane) ?? 1) - 1;
      if (remaining <= 0) {
        laneDepth.delete(lane);
        // Drop the chain entry only when nothing is queued behind it, so the maps cannot
        // grow one permanent entry per lane.
        if (laneTail.get(lane) === tail) laneTail.delete(lane);
      } else {
        laneDepth.set(lane, remaining);
      }
    },
  };
}

/** Test seam: forget all lane state. Never called from the daemon. */
export function __resetLaneAdmissionForTest(): void {
  laneTail.clear();
  laneDepth.clear();
}
