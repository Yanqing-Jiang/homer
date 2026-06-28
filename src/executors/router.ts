/**
 * Executor Routing System for HOMER
 *
 * Manages intelligent routing between executors based on:
 * - Task type (research, long-context, code changes, verification)
 * - Deterministic CLI fallbacks with LLM diagnose & decide
 * - Fail-loud on exhaustion (no silent deferral)
 *
 * Fallback chain: Claude → Codex → Kimi → OpenCode
 */

import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { logger } from "../utils/logger.js";
import { executeOpenCodeCLI, getAccountStatus, type OpenCodeCLIOptions } from "./opencode-cli.js";
import { executeCodexCLI } from "./codex-cli.js";
import { executeKimiCLI, type KimiCLIOptions } from "./kimi-cli.js";
import { executeClaudeCommand, type ClaudeExecutorOptions } from "./claude.js";
import type { ExecutorResult } from "./types.js";
import { runWithFallbackChain, DEFAULT_FALLBACK_ORDER, type ExecutorKind } from "./fallback-orchestrator.js";
import { getExecutorModel } from "../commands/index.js";
import { AccountManager, CostTracker, DeferralQueue, createRouterState, type RouterState } from "./router-db.js";
import { writeChainTrace } from "./trace-writer.js";

// ============================================
// TYPES
// ============================================

export type TaskType =
  | "discovery"      // Web research, documentation lookup
  | "long-context"   // >60k tokens, document analysis
  | "code-change"    // File modifications, refactoring
  | "verification"   // Code review, correctness checks
  | "batch"          // Overnight processing, non-urgent
  | "general";       // Default catch-all

export type ExecutorType =
  | "opencode"      // GLM-5.2 edit harness (opencode-go/glm-5.2)
  | "gemini"        // Gemini 3.5 Flash research path (opencode OAuth, CLI)
  | "gemini-api"
  | "kimi"
  | "claude"
  | "codex";

export type Urgency = "immediate" | "soon" | "batch";

export interface RoutingRequest {
  query: string;
  context?: string;
  taskType?: TaskType;
  urgency?: Urgency;
  forceExecutor?: ExecutorType;
  estimatedTokens?: number;
  cwd?: string;
  model?: string;
  intentId?: string;  // Link to unified runtime intent
  jobId?: string;     // Link to scheduled job
}

export interface RoutingDecision {
  executor: ExecutorType;
  fallbackChain: ExecutorType[];
  reason: string;
  estimatedCost: number;
  canDefer: boolean;
  deferred: boolean;
}

export interface RoutedExecutionResult extends ExecutorResult {
  decision: RoutingDecision;
  executorUsed: ExecutorType;
  fallbacksAttempted: number;
  deferralId?: string;
  failed?: boolean;  // True if all executors exhausted
  fallbackUsed?: boolean;
}

// ============================================
// DATABASE-BACKED STATE (Singleton)
// ============================================

let _routerState: RouterState | null = null;
let _db: Database.Database | null = null;

/**
 * Initialize the router with a database connection.
 * Must be called before using routing functions.
 */
export function initializeRouter(db: Database.Database): void {
  _db = db;
  _routerState = createRouterState(db);
  logger.info("Router initialized with database-backed state");
}

/**
 * Get the router state, initializing with default path if needed.
 */
function getRouterState(): RouterState {
  if (!_routerState) {
    // Lazy initialization with default path
    const defaultPath = process.env.HOMER_DB_PATH || `${process.env.HOME}/homer/data/homer.db`;
    logger.warn({ dbPath: defaultPath }, "Router auto-initializing with default database path");
    _db = new Database(defaultPath);
    _db.pragma("busy_timeout = 5000");
    _routerState = createRouterState(_db);
  }
  return _routerState;
}

// Re-export DB classes for external use
export { AccountManager, CostTracker, DeferralQueue };

// ============================================
// COST TRACKING (DB-backed)
// ============================================

// Approximate costs per 1K tokens (USD)
const COST_PER_1K_TOKENS: Record<string, { input: number; output: number }> = {
  opencode: { input: 0.0006, output: 0.0022 },     // opencode-go/glm-5.2 (GLM Zen pricing, Phase 3 refines)
  "gemini": { input: 0.00025, output: 0.001 },     // Gemini 3.5 Flash research path (opencode OAuth)
  "gemini-api": { input: 0.00025, output: 0.001 }, // $0.25/$1.00 per 1M (flash)
  "kimi": { input: 0, output: 0 },                 // Kimi CLI (Moonshot managed, free tier)
  "claude": { input: 0.003, output: 0.015 },       // Sonnet pricing
  "codex": { input: 0.003, output: 0.015 },        // Uses Claude internally
};

export function estimateCost(
  executor: ExecutorType,
  estimatedInputTokens: number,
  estimatedOutputTokens: number = estimatedInputTokens * 0.5
): number {
  const rates = COST_PER_1K_TOKENS[executor] ?? { input: 0, output: 0 };
  return (estimatedInputTokens / 1000) * rates.input + (estimatedOutputTokens / 1000) * rates.output;
}

/**
 * Global default harness for generic auto-routing (migration 104 harness_default).
 * Conservative: any read failure falls back to "claude" so we never accidentally route
 * to GLM when state is unreadable.
 */
function getHarnessDefaultExecutor(): ExecutorType {
  try {
    const db = _db ?? (getRouterState(), _db);
    if (!db) return "claude";
    const row = db.prepare("SELECT executor FROM harness_default WHERE id = 1").get() as
      | { executor: "claude" | "opencode" }
      | undefined;
    return row?.executor ?? "claude";
  } catch {
    return "claude";
  }
}

// ============================================
// EXECUTOR FEEDBACK (DB-backed, persistent)
// ============================================

/**
 * Record an executor attempt result for adaptive routing.
 */
export function recordExecutorFeedback(
  taskType: string,
  executor: string,
  success: boolean,
  durationMs?: number,
  errorCategory?: string,
  model?: string,
  promptTokens?: number,
): void {
  try {
    const db = _db ?? (getRouterState(), _db);
    if (!db) return;
    db.prepare(`
      INSERT INTO executor_feedback (id, task_type, executor, model, success, duration_ms, error_category, prompt_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `ef_${Date.now()}_${randomUUID().slice(0, 8)}`,
      taskType, executor, model ?? null, success ? 1 : 0,
      durationMs ?? null, errorCategory ?? null, promptTokens ?? null,
    );
  } catch (err) {
    logger.debug({ error: err }, "Failed to record executor feedback (table may not exist yet)");
  }
}

/**
 * Get success rate for an executor on a task type (last 30 days).
 * Returns null if no data available.
 */
export function getExecutorSuccessRate(
  taskType: string,
  executor: string,
): number | null {
  try {
    const db = _db ?? (getRouterState(), _db);
    if (!db) return null;
    const row = db.prepare(`
      SELECT AVG(success) as rate, COUNT(*) as cnt
      FROM executor_feedback
      WHERE task_type = ? AND executor = ?
        AND created_at > datetime('now', '-30 days')
    `).get(taskType, executor) as { rate: number | null; cnt: number } | undefined;
    if (!row || row.cnt < 3) return null; // Need at least 3 data points
    return row.rate;
  } catch {
    return null;
  }
}

/**
 * Get executors to avoid for a task type (success rate < 30% in last 30 days).
 */
export function getWeakExecutors(taskType: string): Set<string> {
  const weak = new Set<string>();
  try {
    const db = _db ?? (getRouterState(), _db);
    if (!db) return weak;
    const rows = db.prepare(`
      SELECT executor, AVG(success) as rate, COUNT(*) as cnt
      FROM executor_feedback
      WHERE task_type = ? AND created_at > datetime('now', '-30 days')
      GROUP BY executor
      HAVING cnt >= 3 AND rate < 0.30
    `).all(taskType) as Array<{ executor: string; rate: number; cnt: number }>;
    for (const r of rows) weak.add(r.executor);
  } catch {
    // table may not exist yet
  }
  return weak;
}

/**
 * Purge executor feedback older than 90 days.
 */
export function purgeOldFeedback(): number {
  try {
    const db = _db ?? (getRouterState(), _db);
    if (!db) return 0;
    const result = db.prepare(`
      DELETE FROM executor_feedback WHERE created_at < datetime('now', '-90 days')
    `).run();
    return result.changes;
  } catch {
    return 0;
  }
}

// ============================================
// GEMINI CLI ACCOUNT STATUS (DB-backed)
// ============================================

export interface AccountPoolStatus {
  totalAccounts: number;
  availableAccounts: number;
  allExhausted: boolean;
  nextAvailableIn: number | null; // ms until next account available, null if available now
}

export function getGeminiCLIPoolStatus(): AccountPoolStatus {
  // Use in-memory account status from opencode-cli.ts for real-time accuracy
  // (DB state is for persistence across restarts)
  const accounts = getAccountStatus();
  const available = accounts.filter(a => a.available);
  const inCooldown = accounts.filter(a => !a.available && a.cooldownRemaining > 0);

  let nextAvailableIn: number | null = null;
  if (available.length === 0 && inCooldown.length > 0) {
    nextAvailableIn = Math.min(...inCooldown.map(a => a.cooldownRemaining));
  }

  return {
    totalAccounts: accounts.length,
    availableAccounts: available.length,
    allExhausted: available.length === 0,
    nextAvailableIn,
  };
}

// ============================================
// DEFERRAL QUEUE (DB-backed)
// ============================================

export interface DeferredTask {
  id: string;
  request: RoutingRequest;
  decision: RoutingDecision;
  createdAt: number;
  scheduledFor: number;  // When to attempt execution
  attempts: number;
  lastError?: string;
  status: "pending" | "processing" | "completed" | "failed";
}

export function deferTask(
  request: RoutingRequest,
  decision: RoutingDecision,
  scheduleForMs: number = 3600000 // Default: 1 hour
): string {
  const state = getRouterState();
  return state.deferrals.defer(request, decision, scheduleForMs);
}

export function getDeferredTasks(): DeferredTask[] {
  const state = getRouterState();
  return state.deferrals.getPending(1000); // Get up to 1000 for backwards compat
}

export function getPendingDeferrals(): DeferredTask[] {
  const state = getRouterState();
  return state.deferrals.getPending(100);
}

export function updateDeferralStatus(
  id: string,
  status: DeferredTask["status"],
  error?: string
): void {
  const state = getRouterState();
  state.deferrals.updateStatus(id, status, error);
}

export function removeDeferral(id: string): void {
  const state = getRouterState();
  state.deferrals.remove(id);
}

// ============================================
// ROUTING DECISION TREE
// ============================================

// ============================================
// LLM-DRIVEN ROUTING
// ============================================

// Cache for routing decisions (5-min TTL)
const routingCache = new Map<string, { decision: RoutingDecision; timestamp: number }>();
const ROUTING_CACHE_TTL = 300000; // 5 minutes

function buildRoutingCacheKey(
  taskType: string,
  promptLength: number,
  urgency: string,
  harnessDefault: ExecutorType
): string {
  // Bucket prompt length to reduce cache misses
  const bucket = promptLength < 1000 ? "short" : promptLength < 10000 ? "medium" : "long";
  // Include the live harness default: a /harness kill-switch flip must invalidate any cached
  // decision whose executor was derived from it (otherwise a flip lags up to ROUTING_CACHE_TTL).
  return `${taskType}:${bucket}:${urgency}:${harnessDefault}`;
}

/**
 * Primary routing decision — deterministic heuristic-based.
 *
 * Uses Gemini Flash API (cheapest, fastest) to pick the best executor.
 * Falls back to deterministic defaults if the LLM call fails.
 */
export function makeRoutingDecision(request: RoutingRequest): RoutingDecision {
  const {
    taskType = "general",
    urgency = "immediate",
    forceExecutor,
    estimatedTokens = 2000,
  } = request;

  // Force executor override
  if (forceExecutor) {
    return {
      executor: forceExecutor,
      fallbackChain: [],
      reason: `Forced executor: ${forceExecutor}`,
      estimatedCost: estimateCost(forceExecutor, estimatedTokens),
      canDefer: false,
      deferred: false,
    };
  }

  // Check cache first. Read the live harness default once and fold it into the key so a
  // kill-switch flip can't be masked by a stale cached decision.
  const harnessDefault = getHarnessDefaultExecutor();
  const promptLength = (request.query?.length || 0) + (request.context?.length || 0);
  const cacheKey = buildRoutingCacheKey(taskType, promptLength, urgency, harnessDefault);
  const cached = routingCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < ROUTING_CACHE_TTL) {
    return { ...cached.decision, reason: `[cached] ${cached.decision.reason}` };
  }

  // Deterministic fast-path for common patterns
  const cliStatus = getGeminiCLIPoolStatus();
  const weakExecutors = getWeakExecutors(taskType);
  // "gemini" = Gemini 3.5 Flash research path (cheap/high-volume). Distinct from the
  // "opencode" GLM-5.2 edit harness, which is reserved for explicit user-facing turns.
  const defaultFallbackChain: ExecutorType[] = ["codex", "kimi", "gemini"]
    .filter(e => !weakExecutors.has(e)) as ExecutorType[];
  if (cliStatus.allExhausted) {
    const idx = defaultFallbackChain.indexOf("gemini");
    if (idx >= 0) defaultFallbackChain.splice(idx, 1);
  }

  // Use task-type heuristics (sync, no LLM call — fast path)
  let executor: ExecutorType = "claude";
  let reason = `${taskType} task`;

  switch (taskType) {
    case "discovery":
      executor = cliStatus.allExhausted ? "kimi" : "gemini";
      reason = "Discovery → free research executor";
      break;
    case "long-context":
      executor = "kimi";
      reason = "Long context → Kimi (large context window)";
      break;
    case "code-change":
      executor = "claude";
      reason = "Code changes → Claude (best code gen)";
      break;
    case "verification":
      executor = "codex";
      reason = "Verification → Codex (deep reasoning)";
      break;
    case "batch":
      executor = cliStatus.allExhausted ? "kimi" : "gemini";
      reason = "Batch → free executor (overnight)";
      break;
    default:
      executor = harnessDefault;
      reason = `General → harness default (${executor})`;
  }

  // Build fallback chain: remove primary from chain, keep others
  const fallbackChain = defaultFallbackChain.filter(e => e !== executor);
  if (!fallbackChain.includes("claude") && executor !== "claude") {
    fallbackChain.unshift("claude"); // Always have Claude as fallback
  }

  const decision: RoutingDecision = {
    executor,
    fallbackChain,
    reason,
    estimatedCost: estimateCost(executor, estimatedTokens),
    canDefer: urgency !== "immediate",
    deferred: false,
  };

  // Cache the decision
  routingCache.set(cacheKey, { decision, timestamp: Date.now() });

  return decision;
}

function mapExecutorTypeToKind(executor: ExecutorType): ExecutorKind | null {
  switch (executor) {
    case "claude":
      return "claude";
    case "opencode":
      return "opencode"; // GLM-5.2 edit harness (decoupled from the gemini flash kind)
    case "gemini":
      return "gemini"; // Gemini 3.5 Flash research path
    case "codex":
      return "codex";
    case "kimi":
      return "kimi";
    default:
      return null;
  }
}

function mapExecutorKindToType(executor: ExecutorKind): ExecutorType {
  switch (executor) {
    case "claude":
      return "claude";
    case "opencode":
      return "opencode"; // GLM-5.2 edit harness
    case "gemini":
      return "gemini"; // Gemini 3.5 Flash research path
    case "codex":
      return "codex";
    case "kimi":
      return "kimi";
    default:
      return "claude";
  }
}

function buildExecutorChain(decision: RoutingDecision): ExecutorKind[] {
  const chain: ExecutorKind[] = [];
  const seen = new Set<ExecutorKind>();
  const push = (executor: ExecutorKind | null) => {
    if (!executor || seen.has(executor)) return;
    chain.push(executor);
    seen.add(executor);
  };

  push(mapExecutorTypeToKind(decision.executor));
  for (const fallback of decision.fallbackChain) {
    push(mapExecutorTypeToKind(fallback));
  }

  if (chain.length === 0) {
    return [...DEFAULT_FALLBACK_ORDER];
  }

  return chain;
}

// ============================================
// EXECUTION WITH ROUTING
// ============================================

export async function executeWithRouting(
  request: RoutingRequest,
  options?: { notify?: (message: string) => Promise<void> }
): Promise<RoutedExecutionResult> {
  const startTime = Date.now();
  const decision = makeRoutingDecision(request);

  logger.info(
    {
      taskType: request.taskType,
      urgency: request.urgency,
      executor: decision.executor,
      fallbackChain: decision.fallbackChain,
      canDefer: decision.canDefer,
      estimatedCost: decision.estimatedCost,
    },
    "Routing decision made"
  );

  const baseQuery = request.context
    ? `${request.context}\n\n---\n\n${request.query}`
    : request.query;
  const jobId = request.jobId ?? request.intentId ?? `router_${randomUUID().slice(0, 8)}`;
  const jobName = request.query.slice(0, 80);

  const chain = buildExecutorChain(decision);
  const primary = chain[0] ?? "claude";

  const runExecutor = async (
    executor: ExecutorKind,
    queryOverride?: string
  ): Promise<ExecutorResult & { error?: string; startedAt: Date; completedAt: Date }> => {
    const query = queryOverride ?? baseQuery;
    const startedAt = new Date();
    const cwd = request.cwd ?? process.cwd();

    // request.model is meant for the primary executor only. On fallback to a *different* executor
    // kind, drop it so a GLM/Claude/flash model string never reaches an incompatible CLI — each
    // fallback executor uses its own default model instead.
    const modelForExecutor = executor === primary ? request.model : undefined;

    if (executor === "claude") {
      const res = await executeClaudeCommand(query, {
        cwd,
        model: modelForExecutor,
      } as ClaudeExecutorOptions);
      return {
        ...res,
        error: res.exitCode === 0 ? undefined : res.output,
        startedAt,
        completedAt: new Date(),
      };
    }

    if (executor === "gemini") {
      const res = await executeOpenCodeCLI(query, "", {
        model: modelForExecutor || "google/gemini-3.5-flash",
        forceOpenCode: true,
        sandbox: true,
        yolo: true,
      } as OpenCodeCLIOptions);
      return {
        ...res,
        error: res.exitCode === 0 ? undefined : res.output,
        startedAt,
        completedAt: new Date(),
      };
    }

    if (executor === "opencode") {
      // GLM-5.2 edit harness — edit-capable (researchOnly:false + build agent + skip-perms).
      const res = await executeOpenCodeCLI(query, "", {
        model: modelForExecutor || getExecutorModel("opencode"),
        forceOpenCode: true,
        researchOnly: false,
        agent: "build",
        cwd,
        sandbox: true,
        yolo: true,
      } as OpenCodeCLIOptions);
      return {
        ...res,
        error: res.exitCode === 0 ? undefined : res.output,
        startedAt,
        completedAt: new Date(),
      };
    }

    if (executor === "codex") {
      const res = await executeCodexCLI(query, {
        cwd,
        timeout: 1800000,
      });
      return {
        ...res,
        error: res.exitCode === 0 ? undefined : res.output,
        startedAt,
        completedAt: new Date(),
      };
    }

    const res = await executeKimiCLI(query, "", {
      timeout: 1200000,
      yolo: true,
      workDir: cwd,
    } as KimiCLIOptions);
    return {
      ...res,
      error: res.exitCode === 0 ? undefined : res.output,
      startedAt,
      completedAt: new Date(),
    };
  };

  const fallbackResult = await runWithFallbackChain({
    primary,
    chain,
    job: {
      id: jobId,
      name: jobName,
      query: baseQuery,
      source: "runtime",
    },
    runExecutor,
    notify: options?.notify,
  });

  writeChainTrace(fallbackResult, { jobId, source: "router" });

  const lastResult = fallbackResult.result;
  const executorUsed = mapExecutorKindToType(fallbackResult.executorUsed);
  const fallbacksAttempted = fallbackResult.attempts.length;

  // Record executor feedback for adaptive routing
  const success = lastResult != null && lastResult.exitCode === 0 && !fallbackResult.failed;
  recordExecutorFeedback(
    request.taskType ?? "general",
    executorUsed,
    success,
    Date.now() - startTime,
    success ? undefined : "execution_failure",
    request.model,
    request.estimatedTokens,
  );

  // Track cost from executor metrics if available
  if (lastResult?.metrics?.inputTokens || lastResult?.metrics?.outputTokens) {
    getRouterState().costs.track(
      executorUsed,
      lastResult.metrics.inputTokens ?? 0,
      lastResult.metrics.outputTokens ?? 0,
      { jobId, runId: jobId },
    );
  }

  if (!lastResult || lastResult.exitCode !== 0 || fallbackResult.failed) {
    const lastOutput = lastResult?.output ?? "No output";
    logger.error(
      {
        executorsAttempted: chain,
        lastError: lastOutput.slice(0, 200),
        taskType: request.taskType,
        urgency: request.urgency,
      },
      "ALL EXECUTORS EXHAUSTED - FAIL LOUD"
    );

    return {
      output: `EXECUTOR EXHAUSTION: All executors failed. Last error: ${lastOutput.slice(0, 500)}`,
      exitCode: 1,
      duration: Date.now() - startTime,
      executor: "router",
      decision,
      executorUsed,
      fallbacksAttempted,
      fallbackUsed: fallbackResult.fallbackUsed,
      failed: true,
    };
  }

  return {
    ...lastResult,
    decision,
    executorUsed,
    fallbacksAttempted,
    fallbackUsed: fallbackResult.fallbackUsed,
  };
}

// ============================================
// BATCH PROCESSOR (for deferred tasks)
// ============================================

export async function processDeferredBatch(
  maxTasks: number = 10
): Promise<{ processed: number; succeeded: number; failed: number }> {
  const pending = getPendingDeferrals().slice(0, maxTasks);

  if (pending.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  logger.info({ count: pending.length }, "Processing deferred task batch");

  let succeeded = 0;
  let failed = 0;

  for (const task of pending) {
    updateDeferralStatus(task.id, "processing");

    try {
      // Re-evaluate routing (accounts may be available now)
      const result = await executeWithRouting({
        ...task.request,
        urgency: "immediate", // Don't re-defer
      });

      if (result.exitCode === 0) {
        updateDeferralStatus(task.id, "completed");
        succeeded++;
        // Remove completed tasks after success
        removeDeferral(task.id);
      } else {
        updateDeferralStatus(task.id, "failed", result.output);
        failed++;

        // Remove after max attempts
        if (task.attempts >= 3) {
          logger.warn({ taskId: task.id, attempts: task.attempts }, "Deferred task failed max attempts, removing");
          removeDeferral(task.id);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateDeferralStatus(task.id, "failed", message);
      failed++;
    }
  }

  logger.info({ processed: pending.length, succeeded, failed }, "Deferred batch completed");

  return { processed: pending.length, succeeded, failed };
}

// ============================================
// HEALTH & STATUS
// ============================================

export interface RouterStatus {
  geminiCLI: AccountPoolStatus;
  dailyCost: number;
  deferredTasks: number;
  pendingDeferrals: number;
  dbConnected: boolean;
}

export function getRouterStatus(): RouterStatus {
  const state = getRouterState();
  const deferralStats = state.deferrals.getStats();

  return {
    geminiCLI: getGeminiCLIPoolStatus(),
    dailyCost: state.costs.getDailyCost(),
    deferredTasks: deferralStats.pending + deferralStats.processing,
    pendingDeferrals: deferralStats.pending,
    dbConnected: _db !== null,
  };
}

/**
 * Quick check if any executor is available for immediate use
 */
export function canExecuteImmediately(taskType: TaskType = "general"): boolean {
  // Claude/Codex/Kimi are always available in the CLI chain
  void taskType;
  return true;
}

/**
 * Reset router state (for testing)
 */
export function resetRouterState(): void {
  _routerState = null;
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ============================================
// SESSION-BASED EXECUTION
// ============================================

/**
 * Execute a request for a specific session with optional executor override.
 *
 * This is the main entry point for session-aware execution that respects
 * persistent executor switching (e.g., after /gemini command).
 */
export async function executeForSession(
  request: RoutingRequest,
  executorOverride?: ExecutorType
): Promise<RoutedExecutionResult> {
  // If executor is overridden, force that executor
  if (executorOverride) {
    return executeWithRouting({
      ...request,
      forceExecutor: executorOverride,
    });
  }

  // Otherwise use normal routing
  return executeWithRouting(request);
}

/**
 * Map session executor type to routing executor type
 */
export function mapSessionExecutorToRouting(
  sessionExecutor: "claude" | "gemini" | "codex" | "kimi" | "chatgpt" | "opencode"
): ExecutorType {
  switch (sessionExecutor) {
    case "claude":
      return "claude";
    case "gemini":
      return "gemini"; // Gemini 3.5 Flash research path
    case "opencode":
      return "opencode"; // GLM-5.2 edit harness
    case "codex":
      return "codex";
    case "kimi":
      return "kimi";
    case "chatgpt":
      // ChatGPT is handled via browser skill, not direct execution
      // Fall back to Claude which can use the browser skill
      return "claude";
    default:
      return "claude";
  }
}
