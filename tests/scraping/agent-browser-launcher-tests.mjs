import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ab-launcher-"));
const binary = join(dir, "fake");
writeFileSync(binary, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n', { mode: 0o700 });
const env = { ...process.env, HOMER_AGENT_BROWSER_BIN: binary, HOMER_BROWSER_SURFACE: "agent.test", AGENT_BROWSER_SESSION: "test", AGENT_BROWSER_CDP: "9601", AGENT_BROWSER_PIN_TAB: "1", AGENT_BROWSER_SOCKET_DIR: dir };
function run(args, overrides = {}) {
  return spawnSync("/usr/bin/perl", ["-e", "alarm 60; exec @ARGV", process.execPath, "bin/agent-browser", ...args], { env: { ...env, ...overrides }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
}
test.after(() => rmSync(dir, { recursive: true, force: true }));
test("launcher requires a lease, but help and version always pass through", () => {
  const denied = run(["snapshot"], { HOMER_BROWSER_SURFACE: "", AGENT_BROWSER_SESSION: "" });
  assert.equal(denied.status, 2); assert.match(denied.stderr, /use browserctl agent/);
  for (const arg of ["--version", "--help"]) assert.equal(run([arg], { HOMER_BROWSER_SURFACE: "" }).status, 0);
});
test("launcher refuses commands and flags that change session, endpoint, profile or tab", () => {
  for (const args of [["connect", "9602"], ["--cdp", "9602", "snapshot"], ["snapshot", "--cdp=9602"], ["--session", "other", "snapshot"], ["--session=other", "snapshot"], ["--profile", "/tmp/profile", "open", "about:blank"], ["--no-pin-tab", "snapshot"], ["--pin-tab=false", "snapshot"], ["tab", "new"], ["tab", "switch", "1"], ["tab", "close"], ["tab", "target-id"]]) {
    const result = run(args); assert.equal(result.status, 2, args.join(" ")); assert.match(result.stderr, /isolation/);
  }
});
test("launcher exec passes ordinary commands and matching flags unchanged", () => {
  for (const args of [["--session", "test", "--cdp", "9601", "--pin-tab", "snapshot"], ["tab", "list"], ["fill", "@e1", "connect"], ["get", "url"]]) {
    const result = run(args); assert.equal(result.status, 0, result.stderr); assert.deepEqual(result.stdout.trim().split("\n"), args);
  }
});
