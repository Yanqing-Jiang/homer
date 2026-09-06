import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporary = mkdtempSync(join(tmpdir(), "homer-schedule-watch-"));
const file = join(temporary, "schedule.json");
process.env.WORK_SCHEDULE_FILE = file;
const { ScheduleWatcher } = await import("../../src/scheduler/loader.js");

const schedule = (name: string) => JSON.stringify({ jobs: [{ id: "watcher-regression", name, cron: "15 4 * * *", query: "Collect sources", executor: "codex" }] });

test("schedule reload survives repeated atomic replacement and rejects malformed files", async () => {
  writeFileSync(file, schedule("original"));
  const names: string[] = [];
  const watcher = new ScheduleWatcher(schedules => {
    const job = schedules.flatMap(s => s.jobs).find(j => j.id === "watcher-regression");
    if (job) names.push(job.name ?? "");
  });
  const waitUntil = async (expected: string) => {
    const deadline = Date.now() + 5000;
    while (!names.includes(expected) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    assert.ok(names.includes(expected), `did not observe ${expected}`);
  };
  const replace = (text: string) => {
    writeFileSync(file + ".tmp", text);
    renameSync(file + ".tmp", file);
  };
  try {
    await watcher.start();
    replace(schedule("first replacement"));
    await waitUntil("first replacement");
    replace(schedule("second replacement"));
    await waitUntil("second replacement");
    const before = names.length;
    replace("{");
    await new Promise(r => setTimeout(r, 1400));
    assert.equal(names.length, before, "malformed schedule must preserve the current cron set");
    replace(schedule("recovered"));
    await waitUntil("recovered");
  } finally {
    watcher.stop();
    rmSync(temporary, { recursive: true, force: true });
  }
});
