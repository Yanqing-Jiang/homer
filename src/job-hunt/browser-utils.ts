/**
 * Safe browser automation utilities — prevents shell injection from scraped URLs.
 * All functions are async to avoid blocking the Node.js event loop during I/O.
 */

import { execFile } from "child_process";
import { logger } from "../utils/logger.js";

function execFileAsync(cmd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", timeout }, (err, stdout, stderr) => {
      if (err) {
        const e: any = err;
        e.stderr = stderr;
        reject(e);
      } else {
        resolve((stdout as string).trim());
      }
    });
  });
}

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
export async function safeNavigate(url: string, timeout = 15000): Promise<string> {
  const safe = validateUrl(url);
  try {
    return await execFileAsync("agent-browser", ["open", safe], timeout);
  } catch (err: any) {
    logger.warn({ url: safe, error: err?.message }, "safeNavigate failed");
    return "";
  }
}

/**
 * Run an arbitrary JS script in agent-browser.
 * Minifies to single line — agent-browser eval requires single-line input.
 */
export async function safeEval(script: string, timeout = 15000): Promise<string> {
  const oneliner = script.replace(/\n/g, " ").replace(/\s{2,}/g, " ").trim();
  try {
    return await execFileAsync("agent-browser", ["eval", oneliner], timeout);
  } catch (err: any) {
    logger.warn({ error: err?.message, stderr: err?.stderr?.slice(0, 300) }, "safeEval failed");
    return "";
  }
}

/**
 * Run a simple agent-browser command (connect, screenshot, scroll — no user data).
 * Accepts pre-tokenized args array to prevent whitespace-splitting issues with quoted paths.
 */
export async function runBrowser(args: string[], timeout = 15000): Promise<string> {
  try {
    return await execFileAsync("agent-browser", args, timeout);
  } catch (error: any) {
    logger.warn({ args, error: error?.message }, "agent-browser command failed");
    return "";
  }
}
