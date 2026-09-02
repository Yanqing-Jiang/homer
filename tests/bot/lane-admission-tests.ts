/**
 * M3: the non-blocking dispatch must not let two messages from one getUpdates batch
 * reorder or both open a "thinking" indicator.
 */
import "../helpers/no-telegram.js";
import assert from "node:assert/strict";
import test from "node:test";
import { __resetLaneAdmissionForTest, claimLaneAdmission } from "../../src/bot/lane-admission.js";

const LANE = "tg:7758999972";
const idle = () => false;

test("the first dispatch on an idle lane is not queued", () => {
  __resetLaneAdmissionForTest();
  const a = claimLaneAdmission(LANE, idle);
  assert.equal(a.queued, false);
  a.release();
});

test("a second dispatch is queued SYNCHRONOUSLY, before the first reaches startRun", () => {
  __resetLaneAdmissionForTest();
  const a = claimLaneAdmission(LANE, idle);
  // No awaits in between: this is the same tick, exactly as two updates in one batch.
  const b = claimLaneAdmission(LANE, idle);
  assert.equal(a.queued, false);
  assert.equal(b.queued, true, "only one thinking indicator opens");
  a.release();
  b.release();
});

test("an active run makes the first dispatch queued too", () => {
  __resetLaneAdmissionForTest();
  const a = claimLaneAdmission(LANE, () => true);
  assert.equal(a.queued, true);
  a.release();
});

test("dispatches enter startRun in arrival order even when the second is faster", async () => {
  __resetLaneAdmissionForTest();
  const order: string[] = [];
  const a = claimLaneAdmission(LANE, idle);
  const b = claimLaneAdmission(LANE, idle);

  // B skips the thinking indicator (it is queued) and would otherwise reach startRun first.
  const second = (async () => {
    await b.wait;
    order.push("b");
    b.release();
  })();
  const first = (async () => {
    await new Promise<void>((r) => setTimeout(r, 20)); // A's sendThinkingIndicator round trip
    await a.wait;
    order.push("a");
    a.release();
  })();

  await Promise.all([first, second]);
  assert.deepEqual(order, ["a", "b"]);
});

test("a dispatch that never reaches startRun still releases its successors", async () => {
  __resetLaneAdmissionForTest();
  const a = claimLaneAdmission(LANE, idle);
  const b = claimLaneAdmission(LANE, idle);
  a.release(); // the .finally in dispatchExecution, after a thrown handler
  a.release(); // idempotent
  await b.wait;
  b.release();
  assert.ok(true, "did not deadlock");
});

test("lane state is dropped once the last dispatch releases", () => {
  __resetLaneAdmissionForTest();
  const a = claimLaneAdmission(LANE, idle);
  a.release();
  // A fresh claim on the same lane must look idle again, not inherit a stale ticket.
  const b = claimLaneAdmission(LANE, idle);
  assert.equal(b.queued, false);
  b.release();
});

test("lanes do not interfere with each other", () => {
  __resetLaneAdmissionForTest();
  const a = claimLaneAdmission("tg:1", idle);
  const b = claimLaneAdmission("tg:2", idle);
  assert.equal(a.queued, false);
  assert.equal(b.queued, false);
  a.release();
  b.release();
});
