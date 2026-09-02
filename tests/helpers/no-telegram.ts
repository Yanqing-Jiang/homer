/**
 * Import this FIRST in every test file that can reach daemon code.
 *
 * Telegram long-polling is exclusive. A second getUpdates consumer makes Telegram answer
 * 409 and the live daemon crash-loops — which is what happened on 2026-09-01. The real
 * guard lives in src/bot/index.ts (it refuses to start under NODE_TEST_CONTEXT); this sets
 * the explicit belt-and-braces flag as well, and asserts the guard is reachable.
 */
process.env.HOMER_NO_TELEGRAM = "1";

if (!process.env.NODE_TEST_CONTEXT) {
  throw new Error("no-telegram guard loaded outside the node:test runner; refusing to continue");
}

export const TELEGRAM_DISABLED = true;
