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
/** Edit-capable Antigravity specialist. This is deliberately separate from research defaults. */
export const GEMINI_CLI_SPECIALIST_MODEL = "gemini-3.8-flash-high";
/** Every edit or writing specialist run gets at least 15 minutes, including revisions. */
export const GEMINI_CLI_SPECIALIST_MIN_TIMEOUT_MS = 15 * 60 * 1_000;
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
  /** Per-call timeout (ms). Research preserves its 30s outer grace. */
  timeout?: number;
  signal?: AbortSignal;
  cwd?: string;
  /** Legacy research option; specialist invocations always request the agy JSON envelope. */
  outputFormat?: "text" | "json" | "stream-json";
  /** Research keeps its existing defaults; specialist enables the bounded edit agent. */
  role?: "research" | "specialist";
  /** Reasoning effort accepted by agy. Specialist defaults to high. */
  effort?: "low" | "medium" | "high";
  /** Homer run identifier; propagated into ProcessRegistry. */
  runId?: string;
}

export interface GeminiCLIDirectResult extends ExecutorResult {
  /** Model the caller requested, before compatibility alias resolution. */
  requestedModel: string;
  /** Model passed to agy after compatibility alias resolution. */
  resolvedModel: string;
  model: string;
  accountEmail?: string;
  /** Present when the specialist returns its JSON conversation identifier. */
  sessionId?: string;
  /** Usage information returned by agy without reinterpretation. */
  usage?: unknown;
  /** Structured terminal status returned by agy. */
  status?: string;
}

type ScheduledGeminiResearchOptions = Omit<GeminiCLIDirectOptions, "model" | "role" | "effort">;

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

type AgySpecialistResult = {
  conversation_id?: unknown;
  status?: unknown;
  response?: unknown;
  usage?: unknown;
};

function parseAgySpecialistResult(stdout: string): AgySpecialistResult | undefined {
  const clean = sanitizeGeminiOutput(stdout);
  if (!clean) return undefined;

  try {
    const parsed = JSON.parse(clean) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as AgySpecialistResult
      : undefined;
  } catch {
    return undefined;
  }
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
    role,
    effort,
  } = options;

  const startTime = Date.now();
  const command = resolveAgyBin();
  const agyModel = resolveAgyModel(model);
  const specialist = role === "specialist";
  // The specialist needs enough time for substantive writing and revision.
  // Keep caller-requested longer deadlines, but never permit a shorter one.
  const effectiveTimeoutMs = specialist
    ? Math.max(timeout, GEMINI_CLI_SPECIALIST_MIN_TIMEOUT_MS)
    : timeout;
  // Research retains its established extra outer grace. The specialist CLI's
  // --timeout-ms is an actual caller deadline, so it can be cancelled promptly.
  const outerTimeoutMs = specialist ? effectiveTimeoutMs : timeout + 30_000;

  if (specialist && signal?.aborted) {
    return {
      output: "Cancelled",
      exitCode: 130,
      duration: Date.now() - startTime,
      executor: "gemini-cli",
      requestedModel: model,
      resolvedModel: agyModel,
      model,
      accountEmail: AGY_ACCOUNT_EMAIL,
    };
  }

  logger.debug(
    {
      requestedModel: model,
      agyModel,
      backend: "agy",
      accountEmail: AGY_ACCOUNT_EMAIL,
      promptLength: prompt.length,
      timeoutMs: effectiveTimeoutMs,
      runId,
      role,
      effort,
    },
    "Executing Gemini via agy",
  );

  return new Promise<GeminiCLIDirectResult>((resolve) => {
    const args = specialist
      ? [
          "--agent", "homer-specialist",
          "--model", agyModel,
          "--effort", effort ?? "high",
          "--mode", "accept-edits",
          "--sandbox",
          "--output-format", "json",
          "--print-timeout", `${Math.ceil(effectiveTimeoutMs / 1_000)}s`,
          "-p", prompt,
        ]
      : [
          "--dangerously-skip-permissions",
          "--model", agyModel,
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
    let stopping = false;
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
      if (stopping) return;
      stopping = true;
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
      if (child.pid) processRegistry.touch(child.pid);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (specialist && aborted) {
        finish({
          output: "Cancelled",
          exitCode: 130,
          duration: Date.now() - startTime,
          executor: "gemini-cli",
          requestedModel: model,
          resolvedModel: agyModel,
          model,
          accountEmail: AGY_ACCOUNT_EMAIL,
        });
        return;
      }
      if (specialist && timedOut) {
        finish({
          output: "Timeout",
          exitCode: 124,
          duration: Date.now() - startTime,
          executor: "gemini-cli",
          requestedModel: model,
          resolvedModel: agyModel,
          model,
          accountEmail: AGY_ACCOUNT_EMAIL,
        });
        return;
      }

      const processExitCode = code ?? (aborted ? 130 : timedOut ? 4 : 1);
      const structured = specialist ? parseAgySpecialistResult(stdout) : undefined;
      let exitCode = processExitCode;
      let output = buildOutput(stdout, stderr, exitCode, command);
      let sessionId: string | undefined;
      let usage: unknown;
      let status: string | undefined;

      if (specialist) {
        if (!structured) {
          if (exitCode === 0) exitCode = 1;
          output = "agy returned an invalid JSON specialist result";
        } else {
          status = typeof structured.status === "string" ? structured.status : undefined;
          sessionId = typeof structured.conversation_id === "string" ? structured.conversation_id : undefined;
          usage = structured.usage;
          if (status !== "SUCCESS") {
            if (exitCode === 0) exitCode = 1;
            output = `agy returned non-success specialist status: ${status ?? "missing"}`;
          } else if (typeof structured.response !== "string") {
            if (exitCode === 0) exitCode = 1;
            output = "agy specialist result is missing a string response";
          } else if (exitCode === 0) {
            output = structured.response;
          }
        }
      }
      finish({
        output,
        exitCode,
        duration: Date.now() - startTime,
        executor: "gemini-cli",
        requestedModel: model,
        resolvedModel: agyModel,
        model,
        accountEmail: AGY_ACCOUNT_EMAIL,
        sessionId,
        usage,
        status,
      });
    });

    child.on("error", (err) => {
      finish({
        output: `Error spawning ${command}: ${err.message}`,
        exitCode: 1,
        duration: Date.now() - startTime,
        executor: "gemini-cli",
        requestedModel: model,
        resolvedModel: agyModel,
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
    role: "research",
  });
}

export async function executeGeminiProResearch(
  prompt: string,
  options: ScheduledGeminiResearchOptions = {},
): Promise<GeminiCLIDirectResult> {
  return executeGeminiCLIDirect(prompt, {
    ...options,
    model: GEMINI_CLI_PRO_MODEL,
    role: "research",
  });
}

/**
 * Invoke the bounded edit-capable Antigravity specialist. It has no provider
 * fallback: callers receive agy's terminal status, model, usage, and session.
 */
export async function executeGeminiSpecialist(
  prompt: string,
  options: Omit<GeminiCLIDirectOptions, "role" | "model" | "effort"> & {
    model?: string;
    effort?: "low" | "medium" | "high";
  } = {},
): Promise<GeminiCLIDirectResult> {
  return executeGeminiCLIDirect(prompt, {
    ...options,
    model: options.model ?? GEMINI_CLI_SPECIALIST_MODEL,
    role: "specialist",
    effort: options.effort ?? "high",
    timeout: options.timeout ?? GEMINI_CLI_SPECIALIST_MIN_TIMEOUT_MS,
  });
}
