#!/usr/bin/env node

// Homer's single process supervisor. launchd keeps this small parent alive;
// this parent owns the daemon and is therefore still present when Homer exits.
import { spawn } from "node:child_process";

const childCommand = process.argv[2] ?? process.execPath;
const childArgs = process.argv.length > 3
  ? process.argv.slice(3)
  : [new URL("../dist/index.js", import.meta.url).pathname];
const cwd = process.env.HOMER_ROOT ?? new URL("..", import.meta.url).pathname;
const healthUrl = process.env.HOMER_HEALTH_URL === undefined
  ? "http://127.0.0.1:3000/health"
  : process.env.HOMER_HEALTH_URL;
const healthIntervalMs = positiveInt("HOMER_HEALTH_INTERVAL_MS", 20_000);
const healthGraceMs = positiveInt("HOMER_HEALTH_GRACE_MS", 30_000);
const healthFailureLimit = positiveInt("HOMER_HEALTH_FAILURE_LIMIT", 3);
const shutdownTimeoutMs = positiveInt("HOMER_SHUTDOWN_TIMEOUT_MS", 45_000);
const stableRuntimeMs = positiveInt("HOMER_STABLE_RUNTIME_MS", 60_000);
const maxBackoffMs = positiveInt("HOMER_MAX_RESTART_BACKOFF_MS", 30_000);

let pendingAction = null;
let actionWaiter = null;
let stopping = false;

function positiveInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function log(message, fields = {}) {
  process.stdout.write(`${JSON.stringify({
    time: new Date().toISOString(),
    component: "homer-supervisor",
    message,
    ...fields,
  })}\n`);
}

function requestAction(action) {
  if (pendingAction === "stop") return;
  pendingAction = action;
  actionWaiter?.();
}

function waitForAction() {
  if (pendingAction) {
    const action = pendingAction;
    pendingAction = null;
    return Promise.resolve({ type: action });
  }
  return new Promise((resolve) => {
    actionWaiter = () => {
      const action = pendingAction;
      pendingAction = null;
      actionWaiter = null;
      resolve({ type: action });
    };
  });
}

process.on("SIGHUP", () => {
  if (!stopping) {
    log("planned restart requested");
    requestAction("restart");
  }
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log("supervisor stopping", { signal });
    requestAction("stop");
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function childExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ type: "exit", code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ type: "exit", code, signal }));
    child.once("error", (error) => resolve({ type: "exit", code: null, signal: null, error }));
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([childExit(child), delay(shutdownTimeoutMs)]);
  if (child.exitCode === null && child.signalCode === null) {
    log("daemon exceeded shutdown timeout; sending SIGKILL", { pid: child.pid });
    child.kill("SIGKILL");
    await childExit(child);
  }
}

function watchHealth(child) {
  let cancelled = false;
  let timer = null;
  let failures = 0;
  let resolveFailure;
  const failed = new Promise((resolve) => { resolveFailure = resolve; });

  const check = async () => {
    if (cancelled || child.exitCode !== null || child.signalCode !== null) return;
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      failures = 0;
    } catch (error) {
      failures += 1;
      log("health check failed", {
        pid: child.pid,
        failures,
        error: error instanceof Error ? error.message : String(error),
      });
      if (failures >= healthFailureLimit) {
        resolveFailure({ type: "unhealthy" });
        return;
      }
    }
    if (!cancelled) timer = setTimeout(check, healthIntervalMs);
  };

  if (healthUrl) timer = setTimeout(check, healthGraceMs);
  return {
    failed,
    cancel() {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
  };
}

async function main() {
  let crashCount = 0;
  log("supervisor started", { command: childCommand, args: childArgs });

  while (!stopping) {
    const startedAt = Date.now();
    const child = spawn(childCommand, childArgs, {
      cwd,
      env: { ...process.env, HOMER_SUPERVISED: "1" },
      stdio: "inherit",
    });
    child.on("error", (error) => log("failed to spawn daemon", { error: error.message }));
    log("daemon started", { pid: child.pid });

    const health = watchHealth(child);
    const outcome = await Promise.race([childExit(child), waitForAction(), health.failed]);
    health.cancel();

    if (outcome.type === "stop") {
      await stopChild(child);
      break;
    }
    if (outcome.type === "restart") {
      await stopChild(child);
      crashCount = 0;
      continue;
    }
    if (outcome.type === "unhealthy") {
      log("daemon unhealthy; restarting", { pid: child.pid });
      await stopChild(child);
    } else {
      log("daemon exited", { pid: child.pid, code: outcome.code, signal: outcome.signal });
    }

    const runtimeMs = Date.now() - startedAt;
    crashCount = runtimeMs >= stableRuntimeMs ? 1 : crashCount + 1;
    const backoffMs = Math.min(1_000 * (2 ** Math.min(crashCount - 1, 10)), maxBackoffMs);
    log("daemon restart scheduled", { runtimeMs, crashCount, backoffMs });
    const backoffOutcome = await Promise.race([
      delay(backoffMs).then(() => ({ type: "elapsed" })),
      waitForAction(),
    ]);
    if (backoffOutcome.type === "stop") break;
  }

  log("supervisor stopped");
}

main().catch((error) => {
  log("supervisor failed", { error: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
});
