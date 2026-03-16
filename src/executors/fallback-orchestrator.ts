import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { logger } from "../utils/logger.js";
import { executeClaudeCommand } from "./claude.js";
import { executeGeminiCLI } from "./opencode-cli.js";
import { GEMINI_CLI_FLASH_MODEL, GEMINI_CLI_PRO_MODEL } from "./gemini-cli.js";
import { executeCodexCLI } from "./codex-cli.js";
import { executeKimiCLI } from "./kimi-cli.js";
import { buildConversationContext, CONTEXT_DEFAULTS } from "./context-builder.js";
import type { StateManager } from "../state/manager.js";

export type ExecutorKind = "claude" | "gemini" | "codex" | "kimi" | "opencode";
export type ErrorType = "timeout" | "rate_limit" | "session_timeout" | "auth" | "unknown";

// OpenCode (gemini) last - research/analysis only, no code changes
export const DEFAULT_CHAIN: ExecutorKind[] = ["claude", "codex", "gemini"];
export const MEMORY_CHAIN: ExecutorKind[] = ["gemini", "claude", "codex"];

const FAILURE_DISABLE_THRESHOLD = 2;
const DISABLE_MS = 30 * 60 * 1000;
const MAX_RETRIES_PER_EXECUTOR = 2; // Retry same CLI twice before switching to next

interface HealthState {
  consecutiveFailures: number;
  disabledUntil: number;
  lastError?: string;
}

const HEALTH: Map<ExecutorKind, HealthState> = new Map();

export interface JobContext {
  id: string;
  name: string;
  query: string;
  lane?: string;
  source: "scheduler" | "queue" | "runtime";
}

export interface AttemptInfo {
  executor: ExecutorKind;
  exitCode: number;
  errorType: ErrorType;
  errorSummary: string;
  logPath?: string;
  durationMs: number;
}

export interface FailureContext {
  executor: ExecutorKind;
  exitCode: number;
  errorType: ErrorType;
  errorSummary: string;
  outputSnippet: string;
  logPath?: string;
}

export interface DiagnoseDecision {
  action: "retry_primary" | "switch_next" | "return_primary";
  executor?: ExecutorKind;
  reason?: string;
  resume_instructions?: string;
}

export interface ExecutorAttemptResult {
  exitCode: number;
  output: string;
  error?: string;
  duration: number;
  startedAt?: Date;
  completedAt?: Date;
}

export interface FallbackRunResult<T extends ExecutorAttemptResult> {
  result: T;
  executorUsed: ExecutorKind;
  fallbackUsed: boolean;
  attempts: AttemptInfo[];
  failed: boolean;
}

export function shouldEscalateToPro(
  result: ExecutorAttemptResult,
  jobMeta?: { deep?: boolean }
): boolean {
  if (jobMeta?.deep) return true;
  if (result.exitCode === 2) return true; // rate limit — Pro has separate quota
  const output = result.output ?? "";
  if (result.exitCode === 0 && output.length > 0 && output.length < 200) return true;
  if (/insufficient.*context|need.*deeper|cannot.*analyze/i.test(output)) return true;
  return false;
}

export function isExecutorDisabled(executor: ExecutorKind): boolean {
  const state = HEALTH.get(executor);
  if (!state) return false;
  if (state.disabledUntil > Date.now()) return true;
  return false;
}

export function recordSuccess(executor: ExecutorKind): void {
  const state = HEALTH.get(executor);
  if (!state) return;
  state.consecutiveFailures = 0;
  state.disabledUntil = 0;
  state.lastError = undefined;
}

export function recordFailure(executor: ExecutorKind, errorSummary: string): { disabledNow: boolean } {
  const state = HEALTH.get(executor) ?? {
    consecutiveFailures: 0,
    disabledUntil: 0,
  };
  state.consecutiveFailures += 1;
  state.lastError = errorSummary;
  let disabledNow = false;
  if (state.consecutiveFailures >= FAILURE_DISABLE_THRESHOLD) {
    state.disabledUntil = Date.now() + DISABLE_MS;
    disabledNow = true;
  }
  HEALTH.set(executor, state);
  return { disabledNow };
}

export function classifyError(exitCode: number, errorText: string): ErrorType {
  const text = errorText.toLowerCase();
  if (exitCode === 124 || text.includes("timed out") || text.includes("timeout")) {
    return "timeout";
  }
  if (
    text.includes("rate limit") ||
    text.includes("quota") ||
    text.includes("429") ||
    text.includes("capacity") ||
    text.includes("exhausted")
  ) {
    return "rate_limit";
  }
  if (text.includes("session") && (text.includes("expired") || text.includes("timeout"))) {
    return "session_timeout";
  }
  if (text.includes("unauthorized") || text.includes("auth") || text.includes("forbidden")) {
    return "auth";
  }
  return "unknown";
}

export function getNextInChain(chain: ExecutorKind[], current: ExecutorKind): ExecutorKind | null {
  const idx = chain.indexOf(current);
  if (idx === -1) return null;
  const next = idx + 1 < chain.length ? chain[idx + 1] : undefined;
  return next ?? null;
}

function pickDiagnosticExecutor(chain: ExecutorKind[], current: ExecutorKind): ExecutorKind | null {
  for (const executor of chain) {
    if (executor === current) continue;
    if (!isExecutorDisabled(executor)) return executor;
  }
  return null;
}

function truncate(text: string, max = 1200): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export async function writeLogBundle(
  job: JobContext,
  failure: FailureContext,
  attempts: AttemptInfo[]
): Promise<string> {
  const baseDir = join(process.env.HOME ?? "/Users/yj", "homer", "logs", "fallback");
  await mkdir(baseDir, { recursive: true });
  const filename = `${job.id}-${Date.now()}-${failure.executor}.log`;
  const path = join(baseDir, filename);

  const lines: string[] = [];
  lines.push(`# Fallback Log`);
  lines.push(`Job: ${job.name} (${job.id})`);
  lines.push(`Source: ${job.source}`);
  lines.push(`Executor: ${failure.executor}`);
  lines.push(`Exit: ${failure.exitCode}`);
  lines.push(`ErrorType: ${failure.errorType}`);
  lines.push(`ErrorSummary: ${failure.errorSummary}`);
  lines.push(``);
  lines.push(`Output Snippet:`);
  lines.push(failure.outputSnippet || "(empty)");
  lines.push(``);
  if (attempts.length > 0) {
    lines.push(`Attempt History:`);
    for (const attempt of attempts) {
      lines.push(
        `- ${attempt.executor}: exit ${attempt.exitCode}, ${attempt.errorType}, ${attempt.errorSummary} (${attempt.durationMs}ms)` +
        (attempt.logPath ? ` | ${attempt.logPath}` : "")
      );
    }
  }

  await writeFile(path, lines.join("\n"), "utf-8");
  return path;
}

function buildDiagnosePrompt(
  job: JobContext,
  primary: ExecutorKind,
  chain: ExecutorKind[],
  failure: FailureContext,
  attempts: AttemptInfo[]
): string {
  return `You are diagnosing a failed CLI execution.\n\n` +
    `Job: ${job.name} (${job.id})\n` +
    `Source: ${job.source}\n` +
    `Primary Executor: ${primary}\n` +
    `Chain Order: ${chain.join(" -> ")}\n\n` +
    `Failure:\n` +
    `- Executor: ${failure.executor}\n` +
    `- Exit: ${failure.exitCode}\n` +
    `- ErrorType: ${failure.errorType}\n` +
    `- ErrorSummary: ${failure.errorSummary}\n` +
    (failure.logPath ? `- Log File: ${failure.logPath}\n` : "") +
    `\nRecent Output (truncated):\n${failure.outputSnippet}\n\n` +
    `Attempts:\n${attempts.map(a => `- ${a.executor} (exit ${a.exitCode}): ${a.errorSummary}`).join("\n")}\n\n` +
    `Decide next step. You may ONLY choose:\n` +
    `- retry_primary (retry primary executor)\n` +
    `- switch_next (move to the next executor in chain)\n` +
    `- return_primary (if fix likely, go back to primary)\n\n` +
    `Return JSON only:\n` +
    "```json\n" +
    "{\n" +
    '  "action": "retry_primary | switch_next | return_primary",\n' +
    '  "executor": "claude | gemini | codex | kimi | opencode",\n' +
    '  "reason": "short reason",\n' +
    '  "resume_instructions": "optional instructions to help recovery"\n' +
    "}\n" +
    "```\n";
}

function parseDecision(output: string): DiagnoseDecision | null {
  const fenced = output.match(/```json\n?([\s\S]*?)\n?```/);
  const jsonText = fenced?.[1] ?? output.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText);
    const action = parsed.action as DiagnoseDecision["action"];
    if (!action) return null;
    return {
      action,
      executor: parsed.executor,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      resume_instructions: typeof parsed.resume_instructions === "string" ? parsed.resume_instructions : undefined,
    };
  } catch {
    return null;
  }
}

async function runDiagnosis(
  executor: ExecutorKind,
  prompt: string
): Promise<string | null> {
  try {
    if (executor === "claude") {
      const res = await executeClaudeCommand(prompt, {
        cwd: process.env.HOME ?? "/Users/yj",
        model: "sonnet",
      });
      return res.exitCode === 0 ? res.output : null;
    }
    if (executor === "gemini" || executor === "opencode") {
      const res = await executeGeminiCLI(prompt, "", {
        timeout: 300000,
        sandbox: true,
        model: GEMINI_CLI_FLASH_MODEL,
      });
      return res.exitCode === 0 ? res.output : null;
    }
    if (executor === "codex") {
      const res = await executeCodexCLI(prompt, {
        cwd: process.env.HOME ?? "/Users/yj",
        timeout: 300000,
      });
      return res.exitCode === 0 ? res.output : null;
    }
    const res = await executeKimiCLI(prompt, "", {
      timeout: 300000,
      yolo: true,
      workDir: process.env.HOME ?? "/Users/yj",
    });
    return res.exitCode === 0 ? res.output : null;
  } catch (error) {
    logger.warn({ error, executor }, "Diagnostic executor failed");
    return null;
  }
}

export async function diagnoseDecision(
  job: JobContext,
  primary: ExecutorKind,
  chain: ExecutorKind[],
  failure: FailureContext,
  attempts: AttemptInfo[]
): Promise<DiagnoseDecision> {
  const diagnosticExecutor = pickDiagnosticExecutor(chain, failure.executor);
  if (!diagnosticExecutor) {
    return { action: "switch_next" };
  }
  const prompt = buildDiagnosePrompt(job, primary, chain, failure, attempts);
  const output = await runDiagnosis(diagnosticExecutor, prompt);
  if (!output) {
    return { action: "switch_next" };
  }

  const decision = parseDecision(output);
  if (!decision) {
    return { action: "switch_next" };
  }

  return decision;
}

function normalizeDecision(
  decision: DiagnoseDecision,
  primary: ExecutorKind,
  chain: ExecutorKind[],
  current: ExecutorKind
): DiagnoseDecision {
  if (decision.action === "return_primary" || decision.action === "retry_primary") {
    return { ...decision, action: "retry_primary", executor: primary };
  }
  // switch_next is default
  const next = getNextInChain(chain, current);
  return { ...decision, action: "switch_next", executor: next ?? undefined };
}

export function buildRetryQuery(baseQuery: string, failure: FailureContext, instructions?: string): string {
  const guidance = instructions ? `\n\nRecovery instructions:\n${instructions}` : "";
  const logRef = failure.logPath ? `\n\nLog file: ${failure.logPath}` : "";
  return `${baseQuery}\n\nPrevious error:\n${failure.errorSummary}${logRef}${guidance}\n\nPlease fix the error and continue from the failed attempt.`;
}

export function buildFallbackQuery(
  baseQuery: string,
  failure: FailureContext,
  instructions?: string,
  conversationHistory?: string
): string {
  const guidance = instructions ? `\n\nNotes:\n${instructions}` : "";
  const logRef = failure.logPath ? `\n\nLog file: ${failure.logPath}` : "";

  // If we have conversation history, include it in XML format
  if (conversationHistory) {
    return `<fallback_context>
<notice>
The previous executor (${failure.executor}) encountered an issue.
You are now handling this request. Review the context and continue helping.
</notice>

<error_summary>
${failure.errorSummary}
</error_summary>
${logRef ? `\n<log_reference>${logRef}</log_reference>` : ""}
${guidance ? `\n<guidance>${guidance}</guidance>` : ""}

${conversationHistory}

<original_query>
${baseQuery}
</original_query>
</fallback_context>

Please complete the task fully, taking into account the previous conversation context.`;
  }

  // Legacy format without conversation history
  return `${baseQuery}\n\nPrevious error:\n${failure.errorSummary}${logRef}${guidance}\n\nPlease complete the task fully.`;
}

export async function runWithFallbackChain<T extends ExecutorAttemptResult>(
  params: {
    primary: ExecutorKind;
    chain: ExecutorKind[];
    job: JobContext;
    runExecutor: (executor: ExecutorKind, queryOverride?: string, modelOverride?: string) => Promise<T>;
    notify?: (message: string) => Promise<void>;
    maxAttempts?: number;
    /** StateManager for building conversation context on fallback */
    stateManager?: StateManager;
    /** Skip per-executor LLM diagnosis calls — just switch_next on failure */
    skipDiagnosis?: boolean;
    /** Job metadata for escalation decisions */
    jobMeta?: { deep?: boolean };
  }
): Promise<FallbackRunResult<T>> {
  const { primary, chain, job, runExecutor, notify, maxAttempts, stateManager, skipDiagnosis, jobMeta } = params;
  const attempts: AttemptInfo[] = [];
  let current: ExecutorKind | null = primary;
  let escalatedToProThisRun = false;
  let queryOverride: string | undefined;
  let lastResult: T | null = null;
  let fallbackUsed = false;
  let notifiedFallback = false;
  let attemptsRemaining = maxAttempts ?? chain.length * MAX_RETRIES_PER_EXECUTOR + 1;

  // Track per-executor retry count: retry up to MAX_RETRIES_PER_EXECUTOR times before switching
  const executorAttempts = new Map<ExecutorKind, number>();

  while (current && attemptsRemaining > 0) {
    attemptsRemaining -= 1;

    if (isExecutorDisabled(current)) {
      const nextExecutor = getNextInChain(chain, current);
      if (nextExecutor) {
        current = nextExecutor;
        fallbackUsed = true;
        continue;
      }
      break;
    }

    const attemptNum = (executorAttempts.get(current) ?? 0) + 1;
    executorAttempts.set(current, attemptNum);

    const result = await runExecutor(current, queryOverride);
    lastResult = result;

    if (result.exitCode === 0) {
      recordSuccess(current);
      return {
        result,
        executorUsed: current,
        fallbackUsed,
        attempts,
        failed: false,
      };
    }

    const errorText = `${result.error ?? ""}\n${result.output ?? ""}`.trim();
    const errorSummary = truncate(errorText, 800) || `Exit code ${result.exitCode}`;
    const errorType = classifyError(result.exitCode, errorSummary);
    const failure: FailureContext = {
      executor: current,
      exitCode: result.exitCode,
      errorType,
      errorSummary,
      outputSnippet: truncate(result.output ?? "", 1200),
    };

    failure.logPath = await writeLogBundle(job, failure, attempts);

    const { disabledNow } = recordFailure(current, failure.errorSummary);
    if (disabledNow && notify) {
      await notify(`⚠️ ${current} is failing repeatedly. Disabling for ${Math.round(DISABLE_MS / 60000)}m.`);
    }

    attempts.push({
      executor: current,
      exitCode: result.exitCode,
      errorType,
      errorSummary: failure.errorSummary,
      logPath: failure.logPath,
      durationMs: result.duration,
    });

    // Flash→Pro escalation: try Pro before falling through to next executor
    if (current === "gemini" && !escalatedToProThisRun && shouldEscalateToPro(result, jobMeta)) {
      escalatedToProThisRun = true;
      logger.info({ jobId: job.id, reason: jobMeta?.deep ? "deep_flag" : "auto_escalation" }, "Escalating Gemini Flash → Pro");
      const proResult = await runExecutor("gemini", queryOverride, GEMINI_CLI_PRO_MODEL);
      if (proResult.exitCode === 0) {
        recordSuccess("gemini");
        return { result: proResult, executorUsed: "gemini", fallbackUsed: false, attempts, failed: false };
      }
      attempts.push({
        executor: "gemini",
        exitCode: proResult.exitCode,
        errorType: classifyError(proResult.exitCode, proResult.output ?? ""),
        errorSummary: truncate(`${proResult.error ?? ""}\n${proResult.output ?? ""}`.trim(), 800) || `Exit code ${proResult.exitCode}`,
        durationMs: proResult.duration,
      });
    }

    // Retry same executor up to MAX_RETRIES_PER_EXECUTOR times before switching
    if (attemptNum < MAX_RETRIES_PER_EXECUTOR) {
      logger.info(
        { jobId: job.id, executor: current, attempt: attemptNum, maxRetries: MAX_RETRIES_PER_EXECUTOR },
        "Retrying same executor before fallback"
      );
      queryOverride = buildRetryQuery(job.query, failure);
      continue;
    }

    // Exhausted retries on this executor — run diagnosis or switch
    const rawDecision = skipDiagnosis
      ? { action: "switch_next" as const }
      : await diagnoseDecision(job, primary, chain, failure, attempts);
    const decision = normalizeDecision(rawDecision, primary, chain, current);
    if (decision.action === "retry_primary") {
      const target = decision.executor ?? primary;
      if (!notifiedFallback && target !== primary && notify) {
        notifiedFallback = true;
        await notify(`⚠️ Switching to ${target} for ${job.name} after ${current} failure.`);
      }
      fallbackUsed = fallbackUsed || target !== primary;
      current = target;
      queryOverride = buildRetryQuery(job.query, failure, decision.resume_instructions);
      continue;
    }

    if (decision.action === "switch_next") {
      const nextExecutor: ExecutorKind | null = decision.executor ?? getNextInChain(chain, current);
      if (nextExecutor) {
        if (!notifiedFallback && nextExecutor !== primary && notify) {
          notifiedFallback = true;
          await notify(`⚠️ Switching to ${nextExecutor} for ${job.name} after ${current} failure.`);
        }
        fallbackUsed = fallbackUsed || nextExecutor !== primary;
        current = nextExecutor;

        // Build conversation context for fallback if stateManager available
        let conversationHistory: string | undefined;
        if (stateManager && job.lane) {
          try {
            const sourceType = job.lane.startsWith("web:") ? "thread" : "lane";
            const sourceId = job.lane.startsWith("web:") ? job.lane.replace("web:", "") : job.lane;
            const context = await buildConversationContext(
              stateManager,
              { type: sourceType, id: sourceId },
              { ...CONTEXT_DEFAULTS.fallback }
            );
            if (context.messageCount > 0) {
              conversationHistory = context.formatted;
              logger.debug(
                { lane: job.lane, messageCount: context.messageCount, anchorCount: context.anchorCount },
                "Built conversation context for fallback"
              );
            }
          } catch (err) {
            logger.warn({ err, lane: job.lane }, "Failed to build conversation context for fallback");
          }
        }

        queryOverride = buildFallbackQuery(job.query, failure, decision.resume_instructions, conversationHistory);
        continue;
      }
    }

    // No further executor available
    break;
  }

  return {
    result: lastResult as T,
    executorUsed: current ?? primary,
    fallbackUsed,
    attempts,
    failed: true,
  };
}
