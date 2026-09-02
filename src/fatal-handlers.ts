/**
 * Fatal Error Handlers for Homer Daemon
 *
 * Provides:
 * - uncaughtException handling
 * - unhandledRejection handling
 * - Graceful shutdown on SIGTERM/SIGINT
 * - Telegram crash notifications (using spawnSync for reliability)
 * - Synchronous file logging
 */

import fs from "fs";
import os from "os";
import path from "path";
import util from "util";
import { spawnSync } from "child_process";
import { getRuntimePaths } from "./utils/runtime-paths.js";

const runtimePaths = getRuntimePaths();
const LOG_DIR =
  process.env.HOMER_LOG_DIR ?? runtimePaths.libraryLogsDir ?? path.join(os.homedir(), "Library", "Logs", "homer");
const FATAL_LOG = path.join(LOG_DIR, "fatal.log");
// Note: Telegram notification constants (disabled)
// const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
// const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? process.env.ALLOWED_CHAT_ID ?? "";

const EXIT_TIMEOUT_MS = 2000;
// Global shutdown timeout: total budget for all shutdown phases.
// Must be larger than DRAIN_TIMEOUT_MS (15s in index.ts) to allow for Phase 1 + Phase 3.
// Default 30s. LaunchD ExitTimeOut (60s) > this > DRAIN_TIMEOUT_MS (15s).
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? "30000", 10);

// SMS constants — read from env directly (no config import, this runs before init)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID ?? "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? "";
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER ?? "";
const OWNER_PHONE = process.env.OWNER_PHONE ?? "";
const SMS_MAX_LENGTH = 300;

let exiting = false;
const shutdownTasks: Array<() => Promise<void> | void> = [];
const fatalOnlyTasks: Array<() => Promise<void> | void> = [];

/**
 * Register a function to be called during graceful shutdown
 */
export function registerShutdownTask(fn: () => Promise<void> | void): void {
  shutdownTasks.push(fn);
}

/**
 * Register a function to run ONLY on an abnormal exit (uncaughtException /
 * unhandledRejection), before the ordinary shutdown tasks. A deliberate
 * SIGTERM/SIGINT never runs these.
 *
 * Exists because the resident-Chrome reap has to distinguish the two: on a crash the
 * browser must be terminated (or explicitly left for adoption) so the next daemon
 * generation does not inherit an orphan, while a deliberate shutdown already has its
 * own ordered teardown.
 */
export function registerFatalExitTask(fn: () => Promise<void> | void): void {
  fatalOnlyTasks.push(fn);
}

function ensureLogDir(): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // best effort
  }
}

function logLine(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  try {
    ensureLogDir();
    fs.appendFileSync(FATAL_LOG, line, { encoding: "utf8" });
  } catch {
    // best effort
  }
  try {
    process.stderr.write(line);
  } catch {
    // best effort
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  if (typeof err === "string") return err;
  return util.inspect(err, { depth: 4 });
}

/**
 * Send SMS synchronously via curl → Twilio API.
 * Used in fatal handlers where async is unreliable.
 */
function sendSmsSyncViaCurl(message: string): void {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) return;

  try {
    const prefix = "[HOMER ALERT] ";
    const maxBody = SMS_MAX_LENGTH - prefix.length;
    const clean = message.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FEFF}]/gu, "").trim();
    const body = prefix + (clean.length > maxBody ? clean.slice(0, maxBody - 3) + "..." : clean);

    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const auth = `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`;

    spawnSync("curl", [
      "-s", "-X", "POST", url,
      "-u", auth,
      "-d", `To=${encodeURIComponent(OWNER_PHONE)}`,
      "-d", `From=${encodeURIComponent(TWILIO_PHONE_NUMBER)}`,
      "-d", `Body=${encodeURIComponent(body)}`,
    ], { timeout: 5000 });
  } catch {
    // best-effort — we're already in a fatal path
  }
}

const STARTUP_SMS_STAMP = path.join(LOG_DIR, "startup-failure-sms.at");
const STARTUP_SMS_MIN_INTERVAL_MS = parseInt(process.env.HOMER_STARTUP_SMS_MIN_INTERVAL_MS ?? String(6 * 60 * 60 * 1000), 10);

/**
 * One SMS for a daemon that failed to START (`main().catch`), rate-limited across
 * process restarts through a stamp file: the supervisor relaunches a failed start
 * forever, so an in-memory limit would page once per crash — 63 times on 2026-09-01.
 * Synchronous (curl) because the caller exits right after. Never throws.
 */
export function sendStartupFailureSms(err: unknown, now: number = Date.now()): boolean {
  try {
    let lastAt = 0;
    try { lastAt = Number(fs.readFileSync(STARTUP_SMS_STAMP, "utf8").trim()) || 0; } catch { /* first failure */ }
    if (now - lastAt < STARTUP_SMS_MIN_INTERVAL_MS) {
      logLine("WARN", `startup-failure SMS suppressed: last sent ${Math.round((now - lastAt) / 60_000)} min ago`);
      return false;
    }
    ensureLogDir();
    fs.writeFileSync(STARTUP_SMS_STAMP, `${now}\n`, { encoding: "utf8" });
    const detail = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 140);
    const msg = `Homer failed to start (pid ${process.pid}): ${detail}. Supervisor keeps retrying; check ~/homer/logs/stdout.log`;
    logLine("ERROR", `startup-failure SMS: ${msg}`);
    sendSmsSyncViaCurl(msg);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send Telegram message asynchronously (best effort, for graceful shutdown)
 * DISABLED - notifications turned off
 */
function sendTelegramBestEffort(_message: string, _timeoutMs = 2000): void {
  // Notifications disabled
  return;
}

async function runShutdownTasks(timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (const fn of shutdownTasks) {
    if (Date.now() >= deadline) {
      logLine("WARN", "Shutdown deadline reached, skipping remaining tasks");
      break;
    }
    try {
      const remaining = deadline - Date.now();
      await Promise.race([
        Promise.resolve(fn()),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("shutdown task timeout")), remaining)
        ),
      ]);
    } catch {
      // continue to next task
    }
  }
}

async function fatalExit(kind: string, err: unknown): Promise<void> {
  if (exiting) return;
  exiting = true;

  const context = `host=${os.hostname()} pid=${process.pid} uptime=${process.uptime().toFixed(1)}s`;
  const detail = formatError(err);
  const msg = `Homer fatal: ${kind} | ${context}\n${detail}`;

  logLine("ERROR", msg);
  sendSmsSyncViaCurl(msg);

  // Crash-only cleanup first (resident Chrome reap) — bounded so it cannot eat the
  // whole shutdown budget, and run before the ordinary tasks tear its inputs down.
  for (const fn of fatalOnlyTasks) {
    try {
      await Promise.race([
        Promise.resolve(fn()),
        new Promise<void>((resolve) => setTimeout(resolve, 8000)),
      ]);
    } catch { /* best effort — already fatal */ }
  }

  // Best-effort shutdown with tight 10s cap
  try { await runShutdownTasks(10_000); } catch { /* best effort */ }

  process.exitCode = 1;
  setTimeout(() => process.exit(1), EXIT_TIMEOUT_MS).unref();
}

async function gracefulExit(signal: string): Promise<void> {
  if (exiting) return;
  exiting = true;

  const context = `host=${os.hostname()} pid=${process.pid} uptime=${process.uptime().toFixed(1)}s`;
  const msg = `Homer shutdown: ${signal} | ${context}`;

  logLine("INFO", msg);
  sendTelegramBestEffort(msg);

  await runShutdownTasks();
  process.exit(process.exitCode || 0);
}

/**
 * Install fatal error handlers
 * Call this at the very beginning of your application, before any other initialization
 */
export function installFatalHandlers(): void {
  process.on("uncaughtException", (err) => void fatalExit("uncaughtException", err));
  process.on("unhandledRejection", (reason) => void fatalExit("unhandledRejection", reason));
  process.on("SIGTERM", () => void gracefulExit("SIGTERM"));
  process.on("SIGINT", () => void gracefulExit("SIGINT"));
  process.on("exit", (code) => logLine("INFO", `process exit code=${code}`));
}

// Export for use in web server graceful degradation
export { logLine, sendTelegramBestEffort };
