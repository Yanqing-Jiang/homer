/**
 * InvestigationFallbackChain — Replaces fire-and-forget spawn paths.
 *
 * Chain: Claude Code CLI (5 min) → Codex CLI (5 min) → log + alert
 *
 * Constraints:
 * - Mutex: only one investigation at a time
 * - Rate limit: max 2 per hour
 * - Self-registration in ProcessRegistry
 */

import { spawn } from "child_process";
import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { processRegistry } from "./registry.js";
import { logger } from "../utils/logger.js";
import type Database from "better-sqlite3";
import { getRuntimePaths } from "../utils/runtime-paths.js";

const INVESTIGATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per executor
const MAX_PER_HOUR = 2;
const KILL_GRACE_MS = 5_000;
const runtimePaths = getRuntimePaths();
const LOGS_DIR = join(runtimePaths.homerLogsDir, "investigations");
const CLAUDE_PATH = runtimePaths.claudeBinaryPath;

interface InvestigationContext {
  trigger: string;
  description: string;
  errorDetails?: string;
}

interface InvestigationResult {
  success: boolean;
  output: string;
  executor: string;
}

let activeInvestigation: Promise<InvestigationResult> | null = null;
let db: Database.Database | null = null;

export function initFallbackChain(database: Database.Database): void {
  db = database;
  mkdirSync(LOGS_DIR, { recursive: true });
}

/**
 * Run an investigation through the fallback chain.
 */
export async function investigate(
  context: InvestigationContext
): Promise<InvestigationResult> {
  // Mutex
  if (activeInvestigation) {
    logger.info({ trigger: context.trigger }, "Investigation already in progress, skipping");
    return { success: false, output: "Investigation already in progress", executor: "none" };
  }

  // Rate limit
  if (!checkRateLimit()) {
    logger.warn({ trigger: context.trigger }, "Investigation rate limit exceeded");
    return { success: false, output: "Rate limit exceeded (max 2/hour)", executor: "none" };
  }

  const promise = runChain(context);
  activeInvestigation = promise;

  try {
    return await promise;
  } finally {
    activeInvestigation = null;
  }
}

function checkRateLimit(): boolean {
  if (!db) return true;
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) as cnt FROM investigation_runs WHERE started_at > datetime('now', '-1 hour')"
      )
      .get() as { cnt: number } | undefined;
    return (row?.cnt ?? 0) < MAX_PER_HOUR;
  } catch {
    return true; // Allow on DB error
  }
}

function recordStart(trigger: string): number | null {
  if (!db) return null;
  try {
    const result = db
      .prepare("INSERT INTO investigation_runs (trigger) VALUES (?)")
      .run(trigger);
    return result.lastInsertRowid as number;
  } catch {
    return null;
  }
}

function recordComplete(
  id: number | null,
  executor: string,
  success: boolean,
  outputPath: string
): void {
  if (!db || id == null) return;
  try {
    db.prepare(
      "UPDATE investigation_runs SET completed_at = CURRENT_TIMESTAMP, executor_used = ?, success = ?, output_path = ? WHERE id = ?"
    ).run(executor, success ? 1 : 0, outputPath, id);
  } catch {
    // Best effort
  }
}

async function runChain(context: InvestigationContext): Promise<InvestigationResult> {
  const runId = recordStart(context.trigger);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Sanitize trigger to prevent path traversal
  const safeTrigger = context.trigger.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50);
  const logPath = join(LOGS_DIR, `${timestamp}-${safeTrigger}.log`);

  const prompt = buildPrompt(context);

  // Try Claude Code CLI first
  const claudeResult = await runExecutor("claude", CLAUDE_PATH, [
    "--dangerously-skip-permissions",
    "-p",
    prompt,
  ], logPath, INVESTIGATION_TIMEOUT_MS);

  if (claudeResult.success) {
    recordComplete(runId, "claude", true, logPath);
    return claudeResult;
  }

  logger.info({ trigger: context.trigger }, "Claude CLI failed for investigation, trying Codex");

  // Fallback to Codex CLI
  const codexResult = await runExecutor("codex", "codex", [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    'model_reasoning_effort="high"',
    prompt,
  ], logPath, INVESTIGATION_TIMEOUT_MS);

  if (codexResult.success) {
    recordComplete(runId, "codex", true, logPath);
    return codexResult;
  }

  // Both failed
  logger.error({ trigger: context.trigger }, "All investigation executors failed");
  recordComplete(runId, "none", false, logPath);
  return { success: false, output: "All executors failed", executor: "none" };
}

function runExecutor(
  name: string,
  command: string,
  args: string[],
  logPath: string,
  timeout: number
): Promise<InvestigationResult> {
  return new Promise((resolve) => {
    let settled = false;

    const proc = spawn(command, args, {
      cwd: runtimePaths.homeDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
        HOME: runtimePaths.homeDir,
      },
    });

    // Register with process registry
    if (proc.pid) {
      processRegistry.register(proc, {
        command: name,
        type: "investigation",
        timeoutMs: timeout,
        source: "connectivity",
      });
    }

    let output = "";

    // Log header
    try {
      appendFileSync(logPath, `\n=== Investigation [${name}] ${new Date().toISOString()} ===\n`);
    } catch { /* best effort */ }

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (proc.pid) processRegistry.touch(proc.pid);
      try { appendFileSync(logPath, text); } catch { /* best effort */ }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (proc.pid) processRegistry.touch(proc.pid);
      try { appendFileSync(logPath, `[stderr] ${text}`); } catch { /* best effort */ }
    });

    proc.stdin?.end();

    const timeoutId = setTimeout(() => {
      if (settled) return;
      logger.warn({ executor: name, pid: proc.pid }, "Investigation executor timed out");
      try { proc.kill("SIGTERM"); } catch { /* */ }
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* */ }
        // Hard finalize: if process never emits 'close', resolve anyway to avoid mutex deadlock
        setTimeout(() => {
          if (settled) return;
          settled = true;
          logger.error({ executor: name, pid: proc.pid }, "Investigation executor did not exit after SIGKILL, force-resolving");
          resolve({ success: false, output: output.slice(0, 5000) || "Process did not exit", executor: name });
        }, KILL_GRACE_MS);
      }, KILL_GRACE_MS);
    }, timeout);

    proc.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);

      const success = code === 0 && output.length > 0;
      resolve({ success, output: output.slice(0, 5000), executor: name });
    });

    proc.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve({ success: false, output: `Spawn error: ${err.message}`, executor: name });
    });
  });
}

function buildPrompt(context: InvestigationContext): string {
  let prompt = `You are investigating an issue with the Homer daemon.

Trigger: ${context.trigger}
Description: ${context.description}`;

  if (context.errorDetails) {
    prompt += `\nError details: ${context.errorDetails}`;
  }

  prompt += `

Steps:
1. Diagnose the root cause
2. Check for network issues, API outages, or configuration problems
3. Run diagnostic commands if needed
4. Report findings and any fixes applied

Be concise. Focus on actionable findings.`;

  return prompt;
}
