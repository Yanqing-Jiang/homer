/**
 * Telegram long-polling health.
 *
 * 2026-09-01 19:41Z: a second getUpdates consumer appeared, Telegram answered the live
 * daemon's poll with `409 Conflict: terminated by other getUpdates request`, grammy
 * rejected `bot.start()`, and because that call was the last awaited statement in main()
 * the rejection reached `main().catch` → `process.exit(1)`. One recoverable, self-clearing
 * Telegram condition took down the scheduler, memory, telephony and every job — and,
 * because that exit path runs no shutdown tasks, orphaned the resident Chrome, which then
 * made all 63 supervisor restarts fail.
 *
 * A polling failure now degrades the BOT: log it, publish the flag below, back off, retry.
 * Split into its own module so the classification and the flag can be read (and tested)
 * without importing the whole bot, which needs live Telegram config to load.
 */

/** Backoff for polling restarts: 5s, 15s, 1m, then 5m forever. */
export const TELEGRAM_POLL_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const;

export function telegramPollBackoffMs(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1) - 1, TELEGRAM_POLL_BACKOFF_MS.length - 1);
  return TELEGRAM_POLL_BACKOFF_MS[index]!;
}

/** True for Telegram's 409 — another getUpdates consumer took the stream. */
export function isTelegramConflict(error: unknown): boolean {
  return (error as { error_code?: unknown } | null)?.error_code === 409;
}

export function describeTelegramError(error: unknown): string {
  const err = error as { error_code?: unknown; description?: unknown } | null;
  if (err && typeof err.error_code === "number") {
    return `Telegram ${err.error_code}: ${String(err.description ?? "")}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The "polling recovered" ping is for an outage, not for a blip. The MFA relay's `auto`
 * source issues one zero-timeout getUpdates per ask, which 409s the daemon exactly once;
 * that clears on the first 5 s retry and used to produce a spurious 🟡 every time. A
 * recovery is announced only after at least two consecutive failures or a minute down.
 */
export const POLLING_RECOVERY_PING_MIN_FAILURES = 2;
export const POLLING_RECOVERY_PING_MIN_DOWN_MS = 60_000;

export function shouldAnnouncePollingRecovery(input: { failures: number; downMs: number }): boolean {
  if (input.failures <= 0) return false;
  return input.failures >= POLLING_RECOVERY_PING_MIN_FAILURES || input.downMs >= POLLING_RECOVERY_PING_MIN_DOWN_MS;
}

export interface TelegramPollingStatus {
  healthy: boolean;
  reason: string | null;
  /** ISO timestamp of the last state change. */
  since: string | null;
  consecutiveFailures: number;
  /**
   * N14: the initial state is neither healthy nor a fault. A daemon started without a bot
   * token never leaves it, and every daemon passes through it between start and the first
   * `onStart` — reporting DEGRADED for either was a permanent false alarm in `/status` and
   * a permanent 🟡 in the health check. Consumers must treat this as "nothing to say".
   */
  state: "not-started" | "healthy" | "degraded" | "stopped";
}

const INITIAL: TelegramPollingStatus = {
  healthy: false, reason: null, since: null, consecutiveFailures: 0, state: "not-started",
};
let status: TelegramPollingStatus = { ...INITIAL };
let pollingWanted = true;

export function setTelegramPollingStatus(
  next: Omit<TelegramPollingStatus, "since" | "state"> & { since?: string; state?: TelegramPollingStatus["state"] },
): void {
  status = {
    ...next,
    since: next.since ?? new Date().toISOString(),
    state: next.state ?? (next.healthy ? "healthy" : "degraded"),
  };
}

/** Called when the daemon deliberately runs without Telegram (no token configured). */
export function markTelegramDisabled(): void {
  status = { healthy: false, reason: "telegram disabled (no token configured)", since: new Date().toISOString(), consecutiveFailures: 0, state: "not-started" };
}

/** Read by /status and the health check so a degraded bot is visible instead of silent. */
export function getTelegramPollingStatus(): TelegramPollingStatus {
  return { ...status };
}

/** Called from the shutdown path so the retry loop does not resurrect a stopping bot. */
export function stopTelegramPolling(): void {
  pollingWanted = false;
}

export function telegramPollingWanted(): boolean {
  return pollingWanted;
}
