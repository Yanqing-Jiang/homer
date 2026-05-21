/**
 * Gemini CLI Executor — agy-rotate backend
 *
 * As of 2026-05-20, Homer's Gemini executor delegates ALL account rotation,
 * cooldown bookkeeping, keychain swap, and retry logic to `/Users/yj/bin/agy-rotate`
 * (a Python wrapper around Antigravity CLI). Native `gemini` CLI is deprecated
 * (EOL June 18, 2026) and is no longer invoked from this process.
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
 *   - SQLite `gemini_accounts` bookkeeping (gemini_accounts table is now legacy data)
 *   - Cooldown timers, rate-limit / auth / runtime classification
 *   - Concurrency semaphore + inter-spawn stagger
 *
 * Model selection: Antigravity CLI has no `-m` flag. The model is set ONCE in
 * `~/.gemini/antigravity-cli/settings.json` and applies to every call. The legacy
 * `GEMINI_CLI_PRO_MODEL` callers still type-check, but at runtime the call uses
 * whatever settings.json has (currently Gemini 3.5 Flash (High)). The `model`
 * field of the result records the caller's *requested* model, not the backend's.
 */

import { spawn } from "child_process";
import type { ExecutorResult } from "./types.js";
import { logger } from "../utils/logger.js";
import { processRegistry } from "../process/registry.js";

const AGY_ROTATE_BIN = "/Users/yj/bin/agy-rotate";

// Kept exported for downstream caller compatibility. Both constants are passed
// through as the `model` field of the result for telemetry; agy ignores them.
export const GEMINI_CLI_FLASH_MODEL = "gemini-3-flash-preview";
export const GEMINI_CLI_PRO_MODEL = "gemini-3.1-pro-preview";
export const PRO_TOKEN_SOFT_LIMIT = 800_000;

// Marker line agy-rotate writes to stderr when invoked with --emit-account.
// Anchored to start-of-line to avoid matching content in agy's own response.
const ACCOUNT_MARKER_RE = /^\[agy-rotate\] selected: (\S+)$/m;

// Default wrapper-side lock-wait budget; mirrors GLOBAL_LOCK_TIMEOUT_S in agy-rotate.
const DEFAULT_LOCK_TIMEOUT_MS = 1_200_000;

export interface GeminiCLIDirectOptions {
  /** Caller-requested model. Recorded in result.model for telemetry; agy ignores it. */
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

/** On success: stdout. On failure: stdout || stderr || exit-code message. */
function buildOutput(stdout: string, stderr: string, exitCode: number): string {
  const cleanOut = sanitizeGeminiOutput(stdout);
  if (exitCode === 0) return cleanOut;
  const cleanErr = stripAgyControlLines(stderr);
  return cleanOut || cleanErr || `agy-rotate exited with code ${exitCode}`;
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
  const lockTimeoutMs = Number(
    process.env.AGY_ROTATE_LOCK_TIMEOUT_MS ?? DEFAULT_LOCK_TIMEOUT_MS,
  );
  // Outer kill budget: caller's per-call timeout + worst-case lock wait + 30s grace.
  const outerTimeoutMs = timeout + lockTimeoutMs + 30_000;

  logger.debug(
    {
      requestedModel: model,
      backendModelPolicy: "agy-settings-json",
      promptLength: prompt.length,
      timeoutMs: timeout,
      runId,
    },
    "Executing Gemini via agy-rotate",
  );

  return new Promise<GeminiCLIDirectResult>((resolve) => {
    const args = [
      "--dangerously-skip-permissions",
      "--emit-account",
      "--prompt-stdin",
    ];

    const child = spawn(AGY_ROTATE_BIN, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: {
        ...process.env,
        AGY_ROTATE_TIMEOUT_S: String(Math.ceil(timeout / 1000)),
        AGY_ROTATE_LOCK_TIMEOUT_S: String(Math.ceil(lockTimeoutMs / 1000)),
      },
      // Put wrapper in its own process group so we can group-kill the nested
      // `agy` child on timeout/abort/shutdown instead of orphaning it.
      detached: true,
    });

    processRegistry.register(child, {
      command: "agy-rotate",
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
        output: buildOutput(stdout, stderr, exitCode),
        exitCode,
        duration: Date.now() - startTime,
        executor: "gemini-cli",
        model,
        accountEmail: parseAccountEmail(stderr),
      });
    });

    child.on("error", (err) => {
      finish({
        output: `Error spawning agy-rotate: ${err.message}`,
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
  // Note: agy has no -m flag — actual backend is whatever settings.json has,
  // currently Flash. The `model` field of the result still reads Pro for
  // telemetry continuity with the caller's intent.
  logger.debug(
    "executeGeminiProResearch: backend is agy-settings-json (currently Flash); model field preserved for telemetry",
  );
  return executeGeminiCLIDirect(prompt, {
    ...options,
    model: GEMINI_CLI_PRO_MODEL,
    role: options.role ?? "research",
  });
}

// ---------------------------------------------------------------------------
// Deprecated account-manager API — preserved as no-ops for caller compatibility.
//
// The pre-2026-05 executor exported a full GeminiAccountManager class and
// lifecycle hooks (called from src/index.ts on daemon startup/shutdown).
// Account rotation now lives entirely in /Users/yj/bin/agy-rotate, so these
// become no-ops. Kept exported so callers still compile under strict TS mode
// without requiring edits to src/index.ts or executors/index.ts.

export interface GeminiAccountManagerOptions {
  rateLimitCooldownMs?: number;
  authFailureCooldownMs?: number;
  runtimeFailureCooldownMs?: number;
  disableAfterFailures?: number;
  disabledRecheckMs?: number;
  lockAcquireTimeoutMs?: number;
  syncIntervalMs?: number;
  maxConcurrentPerAccount?: number;
  minInterSpawnMs?: number;
}

export class GeminiAccountManager {
  constructor(_db?: unknown, _options: GeminiAccountManagerOptions = {}) {
    // No state. Rotation lives in agy-rotate now.
  }

  async syncAccountsFromDisk(_force = false): Promise<void> {
    /* no-op */
  }

  getAccountCount(): number {
    return 0;
  }

  selectBestAccount(_now: number): {
    account: null;
    waitMs: number;
    reason: "no_accounts";
  } {
    return { account: null, waitMs: 0, reason: "no_accounts" };
  }
}

export function initGeminiAccounts(_db: unknown): void {
  /* no-op — agy-rotate owns rotation state */
}

let _accountManagerSingleton: GeminiAccountManager | null = null;

export function initializeGeminiCLIAccountManager(
  _db: unknown,
  _options: GeminiAccountManagerOptions = {},
): GeminiAccountManager {
  logger.info(
    "Gemini account manager is a no-op shim; agy-rotate handles rotation (see /Users/yj/bin/agy-rotate)",
  );
  _accountManagerSingleton = new GeminiAccountManager(_db, _options);
  return _accountManagerSingleton;
}

export function closeGeminiCLIAccountManager(): void {
  _accountManagerSingleton = null;
}

export async function rotateGeminiAccount(): Promise<string | null> {
  // agy-rotate picks an account itself per call; there's nothing to pre-select.
  return null;
}
