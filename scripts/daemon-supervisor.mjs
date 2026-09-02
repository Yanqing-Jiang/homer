#!/usr/bin/env node

// Homer's single child-lifecycle authority. launchd owns this parent; durable
// restart intent and the shared policy decide whether this parent stops a child.
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const childCommand = process.argv[2] ?? process.execPath;
const childArgs = process.argv.length > 3
  ? process.argv.slice(3)
  : [new URL("../dist/index.js", import.meta.url).pathname];
const cwd = process.env.HOMER_ROOT ?? new URL("..", import.meta.url).pathname;
const healthUrl = process.env.HOMER_HEALTH_URL === undefined
  ? "http://127.0.0.1:3000/health"
  : process.env.HOMER_HEALTH_URL;
const healthIntervalMs = positiveInt("HOMER_HEALTH_INTERVAL_MS", 30_000);
const healthTimeoutMs = positiveInt("HOMER_HEALTH_TIMEOUT_MS", 5_000);
const healthGraceMs = positiveInt("HOMER_HEALTH_GRACE_MS", 30_000);
const healthFailureLimit = positiveInt("HOMER_HEALTH_FAILURE_LIMIT", 3);
const requestPollMs = positiveInt("HOMER_RESTART_POLL_MS", 60_000);
const readinessTimeoutMs = positiveInt("HOMER_READINESS_TIMEOUT_MS", 120_000);
const shutdownTimeoutMs = positiveInt("HOMER_SHUTDOWN_TIMEOUT_MS", 45_000);
const stableRuntimeMs = positiveInt("HOMER_STABLE_RUNTIME_MS", 60_000);
const maxBackoffMs = positiveInt("HOMER_MAX_RESTART_BACKOFF_MS", 30_000);
const appSupport = process.env.HOMER_APP_SUPPORT
  ?? path.join(process.env.HOME ?? cwd, "Library", "Application Support", "Homer");
const requestPath = process.env.HOMER_RESTART_REQUEST ?? path.join(appSupport, "restart.request");
const sentinelPath = process.env.HOMER_DRAIN_SENTINEL ?? path.join(appSupport, "daemon.draining");
const runtimeStampPath = process.env.HOMER_RUNTIME_STAMP ?? path.join(cwd, "run", "daemon-build.json");
const diskBuildPath = process.env.HOMER_DISK_BUILD ?? path.join(cwd, "dist", ".build-version");
const policyHelper = process.env.HOMER_RESTART_POLICY ?? path.join(cwd, "scripts", "pre-restart-check.sh");
// F9 crash breaker: this many crashes inside the window park the supervisor (SIGHUP re-arms)
// and send ONE SMS. Before this the loop was unbounded and silent — 63 restarts on
// 2026-09-01 with nothing but log lines, because the "Homer restarted" ping needs a
// successful bot.start and a daemon that dies in main() never gets there.
const crashBreakerLimit = positiveInt("HOMER_CRASH_BREAKER_LIMIT", 5);
const crashBreakerWindowMs = positiveInt("HOMER_CRASH_BREAKER_WINDOW_MS", 600_000);
const twilioApiBase = process.env.HOMER_TWILIO_API_BASE ?? "https://api.twilio.com/2010-04-01";
const dotEnvPath = process.env.HOMER_DOTENV ?? path.join(cwd, ".env");

const actions = new EventEmitter();
let stopping = false;
let lastDeferralLogAt = 0;

function positiveInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function log(message, fields = {}) {
  process.stdout.write(`${JSON.stringify({
    time: new Date().toISOString(), component: "homer-supervisor", message, ...fields,
  })}\n`);
}

process.on("SIGHUP", () => {
  if (!stopping) {
    log("restart wake-up received");
    actions.emit("action", "wake");
  }
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log("supervisor stopping", { signal });
    actions.emit("action", "stop");
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The daemon loads its secrets from .env via dotenv; launchd gives this supervisor none of
// them. Same file, same precedence (a real env var wins), read only for the alert keys and
// never copied into process.env — the child still resolves .env itself.
const ALERT_KEYS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "OWNER_PHONE"];
async function alertConfig() {
  const values = {};
  let fileVars = {};
  try {
    const text = await readFile(dotEnvPath, "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      fileVars[match[1]] = value;
    }
  } catch { fileVars = {}; }
  for (const key of ALERT_KEYS) values[key] = process.env[key] || fileVars[key] || "";
  return values;
}

/**
 * The same transport as `[HOMER ALERT]` in src/telephony/emergency-sms.ts and
 * src/fatal-handlers.ts (Twilio REST, Basic auth, 300-char cap) — reimplemented here
 * because the supervisor must not import the daemon's build. Never throws.
 */
async function sendAlertSms(message) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_PHONE_NUMBER: from, OWNER_PHONE: to } = await alertConfig();
  if (!sid || !token || !from || !to) {
    log("alert SMS skipped: Twilio or OWNER_PHONE not configured", { dotEnvPath });
    return false;
  }
  const prefix = "[HOMER ALERT] ";
  const maxBody = 300 - prefix.length;
  const clean = String(message).replace(/\s+/g, " ").trim();
  const body = prefix + (clean.length > maxBody ? `${clean.slice(0, maxBody - 3)}...` : clean);
  try {
    const response = await fetch(`${twilioApiBase}/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    log(response.ok ? "alert SMS sent" : "alert SMS failed", { status: response.status });
    return response.ok;
  } catch (error) {
    log("alert SMS threw", { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

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
  const check = async () => {
    if (cancelled || child.exitCode !== null || child.signalCode !== null) return;
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(healthTimeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (failures > 0) log("health check recovered", { pid: child.pid, failures });
      failures = 0;
    } catch (error) {
      failures += 1;
      log("health check failed", {
        pid: child.pid, failures,
        error: error instanceof Error ? error.message : String(error),
      });
      if (failures >= healthFailureLimit) {
        failures = 0;
        actions.emit("action", "unhealthy");
      }
    }
    if (!cancelled) timer = setTimeout(check, healthIntervalMs);
  };
  if (healthUrl) timer = setTimeout(check, healthGraceMs);
  return { cancel() { cancelled = true; if (timer) clearTimeout(timer); } };
}

function waitForAction(timeoutMs = requestPollMs) {
  return new Promise((resolve) => {
    let timer = null;
    // A parked wait (timeoutMs === null) must keep the event loop alive: signal listeners
    // alone do not, so without this handle Node exits the moment the last child is gone,
    // launchd (KeepAlive) respawns the supervisor ~10 s later, and the "park" is a slower
    // loop — one SMS per breaker trip, forever. Verified on Node 26 on 2026-09-01.
    const keepAlive = timeoutMs === null ? setInterval(() => {}, 60_000) : null;
    const done = (type) => {
      if (timer) clearTimeout(timer);
      if (keepAlive) clearInterval(keepAlive);
      actions.off("action", done);
      resolve({ type });
    };
    if (timeoutMs !== null) timer = setTimeout(() => done("poll"), timeoutMs);
    actions.once("action", done);
  });
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

function comparable(build) {
  if (!build || typeof build !== "object") return null;
  return {
    sha: build.sha ?? null,
    dirty: typeof build.dirty === "boolean" ? build.dirty : null,
    sourceFingerprint: build.sourceFingerprint ?? null,
    maxSourceMtimeMs: typeof build.maxSourceMtimeMs === "number" ? build.maxSourceMtimeMs : null,
  };
}

function sameBuild(a, b) {
  return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp.${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}

async function policy(mode, child, request = null) {
  const env = {
    ...process.env,
    HOMER_ROOT: cwd,
    HOMER_CURRENT_CHILD_PID: String(child.pid),
    HOMER_RUNTIME_STAMP: runtimeStampPath,
    HOMER_ALLOW_STALE_RESTART: request?.forceStale ? "1" : "0",
  };
  try {
    const { stdout } = await execFileAsync(policyHelper, [mode], { cwd, env });
    return JSON.parse(stdout.trim().split("\n").at(-1));
  } catch (error) {
    const stdout = error?.stdout?.trim().split("\n").at(-1);
    try { return JSON.parse(stdout); } catch {
      return { result: "policy_error", reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

async function loadRequest() {
  const request = await readJson(requestPath);
  if (!request) return null;
  if (request.version !== 1 || typeof request.reason !== "string" || !comparable(request.targetBuild)) {
    log("restart request invalid; leaving pending", { requestPath });
    return null;
  }
  return request;
}

async function replacementReady(child, request, timeoutMs = readinessTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!stopping && Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try {
      const response = healthUrl
        ? await fetch(healthUrl, { signal: AbortSignal.timeout(healthTimeoutMs) })
        : { ok: true };
      const stamp = await readJson(runtimeStampPath);
      if (response.ok && stamp?.pid === child.pid && sameBuild(stamp.build, request.targetBuild)) return true;
    } catch { /* readiness retries until timeout */ }
    await delay(Math.min(500, healthIntervalMs));
  }
  return false;
}

async function acknowledgeActivation(child, request) {
  if (!await replacementReady(child, request)) {
    log("replacement not yet acknowledged; request and sentinel retained", { pid: child.pid });
    return false;
  }
  if (request.removeRequest !== false) await rm(requestPath, { force: true });
  await rm(sentinelPath, { force: true });
  log("restart activated", { pid: child.pid, reason: request.reason });
  return true;
}

async function evaluatePlanned(child) {
  const request = await loadRequest();
  if (!request) return { action: "none" };
  const diskBuild = await readJson(diskBuildPath);
  if (!sameBuild(request.targetBuild, diskBuild)) {
    log("restart request target no longer matches dist; leaving pending", { reason: request.reason });
    return { action: "none" };
  }
  const result = await policy(request.force ? "force" : "planned", child, request);
  if (result.result === "noop_same_build") {
    await rm(requestPath, { force: true });
    await rm(sentinelPath, { force: true });
    log("restart request completed as same-build no-op", { reason: request.reason });
    return { action: "none" };
  }
  if (result.result !== "allow") {
    log("restart request pending", { reason: request.reason, policy: result });
    return { action: "none" };
  }
  const finalResult = await policy(request.force ? "force" : "planned", child, request);
  if (finalResult.result !== "allow") {
    log("restart deferred by final policy recheck", { reason: request.reason, policy: finalResult });
    return { action: "none" };
  }
  await atomicJson(sentinelPath, {
    owner: "homer-supervisor", supervisorPid: process.pid, childPid: child.pid,
    startedAt: new Date().toISOString(), reason: request.reason, targetBuild: request.targetBuild,
  });
  log("restart allowed; draining child", { pid: child.pid, reason: request.reason, force: Boolean(request.force) });
  return { action: "restart", request };
}

async function main() {
  let crashCount = 0;
  let crashTimes = [];
  const existingSentinel = await readJson(sentinelPath);
  let activation = null;
  if (existingSentinel?.owner === "homer-supervisor") {
    activation = existingSentinel.reason === "unhealthy"
      ? { reason: "unhealthy", targetBuild: existingSentinel.targetBuild, removeRequest: false }
      : await loadRequest();
  }
  log("supervisor started", { command: childCommand, args: childArgs });

  while (!stopping) {
    const startedAt = Date.now();
    const child = spawn(childCommand, childArgs, {
      cwd, env: { ...process.env, HOMER_SUPERVISED: "1" }, stdio: "inherit",
    });
    child.on("error", (error) => log("failed to spawn daemon", { error: error.message }));
    log("daemon started", { pid: child.pid });

    if (activation && await acknowledgeActivation(child, activation)) activation = null;
    const health = watchHealth(child);
    const exitPromise = childExit(child);
    let deliberateRestart = false;
    let outcome;
    while (!stopping && child.exitCode === null && child.signalCode === null) {
      outcome = await Promise.race([exitPromise, waitForAction()]);
      if (outcome.type === "exit") break;
      if (outcome.type === "stop") { await stopChild(child); break; }

      if (activation) {
        if (await acknowledgeActivation(child, activation, Math.min(readinessTimeoutMs, requestPollMs))) activation = null;
        continue;
      }
      if (outcome.type === "unhealthy") {
        const result = await policy("unhealthy", child);
        if (result.result === "allow") {
          const finalResult = await policy("unhealthy", child);
          if (finalResult.result === "allow") {
            const targetBuild = await readJson(diskBuildPath)
              ?? (await readJson(runtimeStampPath))?.build;
            await atomicJson(sentinelPath, {
              owner: "homer-supervisor", supervisorPid: process.pid, childPid: child.pid,
              startedAt: new Date().toISOString(), reason: "unhealthy", targetBuild,
            });
            log("daemon unhealthy; draining child", { pid: child.pid });
            activation = {
              reason: "unhealthy",
              targetBuild,
              removeRequest: false,
            };
            await stopChild(child);
            deliberateRestart = true;
            break;
          }
        }
        if (Date.now() - lastDeferralLogAt >= 300_000 || lastDeferralLogAt === 0) {
          lastDeferralLogAt = Date.now();
          log("unhealthy restart deferred by policy", { pid: child.pid, policy: result });
        }
        continue;
      }
      const planned = await evaluatePlanned(child);
      if (planned.action === "restart") {
        activation = planned.request;
        await stopChild(child);
        deliberateRestart = true;
        break;
      }
    }
    health.cancel();
    if (stopping) break;
    if (deliberateRestart) { crashCount = 0; crashTimes = []; continue; }

    const exit = outcome?.type === "exit" ? outcome : await childExit(child);
    log("daemon exited", { pid: child.pid, code: exit.code, signal: exit.signal });
    // Park only on a clean exit shortly after spawn (the daemon-lock refusal
    // shape). A clean exit after stable runtime — e.g. someone SIGTERMed the
    // child directly — must respawn, or Homer stays down until a manual HUP.
    if (exit.code === 0 && Date.now() - startedAt < stableRuntimeMs) {
      log("clean child exit; parked to avoid lock-contention respawn loop");
      const parked = await waitForAction(null);
      if (parked.type === "stop") break;
      continue;
    }
    const runtimeMs = Date.now() - startedAt;
    crashCount = runtimeMs >= stableRuntimeMs ? 1 : crashCount + 1;
    const now = Date.now();
    crashTimes = crashTimes.filter((at) => now - at < crashBreakerWindowMs);
    crashTimes.push(now);
    if (crashTimes.length >= crashBreakerLimit) {
      const windowMin = Math.round(crashBreakerWindowMs / 60_000);
      log("crash breaker tripped; parked until SIGHUP", {
        crashes: crashTimes.length, windowMs: crashBreakerWindowMs, lastCode: exit.code, lastSignal: exit.signal, supervisorPid: process.pid,
      });
      await sendAlertSms(
        `Homer daemon crash loop: ${crashTimes.length} exits in ${windowMin} min (last exit ${exit.code ?? exit.signal}); supervisor PARKED, Homer is DOWN. `
        + `Fix, then wake it: kill -HUP ${process.pid}. Log: ~/homer/logs/stdout.log`,
      );
      const parked = await waitForAction(null);
      if (parked.type === "stop") break;
      crashTimes = [];
      crashCount = 0;
      log("crash breaker re-armed by wake-up");
      continue;
    }
    const backoffMs = Math.min(1_000 * (2 ** Math.min(crashCount - 1, 10)), maxBackoffMs);
    log("daemon restart scheduled", { runtimeMs, crashCount, backoffMs });
    const backoff = await waitForAction(backoffMs);
    if (backoff.type === "stop") break;
  }
  log("supervisor stopped");
}

main().catch((error) => {
  log("supervisor failed", { error: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
});
