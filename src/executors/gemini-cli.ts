/**
 * Gemini CLI Executor — Antigravity CLI (`agy`) single-account backend
 *
 * Invokes `agy` directly against the single macOS Keychain OAuth entry
 * (service=gemini, account=antigravity). Multi-account rotation via
 * `agy-rotate` has been removed; the live account is OWNER_GOOGLE_ACCOUNT (or
 * AGY_ACCOUNT_EMAIL) from the environment.
 *
 * Prompt delivery: pass `-p <prompt>` as an argv value. Current agy (1.1.7)
 * treats `-p -` as the literal prompt "-", so stdin piping is not used.
 */

import { spawn } from "child_process";
import { homedir } from "os";
import { join } from "path";
import type { ExecutorResult } from "./types.js";
import { logger } from "../utils/logger.js";
import { processRegistry } from "../process/registry.js";

export const GEMINI_CLI_FLASH_MODEL = "gemini-3-flash-preview";
export const GEMINI_CLI_PRO_MODEL = "gemini-3.1-pro-preview";
export const PRO_TOKEN_SOFT_LIMIT = 800_000;

/** Sole Antigravity account wired into the local keychain (from the environment). */
export const AGY_ACCOUNT_EMAIL = process.env.AGY_ACCOUNT_EMAIL?.trim() || process.env.OWNER_GOOGLE_ACCOUNT?.trim() || "";

const AGY_MODEL_ALIASES: Record<string, string> = {
  [GEMINI_CLI_FLASH_MODEL]: "gemini-3.6-flash-high",
  [GEMINI_CLI_PRO_MODEL]: "gemini-3.1-pro-high",
};

export interface GeminiCLIDirectOptions {
  /** Caller-requested model. Legacy model IDs are mapped to Antigravity slugs. */
  model?: string;
  /** Per-call timeout (ms). Outer kill budget = timeout + 30s grace. */
  timeout?: number;
  signal?: AbortSignal;
  cwd?: string;
  /** Legacy: agy has no -o flag, silently ignored. Documented for stable callsites. */
  outputFormat?: "text" | "json" | "stream-json";
  /** Legacy role hint. Not forwarded to agy. */
  role?: "research";
  /** Homer run identifier; propagated into ProcessRegistry. */
  runId?: string;
}

export interface GeminiCLIDirectResult extends ExecutorResult {
  model: string;
  accountEmail?: string;
}

type ScheduledGeminiResearchOptions = Omit<GeminiCLIDirectOptions, "model">;

function sanitizeGeminiOutput(text: string): string {
  return text
    .replace(/^YOLO mode is enabled\.\s*/gm, "")
    .replace(/^Loaded cached credentials\.\s*/gm, "")
    .trim();
}

function resolveAgyModel(model: string): string {
  const normalized = model.replace(/^(google|google-aistudio)\//, "");
  return AGY_MODEL_ALIASES[normalized] ?? normalized;
}

function resolveAgyBin(): string {
  return (
    process.env.AGY_BIN?.trim() ||
    join(homedir(), ".local", "bin", "agy")
  );
}

/** On success: stdout. On failure: stdout || stderr || exit-code message. */
function buildOutput(stdout: string, stderr: string, exitCode: number, command: string): string {
  const cleanOut = sanitizeGeminiOutput(stdout);
  if (exitCode === 0) return cleanOut;
  const cleanErr = stderr.trim();
  return cleanOut || cleanErr || `${command} exited with code ${exitCode}`;
}

/** Token estimator preserved for downstream callers (e.g. Pro soft-limit gating). */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function executeGeminiCLIDirect(
  prompt: string,
  options: GeminiCLIDirectOptions = {},
): Promise<GeminiCLIDirectResult> {
  const {
    model = GEMINI_CLI_FLASH_MODEL,
    timeout = 900_000,
    signal,
    cwd = "/tmp",
    runId,
  } = options;

  const startTime = Date.now();
  const command = resolveAgyBin();
  const agyModel = resolveAgyModel(model);
  const outerTimeoutMs = timeout + 30_000;

  logger.debug(
    {
      requestedModel: model,
      agyModel,
      backend: "agy",
      accountEmail: AGY_ACCOUNT_EMAIL,
      promptLength: prompt.length,
      timeoutMs: timeout,
      runId,
    },
    "Executing Gemini via agy",
  );

  return new Promise<GeminiCLIDirectResult>((resolve) => {
    const args = [
      "--dangerously-skip-permissions",
      "--model",
      agyModel,
      "-p",
      prompt,
    ];

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
      env: process.env,
      // Own process group so we can group-kill on timeout/abort/shutdown.
      detached: true,
    });

    processRegistry.register(child, {
      command,
      type: "executor",
      timeoutMs: outerTimeoutMs,
      source: "scheduler",
      runId,
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timeoutId: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | null = null;

    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already exited */
        }
      }
    };

    const requestStop = (reason: "timeout" | "abort") => {
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 5_000);
    };

    const finish = (result: GeminiCLIDirectResult) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (killTimer) clearTimeout(killTimer);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
      resolve(result);
    };

    timeoutId = setTimeout(() => requestStop("timeout"), outerTimeoutMs);

    if (signal) {
      abortListener = () => requestStop("abort");
      if (signal.aborted) requestStop("abort");
      else signal.addEventListener("abort", abortListener, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      const exitCode = code ?? (aborted ? 130 : timedOut ? 4 : 1);
      finish({
        output: buildOutput(stdout, stderr, exitCode, command),
        exitCode,
        duration: Date.now() - startTime,
        executor: "gemini-cli",
        model,
        accountEmail: AGY_ACCOUNT_EMAIL,
      });
    });

    child.on("error", (err) => {
      finish({
        output: `Error spawning ${command}: ${err.message}`,
        exitCode: 1,
        duration: Date.now() - startTime,
        executor: "gemini-cli",
        model,
        accountEmail: AGY_ACCOUNT_EMAIL,
      });
    });
  });
}

export async function executeGeminiFlashResearch(
  prompt: string,
  options: ScheduledGeminiResearchOptions = {},
): Promise<GeminiCLIDirectResult> {
  return executeGeminiCLIDirect(prompt, {
    ...options,
    model: GEMINI_CLI_FLASH_MODEL,
    role: options.role ?? "research",
  });
}

export async function executeGeminiProResearch(
  prompt: string,
  options: ScheduledGeminiResearchOptions = {},
): Promise<GeminiCLIDirectResult> {
  return executeGeminiCLIDirect(prompt, {
    ...options,
    model: GEMINI_CLI_PRO_MODEL,
    role: options.role ?? "research",
  });
}
