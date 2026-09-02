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
const smsBodies = [];
const healthServer = createServer((request, response) => {
  if (request.method === "POST") {
    // Stands in for Twilio's Messages.json endpoint (HOMER_TWILIO_API_BASE points here).
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      smsBodies.push({ url: request.url, auth: request.headers.authorization ?? "", body });
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ sid: "SMtest" }));
    });
    return;
  }
  response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: healthy ? "healthy" : "failed" }));
});
await new Promise((resolve) => healthServer.listen(0, "127.0.0.1", resolve));
const address = healthServer.address();
const crashFlag = path.join(temp, "crash-on-start");
const fixture = `
  const fs = require("node:fs");
  const build = JSON.parse(process.env.TEST_BUILD);
  fs.appendFileSync(process.env.TEST_PID_FILE, process.pid + "\\n");
  if (fs.existsSync(process.env.TEST_CRASH_FLAG)) process.exit(3);
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
    TEST_CRASH_FLAG: crashFlag,
    HOMER_CRASH_BREAKER_LIMIT: "3",
    HOMER_CRASH_BREAKER_WINDOW_MS: "10000",
    HOMER_TWILIO_API_BASE: `http://127.0.0.1:${address.port}/twilio`,
    HOMER_DOTENV: path.join(temp, "missing.env"),
    TWILIO_ACCOUNT_SID: "ACtest",
    TWILIO_AUTH_TOKEN: "tokentest",
    TWILIO_PHONE_NUMBER: "+15550000001",
    OWNER_PHONE: "+15550000002",
    HOMER_HEALTH_URL: `http://127.0.0.1:${address.port}/health`,
    HOMER_HEALTH_GRACE_MS: "100",
    HOMER_HEALTH_INTERVAL_MS: "180",
    HOMER_HEALTH_TIMEOUT_MS: "1000",
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
  const recoveredBase = occurrences("health check recovered");
  healthy = false;
  await waitFor(() => occurrences("health check failed") >= resetBase + 2, "pre-reset failures");
  healthy = true;
  await waitFor(() => occurrences("health check recovered") >= recoveredBase + 1, "recovery probe");
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

  // F9: a crash LOOP trips the breaker — the supervisor parks, sends exactly one SMS naming
  // the wake-up command, and spawns nothing more until SIGHUP.
  await writeFile(crashFlag, "1\n");
  const loopBase = (await pids()).length;
  process.kill((await pids()).at(-1), "SIGKILL");
  await waitFor(() => output.includes("crash breaker tripped; parked until SIGHUP"), "crash breaker trip", 10_000);
  await waitFor(() => smsBodies.length >= 1, "breaker SMS");
  const parkedCount = (await pids()).length;
  // The window already holds the SIGKILL crashes above, so the third crash in it is the
  // first or second crash-on-start child — the breaker counts exits inside the window,
  // not spawns since the flag was set.
  if (!output.includes('"crashes":3')) throw new Error(`breaker did not trip at exactly 3 crashes\n${output}`);
  if (parkedCount - loopBase < 1) throw new Error(`no crash-on-start child was ever spawned\n${output}`);
  await sleep(700);
  if ((await pids()).length !== parkedCount) throw new Error(`parked supervisor kept spawning\n${output}`);
  // A park is a live wait, not an exit: with no child and no timer the supervisor used to
  // fall off the end of its event loop here, and launchd's KeepAlive turned the park into a
  // slower loop.
  if (supervisor.exitCode !== null) throw new Error(`parked supervisor exited ${supervisor.exitCode}\n${output}`);
  if (smsBodies.length !== 1) throw new Error(`expected exactly one breaker SMS, got ${smsBodies.length}\n${output}`);
  const sms = new URLSearchParams(smsBodies[0].body);
  if (!smsBodies[0].url.startsWith("/twilio/Accounts/ACtest/Messages.json")) throw new Error(`SMS posted to ${smsBodies[0].url}`);
  if (sms.get("To") !== "+15550000002" || sms.get("From") !== "+15550000001") throw new Error(`SMS addressing wrong: ${smsBodies[0].body}`);
  const smsText = sms.get("Body") ?? "";
  if (!smsText.startsWith("[HOMER ALERT] Homer daemon crash loop:") || !smsText.includes(`kill -HUP ${supervisor.pid}`)) {
    throw new Error(`SMS text wrong: ${smsText}`);
  }
  if (smsText.length > 300) throw new Error(`SMS too long: ${smsText.length}`);
  if (smsBodies[0].auth !== `Basic ${Buffer.from("ACtest:tokentest").toString("base64")}`) throw new Error("SMS auth header wrong");

  // SIGHUP re-arms the breaker; with the crash flag gone the child stays up.
  await rm(crashFlag, { force: true });
  supervisor.kill("SIGHUP");
  await waitFor(() => output.includes("crash breaker re-armed by wake-up"), "breaker re-arm");
  await waitForPidCount(parkedCount + 1);
  await sleep(300);
  await assertAlive((await pids()).at(-1), "post-breaker child did not stay up");
  if (smsBodies.length !== 1) throw new Error(`re-arm sent another SMS\n${output}`);

  supervisor.kill("SIGTERM");
  await waitFor(() => supervisor.exitCode !== null, "supervisor shutdown");
  if (supervisor.exitCode !== 0) throw new Error(`supervisor exited ${supervisor.exitCode}\n${output}`);
  console.log("Supervisor hysteresis, blocker deferral, same-build no-op, crash recovery, crash breaker + SMS + re-arm, and shutdown: PASS");
} finally {
  healthy = true;
  if (supervisor.exitCode === null) supervisor.kill("SIGKILL");
  await new Promise((resolve) => healthServer.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
