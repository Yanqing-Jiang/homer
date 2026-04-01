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
const YANQING_PHONE = "+12709789240";
const SMS_MAX_LENGTH = 300;

let exiting = false;
const shutdownTasks: Array<() => Promise<void> | void> = [];

/**
 * Register a function to be called during graceful shutdown
 */
export function registerShutdownTask(fn: () => Promise<void> | void): void {
  shutdownTasks.push(fn);
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
      "-d", `To=${encodeURIComponent(YANQING_PHONE)}`,
      "-d", `From=${encodeURIComponent(TWILIO_PHONE_NUMBER)}`,
      "-d", `Body=${encodeURIComponent(body)}`,
    ], { timeout: 5000 });
  } catch {
    // best-effort — we're already in a fatal path
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
