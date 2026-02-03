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
// Note: https and spawnSync were used for Telegram notifications (now disabled)
// import https from "https";
// import { spawnSync } from "child_process";

const LOG_DIR = process.env.HOMER_LOG_DIR ?? path.join(os.homedir(), "Library", "Logs", "homer");
const FATAL_LOG = path.join(LOG_DIR, "fatal.log");
// Note: Telegram notification constants (disabled)
// const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
// const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? process.env.ALLOWED_CHAT_ID ?? "";

const EXIT_TIMEOUT_MS = 2000;
const SHUTDOWN_TIMEOUT_MS = 8000;

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
 * Send Telegram message synchronously using curl
 * DISABLED - notifications turned off
 */
function sendTelegramSync(_message: string): void {
  // Notifications disabled
  return;
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
  const tasks = shutdownTasks.map((fn) => Promise.resolve().then(fn).catch(() => undefined));
  await Promise.race([
    Promise.allSettled(tasks).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function fatalExit(kind: string, err: unknown): Promise<void> {
  if (exiting) return;
  exiting = true;

  const context = `host=${os.hostname()} pid=${process.pid} uptime=${process.uptime().toFixed(1)}s`;
  const detail = formatError(err);
  const msg = `Homer fatal: ${kind} | ${context}\n${detail}`;

  logLine("ERROR", msg);
  sendTelegramSync(msg);

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
  process.exit(0);
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
