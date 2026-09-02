/**
 * Telegram polling degradation: a 409 must be classified, described and backed off —
 * never turned into a daemon exit. Imports only the health module, so nothing here can
 * construct a Bot or open a poller.
 */
import "../helpers/no-telegram.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  TELEGRAM_POLL_BACKOFF_MS,
  describeTelegramError,
  getTelegramPollingStatus,
  isTelegramConflict,
  markTelegramDisabled,
  setTelegramPollingStatus,
  stopTelegramPolling,
  shouldAnnouncePollingRecovery,
  telegramPollBackoffMs,
  telegramPollingWanted,
} from "../../src/bot/polling-health.js";

/** The exact payload grammy surfaced at 19:41:05Z on 2026-09-01. */
const CONFLICT = {
  method: "getUpdates",
  ok: false,
  name: "GrammyError",
  error_code: 409,
  description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
};

test("the live 409 payload is recognised as a conflict", () => {
  assert.equal(isTelegramConflict(CONFLICT), true);
  assert.equal(isTelegramConflict({ error_code: 429 }), false);
  assert.equal(isTelegramConflict(new Error("socket hang up")), false);
  assert.equal(isTelegramConflict(null), false);
});

test("errors are described without losing the Telegram code", () => {
  assert.match(describeTelegramError(CONFLICT), /^Telegram 409: Conflict: terminated by other getUpdates/);
  assert.equal(describeTelegramError(new Error("socket hang up")), "socket hang up");
  assert.equal(describeTelegramError("boom"), "boom");
});

test("backoff climbs and then holds at the last step forever", () => {
  assert.equal(telegramPollBackoffMs(1), TELEGRAM_POLL_BACKOFF_MS[0]);
  assert.equal(telegramPollBackoffMs(2), TELEGRAM_POLL_BACKOFF_MS[1]);
  assert.equal(telegramPollBackoffMs(4), TELEGRAM_POLL_BACKOFF_MS[3]);
  assert.equal(telegramPollBackoffMs(99), TELEGRAM_POLL_BACKOFF_MS[3], "never gives up, never spins");
  assert.equal(telegramPollBackoffMs(0), TELEGRAM_POLL_BACKOFF_MS[0], "attempt counting starts at 1");
});

// N14: "not started" is neither healthy nor a fault. A token-less daemon stays there
// forever and every daemon passes through it before its first onStart; reporting DEGRADED
// for either was a permanent false alarm in /status and a permanent 🟡 in the health check.
test("the initial and disabled states are not-started, not degraded", () => {
  assert.equal(getTelegramPollingStatus().state, "not-started");
  markTelegramDisabled();
  const disabled = getTelegramPollingStatus();
  assert.equal(disabled.state, "not-started");
  assert.equal(disabled.healthy, false);
  assert.match(disabled.reason ?? "", /disabled/);
});

test("the status flag records the degradation instead of the daemon exiting", () => {
  setTelegramPollingStatus({ healthy: false, reason: describeTelegramError(CONFLICT), consecutiveFailures: 3 });
  const status = getTelegramPollingStatus();
  assert.equal(status.healthy, false);
  assert.equal(status.state, "degraded", "a real failure IS degraded");
  assert.equal(status.consecutiveFailures, 3);
  assert.match(status.reason ?? "", /409/);
  assert.ok(status.since && !Number.isNaN(Date.parse(status.since)));

  setTelegramPollingStatus({ healthy: true, reason: null, consecutiveFailures: 0 });
  assert.equal(getTelegramPollingStatus().healthy, true);
  assert.equal(getTelegramPollingStatus().state, "healthy");

  setTelegramPollingStatus({ healthy: false, reason: "polling stopped", consecutiveFailures: 0, state: "stopped" });
  assert.equal(getTelegramPollingStatus().state, "stopped", "a deliberate stop is not a fault either");
});

test("a deliberate stop ends the retry loop", () => {
  assert.equal(telegramPollingWanted(), true);
  stopTelegramPolling();
  assert.equal(telegramPollingWanted(), false);
});

// The relay's `auto` source 409s the daemon once per MFA ask; that single failure clears on
// the first 5 s retry and must not page as a "recovery".
test("a single 409 that clears on the first retry is not announced as a recovery", () => {
  assert.equal(shouldAnnouncePollingRecovery({ failures: 1, downMs: 5_000 }), false);
  assert.equal(shouldAnnouncePollingRecovery({ failures: 0, downMs: 0 }), false, "no failure, nothing to recover from");
});

test("a real outage is announced — two consecutive failures, or a minute down", () => {
  assert.equal(shouldAnnouncePollingRecovery({ failures: 2, downMs: 20_000 }), true);
  assert.equal(shouldAnnouncePollingRecovery({ failures: 1, downMs: 61_000 }), true, "one failure that took a minute to clear is still an outage");
  assert.equal(shouldAnnouncePollingRecovery({ failures: 7, downMs: 0 }), true);
});
