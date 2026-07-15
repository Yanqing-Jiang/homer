#!/usr/bin/env node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const temp = await mkdtemp(path.join(tmpdir(), "homer-supervisor-test-"));
const pidFile = path.join(temp, "pids");
const fixture = `
  const fs = require('node:fs');
  fs.appendFileSync(process.env.TEST_PID_FILE, process.pid + '\\n');
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
`;

const supervisor = spawn(process.execPath, [
  path.join(root, "scripts", "daemon-supervisor.mjs"),
  process.execPath,
  "-e",
  fixture,
], {
  cwd: root,
  env: {
    ...process.env,
    TEST_PID_FILE: pidFile,
    HOMER_HEALTH_URL: "",
    HOMER_STABLE_RUNTIME_MS: "5000",
    HOMER_MAX_RESTART_BACKOFF_MS: "1000",
    HOMER_SHUTDOWN_TIMEOUT_MS: "2000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
supervisor.stdout.on("data", (chunk) => { output += chunk; });
supervisor.stderr.on("data", (chunk) => { output += chunk; });

async function pids() {
  try {
    return (await readFile(pidFile, "utf8")).trim().split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function waitForPidCount(count, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const values = await pids();
    if (values.length >= count) return values;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${count} child starts\n${output}`);
}

async function stopSupervisor(processHandle, label) {
  processHandle.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not stop\n${output}`)), 5000);
    processHandle.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${label} exited ${code}\n${output}`));
    });
  });
}

try {
  const [first] = await waitForPidCount(1);
  process.kill(first, "SIGKILL");
  const [, second] = await waitForPidCount(2);
  if (second === first) throw new Error("crash did not create a new child");

  supervisor.kill("SIGHUP");
  const [, , third] = await waitForPidCount(3);
  if (third === second) throw new Error("planned restart did not create a new child");

  await stopSupervisor(supervisor, "supervisor");
  try {
    process.kill(third, 0);
    throw new Error("child survived supervisor shutdown");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  const unhealthyPidFile = path.join(temp, "unhealthy-pids");
  const unhealthySupervisor = spawn(process.execPath, [
    path.join(root, "scripts", "daemon-supervisor.mjs"),
    process.execPath,
    "-e",
    fixture,
  ], {
    cwd: root,
    env: {
      ...process.env,
      TEST_PID_FILE: unhealthyPidFile,
      HOMER_HEALTH_URL: "http://127.0.0.1:9/health",
      HOMER_HEALTH_GRACE_MS: "100",
      HOMER_HEALTH_INTERVAL_MS: "100",
      HOMER_HEALTH_FAILURE_LIMIT: "2",
      HOMER_MAX_RESTART_BACKOFF_MS: "100",
      HOMER_SHUTDOWN_TIMEOUT_MS: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  unhealthySupervisor.stdout.on("data", (chunk) => { output += chunk; });
  unhealthySupervisor.stderr.on("data", (chunk) => { output += chunk; });
  const originalPidFile = pidFile;
  const unhealthyDeadline = Date.now() + 5000;
  let unhealthyStarts = [];
  while (Date.now() < unhealthyDeadline) {
    try {
      unhealthyStarts = (await readFile(unhealthyPidFile, "utf8")).trim().split("\n").filter(Boolean).map(Number);
    } catch {
      unhealthyStarts = [];
    }
    if (unhealthyStarts.length >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (unhealthyStarts.length < 2) {
    unhealthySupervisor.kill("SIGKILL");
    throw new Error(`health failure did not restart child (${originalPidFile})\n${output}`);
  }
  await stopSupervisor(unhealthySupervisor, "unhealthy supervisor");
  console.log("Supervisor crash, health recovery, planned restart, and shutdown: PASS");
} finally {
  if (supervisor.exitCode === null) supervisor.kill("SIGKILL");
  await rm(temp, { recursive: true, force: true });
}
