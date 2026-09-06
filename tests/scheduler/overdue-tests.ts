import assert from "node:assert/strict";
import test from "node:test";
import { CronUtils } from "../../src/utils/cron.js";

process.env.TZ = "America/Los_Angeles";
const overdue = (cron: string, last: string, now: string, minutes = 30) =>
  CronUtils.isOverdue(cron, new Date(last), new Date(now), minutes * 60_000);

test("actual scanner alert at 03:50 PT is inside its scheduled overnight pause", () => {
  assert.equal(overdue("0 7,12,17 * * *", "2026-09-04T17:08:50-07:00", "2026-09-05T03:50:00-07:00"), false);
});

test("actual YouTube alert at 17:50 PT is inside its scheduled daytime pause", () => {
  assert.equal(overdue("0 20,23,2,5 * * *", "2026-09-04T05:00:02-07:00", "2026-09-04T17:50:00-07:00", 20), false);
});

test("two missed scanner opportunities plus timeout still alert", () => {
  assert.equal(overdue("0 7,12,17 * * *", "2026-09-04T17:08:50-07:00", "2026-09-05T12:30:00-07:00"), false);
  assert.equal(overdue("0 7,12,17 * * *", "2026-09-04T17:08:50-07:00", "2026-09-05T12:30:01-07:00"), true);
});

test("weekend pause and spring DST use calendar occurrences", () => {
  assert.equal(overdue("0 7 * * 1-5", "2026-03-06T07:02:00-08:00", "2026-03-09T06:59:00-07:00"), false);
  assert.equal(overdue("0 7 * * 1-5", "2026-03-06T07:02:00-08:00", "2026-03-10T07:31:00-07:00"), true);
});

test("invalid timestamp or cron does not invent an overdue deadline", () => {
  assert.equal(overdue("invalid", "2026-09-04T00:00:00Z", "2026-09-05T00:00:00Z"), false);
  assert.equal(overdue("0 * * * *", "invalid", "2026-09-05T00:00:00Z"), false);
});
