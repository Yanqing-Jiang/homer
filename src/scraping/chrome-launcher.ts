/**
 * Chrome CDP Auto-Launcher
 *
 * Ensures a Chrome DevTools Protocol endpoint is available for agent-browser.
 * Strategy: check existing CDP → headless launch → headed fallback.
 */

import { spawn, type ChildProcess } from "child_process";
import { cpSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { logger } from "../utils/logger.js";
import { processRegistry } from "../process/registry.js";
import { getRuntimePaths } from "../utils/runtime-paths.js";

const CDP_PORT = 9222;
const CDP_POLL_INTERVAL_MS = 1_000;
const CDP_POLL_MAX_MS = 15_000;
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const runtimePaths = getRuntimePaths();
const PROFILE_SOURCE = runtimePaths.chromeProfileRoot;

export interface CDPHandle {
  /** PID of launched Chrome process (0 if reusing existing) */
  pid: number;
  /** Call to kill Chrome and remove temp profile */
  cleanup: () => void;
}

/**
 * Ensure a CDP endpoint is available on the given port.
 * Returns a handle with a cleanup function.
 */
export async function ensureCDP(port: number = CDP_PORT): Promise<CDPHandle> {
  // 1. Check if CDP is already available
  if (await isCDPAvailable(port)) {
    logger.debug({ port }, "CDP already available");
    return { pid: 0, cleanup: () => {} };
  }

  // 2. Try headless launch
  logger.info({ port }, "Launching headless Chrome with CDP");
  try {
    const handle = await launchChrome(port, true);
    if (await waitForCDP(port)) {
      logger.info({ pid: handle.pid, port }, "Headless Chrome CDP ready");
      return handle;
    }
    // Headless didn't come up — kill it and try headed
    handle.cleanup();
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, "Headless Chrome launch failed");
  }

  // 3. Fallback: headed launch
  logger.info({ port }, "Falling back to headed Chrome with CDP");
  const handle = await launchChrome(port, false);
  if (await waitForCDP(port)) {
    logger.info({ pid: handle.pid, port }, "Headed Chrome CDP ready");
    return handle;
  }

  // Both failed — clean up and throw
  handle.cleanup();
  throw new Error(`Failed to launch Chrome with CDP on port ${port}`);
}

async function isCDPAvailable(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const resp = await fetch(`http://localhost:${port}/json/version`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

async function waitForCDP(port: number): Promise<boolean> {
  const deadline = Date.now() + CDP_POLL_MAX_MS;
  while (Date.now() < deadline) {
    if (await isCDPAvailable(port)) return true;
    await new Promise((r) => setTimeout(r, CDP_POLL_INTERVAL_MS));
  }
  return false;
}

async function launchChrome(port: number, headless: boolean): Promise<CDPHandle> {
  const tempDir = `/tmp/chrome-cdp-profile-${Date.now()}`;
  mkdirSync(tempDir, { recursive: true });

  // Copy Chrome profile for session cookies
  try {
    const defaultProfile = join(PROFILE_SOURCE, "Default");
    cpSync(defaultProfile, join(tempDir, "Default"), { recursive: true });
    const localState = join(PROFILE_SOURCE, "Local State");
    cpSync(localState, join(tempDir, "Local State"));
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, "Failed to copy Chrome profile, launching with empty profile");
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${tempDir}`,
    "--profile-directory=Default",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
  ];

  if (headless) {
    args.unshift("--headless=new");
  }

  const proc: ChildProcess = spawn(CHROME_PATH, args, {
    stdio: "ignore",
    detached: true,
  });

  proc.unref();

  const pid = proc.pid ?? 0;

  // Register with process lifecycle for daemon shutdown
  if (pid) {
    processRegistry.register(proc, {
      command: "chrome-cdp",
      type: "utility",
      timeoutMs: 0, // No timeout — lives until cleanup
      source: "cli-runner",
      detached: true,
    });
  }

  const cleanup = () => {
    try {
      if (pid) process.kill(pid, "SIGTERM");
    } catch {
      // Already dead
    }
    // Give Chrome a moment to shut down before removing profile
    setTimeout(() => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best effort
      }
    }, 2_000);
  };

  return { pid, cleanup };
}
