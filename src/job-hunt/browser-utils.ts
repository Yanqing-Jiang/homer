/**
 * Safe browser automation utilities — prevents shell injection from scraped URLs.
 */

import { execSync } from "child_process";
import { writeFileSync } from "fs";
import { logger } from "../utils/logger.js";

/**
 * Validate and normalize a URL. Throws on invalid or non-HTTP(S) URLs.
 */
export function validateUrl(url: string): string {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Invalid protocol: ${parsed.protocol}`);
  }
  return parsed.href;
}

/**
 * Navigate agent-browser to a URL safely (no shell interpolation).
 */
export function safeNavigate(url: string, timeout = 15000): string {
  const safe = validateUrl(url);
  const script = `window.location.href=${JSON.stringify(safe)}`;
  writeFileSync("/tmp/jh_nav.js", script);
  try {
    return execSync('agent-browser eval "$(cat /tmp/jh_nav.js)"', {
      encoding: "utf8",
      timeout,
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Run an arbitrary JS script in agent-browser by writing to a temp file
 * (avoids shell interpolation of untrusted content).
 */
export function safeEval(script: string, timeout = 15000): string {
  const scriptPath = `/tmp/jh_eval_${Date.now()}.js`;
  writeFileSync(scriptPath, script);
  try {
    return execSync(`agent-browser eval "$(cat ${scriptPath})"`, {
      encoding: "utf8",
      timeout,
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Run a simple agent-browser command (connect, screenshot, scroll — no user data).
 */
export function runBrowser(cmd: string, timeout = 15000): string {
  try {
    return execSync(`agent-browser ${cmd}`, { encoding: "utf8", timeout }).trim();
  } catch (error: any) {
    logger.warn({ cmd, error: error?.message }, "agent-browser command failed");
    return "";
  }
}
