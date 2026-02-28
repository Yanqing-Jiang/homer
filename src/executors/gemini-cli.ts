/**
 * Gemini CLI Executor
 *
 * Calls the `gemini` CLI binary (OAuth, Google account) directly via Code Assist backend.
 * Model: gemini-2.5-flash (latest Flash available via subscription OAuth)
 * System prompt: ~/.gemini/GEMINI.md (loaded automatically by CLI)
 *
 * Account rotation: swaps ~/.gemini/oauth_creds.json before each call.
 * Creds stored per-account in ~/homer/config/auth/gemini-creds/{email}.json
 */

import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import type { ExecutorResult } from "./types.js";
import { logger } from "../utils/logger.js";

export const GEMINI_CLI_FLASH_MODEL = "gemini-2.5-flash";

const GEMINI_CREDS_FILE = path.join(process.env.HOME || "", ".gemini/oauth_creds.json");
const GEMINI_ACCOUNTS_FILE = path.join(process.env.HOME || "", ".gemini/google_accounts.json");
const GEMINI_CREDS_DIR = path.join(process.env.HOME || "", "homer/config/auth/gemini-creds");

// Simple mutex so concurrent calls don't race on creds swap
let credSwapLock = false;
async function waitForLock(): Promise<void> {
  while (credSwapLock) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

export interface GeminiCLIDirectOptions {
  model?: string;
  timeout?: number;
  signal?: AbortSignal;
  cwd?: string;
}

export interface GeminiCLIDirectResult extends ExecutorResult {
  model: string;
  accountEmail?: string;
}

async function getAvailableAccounts(): Promise<string[]> {
  try {
    const files = await fs.readdir(GEMINI_CREDS_DIR);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
  } catch {
    return [];
  }
}

async function getActiveEmail(): Promise<string | null> {
  try {
    const data = JSON.parse(await fs.readFile(GEMINI_ACCOUNTS_FILE, "utf-8"));
    return data.active || null;
  } catch {
    return null;
  }
}

async function swapToAccount(email: string): Promise<boolean> {
  const credsFile = path.join(GEMINI_CREDS_DIR, `${email}.json`);
  try {
    const creds = await fs.readFile(credsFile, "utf-8");
    await fs.writeFile(GEMINI_CREDS_FILE, creds, "utf-8");
    try {
      const accountsData = JSON.parse(await fs.readFile(GEMINI_ACCOUNTS_FILE, "utf-8"));
      accountsData.active = email;
      await fs.writeFile(GEMINI_ACCOUNTS_FILE, JSON.stringify(accountsData, null, 2), "utf-8");
    } catch {
      // Non-fatal
    }
    logger.info({ email }, "Swapped Gemini CLI account");
    return true;
  } catch (err) {
    logger.warn({ email, err }, "Failed to swap Gemini CLI account — creds file missing");
    return false;
  }
}

export async function rotateGeminiAccount(): Promise<string | null> {
  const available = await getAvailableAccounts();
  if (available.length <= 1) return null;

  const current = await getActiveEmail();
  const currentIdx = available.indexOf(current || "");
  const nextIdx = (currentIdx + 1) % available.length;
  const nextEmail = available[nextIdx];

  if (nextEmail && (await swapToAccount(nextEmail))) {
    return nextEmail;
  }
  return null;
}

export async function executeGeminiCLIDirect(
  prompt: string,
  options: GeminiCLIDirectOptions = {}
): Promise<GeminiCLIDirectResult> {
  const {
    model = GEMINI_CLI_FLASH_MODEL,
    timeout = 120_000,
    signal,
    cwd = "/tmp",
  } = options;

  const startTime = Date.now();

  await waitForLock();
  const accountEmail = await getActiveEmail();

  return new Promise((resolve) => {
    credSwapLock = true;
    const args = ["-m", model, "-y", "-p", prompt];

    logger.debug({ model, accountEmail, promptLength: prompt.length }, "Executing Gemini CLI");

    const child = spawn("gemini", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeout);

    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timeoutId);
        child.kill("SIGTERM");
      });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", async (code) => {
      clearTimeout(timeoutId);
      credSwapLock = false;
      const duration = Date.now() - startTime;

      const output = stdout
        .replace(/^YOLO mode is enabled\.\s*/gm, "")
        .replace(/^Loaded cached credentials\.\s*/gm, "")
        .trim();

      if (timedOut) {
        logger.warn({ model, accountEmail, duration }, "Gemini CLI timed out");
        resolve({ output: "Error: Gemini CLI timed out", exitCode: 1, duration, executor: "gemini-cli", model, accountEmail: accountEmail || undefined });
        return;
      }

      // Detect rate limit — rotate account and retry once
      const isRateLimit = stderr.includes("429") || stderr.includes("quota") || (code !== 0 && stderr.includes("exhausted"));
      if (isRateLimit) {
        const nextEmail = await rotateGeminiAccount();
        if (nextEmail) {
          logger.warn({ currentEmail: accountEmail, nextEmail }, "Gemini rate limited — rotated to next account, retrying");
          const retryResult = await executeGeminiCLIDirect(prompt, options);
          resolve(retryResult);
          return;
        }
      }

      if (code !== 0 || !output) {
        const errMsg = stderr
          .replace(/^YOLO mode is enabled\.\s*/gm, "")
          .replace(/^Loaded cached credentials\.\s*/gm, "")
          .trim();
        logger.warn({ code, model, accountEmail, duration, stderr: errMsg.slice(0, 300) }, "Gemini CLI failed or empty output");
        resolve({ output: `Error: exit ${code}. ${errMsg.slice(0, 300)}`, exitCode: code ?? 1, duration, executor: "gemini-cli", model, accountEmail: accountEmail || undefined });
        return;
      }

      // Save refreshed creds back to per-account file
      try {
        const activeCreds = await fs.readFile(GEMINI_CREDS_FILE, "utf-8");
        if (accountEmail) {
          await fs.writeFile(path.join(GEMINI_CREDS_DIR, `${accountEmail}.json`), activeCreds, "utf-8");
        }
      } catch {
        // Non-fatal
      }

      logger.debug({ model, accountEmail, duration, outputLength: output.length }, "Gemini CLI completed");

      resolve({ output, exitCode: 0, duration, executor: "gemini-cli", model, accountEmail: accountEmail || undefined });
    });

    child.on("error", (err) => {
      clearTimeout(timeoutId);
      credSwapLock = false;
      resolve({ output: `Error: ${err.message}`, exitCode: 1, duration: Date.now() - startTime, executor: "gemini-cli", model, accountEmail: accountEmail || undefined });
    });
  });
}
