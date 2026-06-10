/**
 * Gemini CLI Executor — agy-rotate backend
 *
 * Homer prefers the optional `agy-rotate` multi-account wrapper when installed
 * and otherwise invokes Antigravity CLI (`agy`) directly.
 *
 * What this file owns:
 *   - Spawn `agy-rotate` with the right flags
 *   - Pipe the prompt over stdin via `--prompt-stdin` (avoids OS argv length limits)
 *   - Group-kill the wrapper + nested `agy` child on timeout/abort/shutdown
 *   - Parse the `[agy-rotate] selected: <email>` marker for telemetry
 *   - Provide deprecation-compatible no-op shims for the legacy account-manager API
 *
 * What this file no longer owns (moved to agy-rotate):
 *   - Per-account HOME swapping and OAuth file shuffling
 *   - SQLite account bookkeeping (the old gemini_accounts table has been removed)
 *   - Cooldown timers, rate-limit / auth / runtime classification
 *   - Concurrency semaphore + inter-spawn stagger
 *
 * Antigravity CLI supports per-call model selection through `--model`.
 */

import { spawn } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ExecutorResult } from "./types.js";
import { logger } from "../utils/logger.js";
import { processRegistry } from "../process/registry.js";

export const GEMINI_CLI_FLASH_MODEL = "gemini-3-flash-preview";
export const GEMINI_CLI_PRO_MODEL = "gemini-3.1-pro-preview";
export const PRO_TOKEN_SOFT_LIMIT = 800_000;

const AGY_MODEL_ALIASES: Record<string, string> = {
  [GEMINI_CLI_FLASH_MODEL]: "Gemini 3.5 Flash (High)",
  [GEMINI_CLI_PRO_MODEL]: "Gemini 3.1 Pro (High)",
};

// Marker line agy-rotate writes to stderr when invoked with --emit-account.
// Anchored to start-of-line to avoid matching content in agy's own response.
const ACCOUNT_MARKER_RE = /^\[agy-rotate\] selected: (\S+)$/m;

// Default wrapper-side lock-wait budget; mirrors GLOBAL_LOCK_TIMEOUT_S in agy-rotate.
const DEFAULT_LOCK_TIMEOUT_MS = 1_200_000;

export interface GeminiCLIDirectOptions {
  /** Caller-requested model. Legacy model IDs are mapped to Antigravity names. */
  model?: string;
  /** Inner per-call timeout (ms). Outer kill budget = timeout + lock-wait + grace. */
  timeout?: number;
  signal?: AbortSignal;
  cwd?: string;
  /** Legacy: agy has no -o flag, silently ignored. Documented for stable callsites. */
  outputFormat?: "text" | "json" | "stream-json";
  /** Legacy role hint. agy-rotate does not currently load per-role agent files. */
  role?: "research";
  /** Homer run identifier; propagated into ProcessRegistry. */
  runId?: string;
}

export interface GeminiCLIDirectResult extends ExecutorResult {
  model: string;
  accountEmail?: string;
}

type ScheduledGeminiResearchOptions = Omit<GeminiCLIDirectOptions, "model">;

// ---------------------------------------------------------------------------
// Helpers

function sanitizeGeminiOutput(text: string): string {
  return text
    .replace(/^YOLO mode is enabled\.\s*/gm, "")
    .replace(/^Loaded cached credentials\.\s*/gm, "")
    .trim();
}

function stripAgyControlLines(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !ACCOUNT_MARKER_RE.test(line))
    .join("\n")
    .trim();
}

function parseAccountEmail(stderr: string): string | undefined {
  return stderr.match(ACCOUNT_MARKER_RE)?.[1];
}

function resolveAgyModel(model: string): string {
  const normalized = model.replace(/^(google|google-aistudio)\//, "");
  return AGY_MODEL_ALIASES[normalized] ?? model;
}

function resolveAgyBackend(): { command: string; usesRotation: boolean } {
  const configuredWrapper = process.env.AGY_ROTATE_BIN?.trim();
  if (configuredWrapper) {
    return { command: configuredWrapper, usesRotation: true };
  }

  const defaultWrapper = join(homedir(), "bin", "agy-rotate");
  if (existsSync(defaultWrapper)) {
    return { command: defaultWrapper, usesRotation: true };
  }

  return {
    command: process.env.AGY_BIN?.trim() || "agy",
    usesRotation: false,
  };
}

/** On success: stdout. On failure: stdout || stderr || exit-code message. */
function buildOutput(stdout: string, stderr: string, exitCode: number, command: string): string {
  const cleanOut = sanitizeGeminiOutput(stdout);
  if (exitCode === 0) return cleanOut;
  const cleanErr = stripAgyControlLines(stderr);
  return cleanOut || cleanErr || `${command} exited with code ${exitCode}`;
}

/** Token estimator preserved for downstream callers (e.g. Pro soft-limit gating). */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Main entry point

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
  const backend = resolveAgyBackend();
  const agyModel = resolveAgyModel(model);
  const lockTimeoutMs = Number(
    process.env.AGY_ROTATE_LOCK_TIMEOUT_MS ?? DEFAULT_LOCK_TIMEOUT_MS,
  );
  // Outer kill budget: caller's per-call timeout + worst-case lock wait + 30s grace.
  const outerTimeoutMs = timeout + (backend.usesRotation ? lockTimeoutMs : 0) + 30_000;

  logger.debug(
    {
      requestedModel: model,
      agyModel,
      backend: backend.usesRotation ? "agy-rotate" : "agy",
      promptLength: prompt.length,
      timeoutMs: timeout,
      runId,
    },
    "Executing Gemini via agy-rotate",
  );

  return new Promise<GeminiCLIDirectResult>((resolve) => {
    const args = backend.usesRotation
      ? [
          "--dangerously-skip-permissions",
          "--emit-account",
          "--model",
          agyModel,
          "--prompt-stdin",
        ]
      : [
          "--dangerously-skip-permissions",
          "--model",
          agyModel,
          "-p",
          "-",
        ];

    const child = spawn(backend.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: {
        ...process.env,
        ...(backend.usesRotation
          ? {
              AGY_ROTATE_TIMEOUT_S: String(Math.ceil(timeout / 1000)),
              AGY_ROTATE_LOCK_TIMEOUT_S: String(Math.ceil(lockTimeoutMs / 1000)),
            }
          : {}),
      },
      // Put wrapper in its own process group so we can group-kill the nested
      // `agy` child on timeout/abort/shutdown instead of orphaning it.
      detached: true,
    });

    processRegistry.register(child, {
      command: backend.command,
      type: "executor",
      timeoutMs: outerTimeoutMs,
      source: "scheduler",
      runId,
    });

    // Pipe prompt over stdin (avoids OS ARG_MAX for large prompts).
    child.stdin?.end(prompt);

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
      // Escalate to SIGKILL on the whole group if it doesn't exit promptly.
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
        output: buildOutput(stdout, stderr, exitCode, backend.command),
        exitCode,
        duration: Date.now() - startTime,
        executor: "gemini-cli",
        model,
        accountEmail: parseAccountEmail(stderr),
      });
    });

    child.on("error", (err) => {
      finish({
        output: `Error spawning ${backend.command}: ${err.message}`,
        exitCode: 1,
        duration: Date.now() - startTime,
        executor: "gemini-cli",
        model,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Convenience wrappers (preserved signatures for downstream callers)

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
