/**
 * OS-level daemon lock using flock()
 *
 * Provides crash-safe exclusive locking via kernel file locks.
 * Lock is automatically released by the OS on process exit (including crashes).
 *
 * CRITICAL: Uses O_CLOEXEC to prevent child processes from inheriting the lock FD.
 * Without this, child processes (Claude CLI, monitors) can hold locks after parent dies.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { flockSync, fcntlSync, constants as fsExtConstants } from "fs-ext";
import { execSync } from "child_process";
import { logger } from "../utils/logger.js";

const LOCK_DIR = path.join(os.homedir(), "Library", "Application Support", "Homer");
const LOCK_FILE = path.join(LOCK_DIR, "homer.lock");

// Open flags: create, read-write, close-on-exec (prevents child FD inheritance)
const LOCK_OPEN_FLAGS = fs.constants.O_CREAT | fs.constants.O_RDWR;

let lockFd: number | null = null;

/**
 * Get PIDs holding the lock file (for diagnostics)
 */
function getLockHolders(): string {
  try {
    return execSync(`/usr/sbin/lsof -n -t -- "${LOCK_FILE}" 2>/dev/null || true`, {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Acquire exclusive daemon lock
 *
 * @returns true if lock acquired, false if another instance is running
 * @throws Error if lock directory cannot be created
 */
export function acquireDaemonLock(): boolean {
  try {
    // Ensure lock directory exists
    fs.mkdirSync(LOCK_DIR, { recursive: true, mode: 0o755 });
  } catch (err) {
    logger.fatal({ err, lockDir: LOCK_DIR }, "Failed to create lock directory");
    throw new Error(`Cannot create lock directory: ${LOCK_DIR}`);
  }

  try {
    // Open lock file with O_CLOEXEC to prevent child FD inheritance
    // This is the ROOT CAUSE fix: children won't inherit the lock FD
    lockFd = fs.openSync(LOCK_FILE, LOCK_OPEN_FLAGS, 0o600);

    // Defense-in-depth: explicitly set FD_CLOEXEC via fcntl
    // This ensures the flag is set even if O_CLOEXEC wasn't honored
    try {
      fcntlSync(lockFd, "setfd", fsExtConstants.FD_CLOEXEC);
    } catch (fcntlErr) {
      logger.warn({ err: fcntlErr }, "Failed to set FD_CLOEXEC on lock FD (continuing)");
    }

    // Attempt to acquire exclusive lock (non-blocking)
    // LOCK_EX = exclusive lock
    // LOCK_NB = non-blocking (fail immediately if locked)
    flockSync(lockFd, "exnb");

    // Truncate and write diagnostic info to lock file
    fs.ftruncateSync(lockFd, 0);
    const lockInfo = [
      `PID: ${process.pid}`,
      `PPID: ${process.ppid}`,
      `Started: ${new Date().toISOString()}`,
      `Exec: ${process.execPath}`,
      `Args: ${process.argv.slice(1).join(" ")}`,
      `Node: ${process.version}`,
    ].join("\n") + "\n";
    fs.writeSync(lockFd, lockInfo, 0, "utf8");
    fs.fsyncSync(lockFd);

    logger.info(
      { pid: process.pid, lockFile: LOCK_FILE },
      "Daemon lock acquired"
    );

    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;

    // EWOULDBLOCK or EAGAIN means another instance holds the lock
    if (code === "EWOULDBLOCK" || code === "EAGAIN") {
      // Log who's holding the lock for diagnostics
      const holders = getLockHolders();
      if (holders) {
        logger.info(
          { lockFile: LOCK_FILE, holders: holders.split("\n") },
          "Another Homer instance is running (lock held by PIDs)"
        );
      } else {
        logger.info(
          { lockFile: LOCK_FILE },
          "Another Homer instance is running (lock file is locked)"
        );
      }

      // Close FD if we opened it
      if (lockFd !== null) {
        try {
          fs.closeSync(lockFd);
        } catch {
          // Ignore close errors
        }
        lockFd = null;
      }

      return false;
    }

    // Other errors are fatal
    logger.fatal({ err, lockFile: LOCK_FILE }, "Failed to acquire daemon lock");
    throw new Error(`Lock acquisition failed: ${(err as Error).message}`);
  }
}

/**
 * Release daemon lock
 *
 * Called during graceful shutdown. Lock is also automatically
 * released by the OS on process exit/crash.
 */
export function releaseDaemonLock(): void {
  if (lockFd === null) {
    return;
  }

  try {
    // Note: flock is automatically released when FD is closed
    // We don't need to explicitly unlock
    fs.closeSync(lockFd);
    lockFd = null;

    logger.info("Daemon lock released");
  } catch (err) {
    logger.error({ err }, "Error releasing daemon lock (non-fatal)");
  }
}

/**
 * Get lock file path (for testing)
 */
export function getLockFilePath(): string {
  return LOCK_FILE;
}
