import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RotatingLogSink } from "../../scripts/log-sink.mjs";

test("sink follows an external rename and keeps writing to the canonical path", () => {
  const dir = mkdtempSync(join(tmpdir(), "log-sink-")); const path = join(dir, "stdout.log");
  let now = 0; const sink = new RotatingLogSink(path, { statEveryMs: 0, now: () => now });
  try {
    sink.write("one\n");
    renameSync(path, `${path}.0`);           // what newsyslog does
    now += 10; sink.write("two\n");
    assert.equal(readFileSync(`${path}.0`, "utf8"), "one\n");
    assert.equal(readFileSync(path, "utf8"), "two\n");
  } finally { sink.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("sink rotates itself at maxBytes and keeps a bounded number of generations", () => {
  const dir = mkdtempSync(join(tmpdir(), "log-sink-")); const path = join(dir, "stdout.log");
  const sink = new RotatingLogSink(path, { maxBytes: 8, keep: 2, statEveryMs: 0 });
  try {
    for (const line of ["aaaa\n", "bbbb\n", "cccc\n", "dddd\n"]) sink.write(line);
    assert.equal(readFileSync(path, "utf8"), "dddd\n");
    assert.equal(readFileSync(`${path}.1`, "utf8"), "cccc\n");
    assert.equal(readFileSync(`${path}.2`, "utf8"), "bbbb\n");
    assert.equal(existsSync(`${path}.3`), false);
  } finally { sink.close(); rmSync(dir, { recursive: true, force: true }); }
});
