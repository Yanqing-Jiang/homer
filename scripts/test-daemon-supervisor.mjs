#!/usr/bin/env node

import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(tmpdir(), "homer-supervisor-test-"));
const pidFile = path.join(temp, "pids");
const runtimeStamp = path.join(temp, "daemon-build.json");
const diskBuild = path.join(temp, ".build-version");
const requestFile = path.join(temp, "restart.request");
const sentinelFile = path.join(temp, "daemon.draining");
const policyState = path.join(temp, "policy-result");
const policyHelper = path.join(temp, "policy.sh");
const build = {
  sha: "test", dirty: false, builtAt: "2026-07-18T00:00:00.000Z",
  sourceFingerprint: "fixture", maxSourceMtimeMs: 1,
};

await writeFile(diskBuild, `${JSON.stringify(build)}\n`);
await writeFile(policyState, "allow\n");
await writeFile(policyHelper, `#!/bin/bash
result="$(cat "${policyState}")"
case "$result" in
  allow) echo '{"version":1,"result":"allow","reason":"idle","blockers":{}}'; exit 0 ;;
  defer) echo '{"version":1,"result":"defer","reason":"active_work","blockers":{"cli_runs":1}}'; exit 10 ;;
  noop_same_build) echo '{"version":1,"result":"noop_same_build","reason":"runtime_matches_dist","blockers":{}}'; exit 11 ;;
  *) echo '{"version":1,"result":"policy_error","reason":"test_error","blockers":{}}'; exit 20 ;;
esac
`);
await chmod(policyHelper, 0o755);

let healthy = true;
const healthServer = createServer((_request, response) => {
  response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: healthy ? "healthy" : "failed" }));
});
await new Promise((resolve) => healthServer.listen(0, "127.0.0.1", resolve));
const address = healthServer.address();
const fixture = `
  const fs = require("node:fs");
  const build = JSON.parse(process.env.TEST_BUILD);
  fs.appendFileSync(process.env.TEST_PID_FILE, process.pid + "\\n");
  fs.writeFileSync(process.env.HOMER_RUNTIME_STAMP, JSON.stringify({ pid: process.pid, build }));
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
`;

const supervisor = spawn(process.execPath, [
  path.join(root, "scripts", "daemon-supervisor.mjs"), process.execPath, "-e", fixture,
], {
  cwd: root,
  env: {
    ...process.env,
    TEST_PID_FILE: pidFile,
    TEST_BUILD: JSON.stringify(build),
    HOMER_HEALTH_URL: `http://127.0.0.1:${address.port}/health`,
    HOMER_HEALTH_GRACE_MS: "100",
    HOMER_HEALTH_INTERVAL_MS: "180",
    HOMER_HEALTH_TIMEOUT_MS: "100",
    HOMER_HEALTH_FAILURE_LIMIT: "3",
    HOMER_RESTART_POLL_MS: "500",
    HOMER_READINESS_TIMEOUT_MS: "2500",
    HOMER_STABLE_RUNTIME_MS: "5000",
    HOMER_MAX_RESTART_BACKOFF_MS: "200",
    HOMER_SHUTDOWN_TIMEOUT_MS: "1000",
    HOMER_RESTART_POLICY: policyHelper,
    HOMER_RESTART_REQUEST: requestFile,
    HOMER_DRAIN_SENTINEL: sentinelFile,
    HOMER_RUNTIME_STAMP: runtimeStamp,
    HOMER_DISK_BUILD: diskBuild,
    HOMER_APP_SUPPORT: temp,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
supervisor.stdout.on("data", (chunk) => { output += chunk; });
supervisor.stderr.on("data", (chunk) => { output += chunk; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pids() {
  try {
    return (await readFile(pidFile, "utf8")).trim().split("\n").filter(Boolean).map(Number);
  } catch { return []; }
}

async function waitFor(predicate, label, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}\n${output}`);
}

async function waitForPidCount(count) {
  await waitFor(async () => (await pids()).length >= count, `${count} child starts`);
  return pids();
}

function occurrences(text) {
  return output.split(text).length - 1;
}

async function writeRequest() {
  await writeFile(requestFile, `${JSON.stringify({
    version: 1, reason: "test", requester: "isolated-test", requestedAt: new Date().toISOString(),
    force: false, forceStale: false, targetBuild: build,
  })}\n`);
}

async function assertAlive(pid, message) {
  try { process.kill(pid, 0); } catch { throw new Error(`${message}\n${output}`); }
}

try {
  const [first] = await waitForPidCount(1);

  // A same-build planned request is consumed without replacing the child.
  await writeFile(policyState, "noop_same_build\n");
  await writeRequest();
  supervisor.kill("SIGHUP");
  await waitFor(() => output.includes("same-build no-op"), "same-build no-op");
  await assertAlive(first, "same-build no-op stopped the child");
  try { await readFile(requestFile); throw new Error("same-build request was not removed"); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  // Two failures do not restart; the third does exactly once.
  await writeFile(policyState, "allow\n");
  const failureBase = occurrences("health check failed");
  healthy = false;
  await waitFor(() => occurrences("health check failed") >= failureBase + 2, "two failed probes");
  if ((await pids()).length !== 1) throw new Error(`two failures restarted child\n${output}`);
  await waitForPidCount(2);
  healthy = true;
  const [, second] = await pids();
  await waitFor(() => output.includes("restart activated"), "unhealthy replacement acknowledgement");

  // A live blocker defers after three failures and keeps monitoring the same PID.
  await writeFile(policyState, "defer\n");
  const deferralBase = occurrences("health check failed");
  healthy = false;
  await waitFor(() => occurrences("health check failed") >= deferralBase + 3, "blocked third probe");
  await waitFor(() => output.includes("unhealthy restart deferred by policy"), "policy deferral");
  healthy = true;
  await sleep(250);
  if ((await pids()).length !== 2) throw new Error(`blocker deferral spawned a child\n${output}`);
  await assertAlive(second, "blocker deferral stopped active child");

  // A success between failures resets hysteresis.
  await writeFile(policyState, "allow\n");
  const resetBase = occurrences("health check failed");
  healthy = false;
  await waitFor(() => occurrences("health check failed") >= resetBase + 2, "pre-reset failures");
  healthy = true;
  await sleep(250);
  healthy = false;
  await waitFor(() => occurrences("health check failed") >= resetBase + 4, "post-reset two failures");
  if ((await pids()).length !== 2) throw new Error(`success did not reset failure count\n${output}`);
  await waitForPidCount(3);
  healthy = true;
  await waitFor(() => occurrences("restart activated") >= 2, "reset-path replacement acknowledgement");

  // A real child exit bypasses health hysteresis and uses crash recovery.
  const current = (await pids()).at(-1);
  process.kill(current, "SIGKILL");
  await waitForPidCount(4);

  supervisor.kill("SIGTERM");
  await waitFor(() => supervisor.exitCode !== null, "supervisor shutdown");
  if (supervisor.exitCode !== 0) throw new Error(`supervisor exited ${supervisor.exitCode}\n${output}`);
  console.log("Supervisor hysteresis, blocker deferral, same-build no-op, crash recovery, and shutdown: PASS");
} finally {
  healthy = true;
  if (supervisor.exitCode === null) supervisor.kill("SIGKILL");
  await new Promise((resolve) => healthServer.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
