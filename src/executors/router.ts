/**
 * Executor Routing System for HOMER
 *
 * Manages intelligent routing between executors based on:
 * - Task type (research, long-context, code changes, verification)
 * - Cost optimization (free tier first, API fallback)
 * - Account rotation with cooldown tracking
 * - Fail-loud on exhaustion (no silent deferral)
 *
 * Fallback chain: Gemini CLI (3 accounts) → Gemini API → FAIL
 */

import Database from "better-sqlite3";
import { logger } from "../utils/logger.js";
import { executeGeminiCLI, getAccountStatus, type GeminiCLIOptions } from "./gemini-cli.js";
import { executeGeminiAPI, type GeminiAPIOptions, type GeminiAPIResult } from "./gemini.js";
import { executeKimiCommand, type KimiExecutorOptions } from "./kimi.js";
import { executeClaudeCommand, type ClaudeExecutorOptions } from "./claude.js";
import type { ExecutorResult } from "./types.js";
import { AccountManager, CostTracker, DeferralQueue, createRouterState, type RouterState } from "./router-db.js";

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
  | "gemini-cli"
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
const COST_PER_1K_TOKENS: Record<ExecutorType, { input: number; output: number }> = {
  "gemini-cli": { input: 0, output: 0 },           // Free (with subscription)
  "gemini-api": { input: 0.00025, output: 0.001 }, // $0.25/$1.00 per 1M (flash)
  "kimi": { input: 0, output: 0 },                 // Free via NVIDIA NIM
  "claude": { input: 0.003, output: 0.015 },       // Sonnet pricing
  "codex": { input: 0.003, output: 0.015 },        // Uses Claude internally
};

export function trackCost(
  executor: ExecutorType,
  inputTokens: number,
  outputTokens: number,
  options?: { jobId?: string; query?: string; intentId?: string }
): number {
  const state = getRouterState();
  return state.costs.track(executor, inputTokens, outputTokens, options);
}

export function getDailyCost(date?: string): number {
  const state = getRouterState();
  return state.costs.getDailyCost(date);
}

export function estimateCost(
  executor: ExecutorType,
  estimatedInputTokens: number,
  estimatedOutputTokens: number = estimatedInputTokens * 0.5
): number {
  const rates = COST_PER_1K_TOKENS[executor];
  return (estimatedInputTokens / 1000) * rates.input + (estimatedOutputTokens / 1000) * rates.output;
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
  // Use in-memory account status from gemini-cli.ts for real-time accuracy
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

/**
 * Primary routing decision tree
 *
 * Task Type Routing:
 * | Task Type     | Primary     | Fallback      |
 * |---------------|-------------|---------------|
 * | Discovery     | Gemini CLI  | Gemini API    |
 * | Long context  | Kimi        | Gemini API    |
 * | Code changes  | Claude      | N/A (require) |
 * | Verification  | Codex       | Claude        |
 * | Batch         | Kimi        | Gemini API    |
 * | General       | Gemini CLI  | Gemini API    |
 */
export function makeRoutingDecision(request: RoutingRequest): RoutingDecision {
  const {
    taskType = "general",
    urgency = "immediate",
    forceExecutor,
    estimatedTokens = 2000,
  } = request;

  // Force executor override (for testing)
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

  // Check Gemini CLI availability
  const cliStatus = getGeminiCLIPoolStatus();
  const cliAvailable = !cliStatus.allExhausted;

  // Long context tasks (>60k tokens) → Kimi first
  if (taskType === "long-context" || estimatedTokens > 60000) {
    return {
      executor: "kimi",
      fallbackChain: ["gemini-api"],
      reason: `Long context task (${estimatedTokens} tokens), using Kimi for free long-context processing`,
      estimatedCost: estimateCost("kimi", estimatedTokens),
      canDefer: urgency !== "immediate",
      deferred: false,
    };
  }

  // Code changes → Claude only (requires tool use)
  if (taskType === "code-change") {
    return {
      executor: "claude",
      fallbackChain: [],
      reason: "Code changes require Claude (tool use capability)",
      estimatedCost: estimateCost("claude", estimatedTokens),
      canDefer: false,
      deferred: false,
    };
  }

  // Verification → Codex (deep reasoning) with Claude fallback
  if (taskType === "verification") {
    return {
      executor: "codex",
      fallbackChain: ["claude"],
      reason: "Verification task, using Codex for deep reasoning",
      estimatedCost: estimateCost("codex", estimatedTokens),
      canDefer: urgency !== "immediate",
      deferred: false,
    };
  }

  // Batch processing → Kimi (free, good for overnight tasks)
  if (taskType === "batch" || urgency === "batch") {
    return {
      executor: "kimi",
      fallbackChain: ["gemini-api"],
      reason: "Batch processing, using Kimi for free execution",
      estimatedCost: estimateCost("kimi", estimatedTokens),
      canDefer: true,
      deferred: false,
    };
  }

  // Discovery/Research and General → Gemini CLI first (free)
  if (cliAvailable) {
    return {
      executor: "gemini-cli",
      fallbackChain: ["gemini-api"],
      reason: `${taskType === "discovery" ? "Discovery" : "General"} task, using free Gemini CLI`,
      estimatedCost: 0,
      canDefer: urgency !== "immediate",
      deferred: false,
    };
  }

  // CLI exhausted → Gemini API (NO silent deferral - fail loud)
  return {
    executor: "gemini-api",
    fallbackChain: [],
    reason: "Gemini CLI accounts exhausted, using Gemini API (charged)",
    estimatedCost: estimateCost("gemini-api", estimatedTokens),
    canDefer: false,
    deferred: false,
  };
}

// ============================================
// EXECUTION WITH ROUTING
// ============================================

export async function executeWithRouting(
  request: RoutingRequest
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

  // Build execution chain
  const executorChain = [decision.executor, ...decision.fallbackChain];
  let lastResult: ExecutorResult | null = null;
  let fallbacksAttempted = 0;
  let executorUsed = decision.executor;

  for (const executor of executorChain) {
    try {
      lastResult = await executeOnExecutor(executor, request);

      // Track cost for paid executors
      if (executor !== "gemini-cli" && executor !== "kimi") {
        const inputTokens = (lastResult as GeminiAPIResult).inputTokens || request.estimatedTokens || 2000;
        const outputTokens = (lastResult as GeminiAPIResult).outputTokens || Math.floor(inputTokens * 0.5);
        trackCost(executor, inputTokens, outputTokens, {
          jobId: request.jobId,
          query: request.query,
          intentId: request.intentId,
        });
      }

      // Success - return result
      if (lastResult.exitCode === 0) {
        executorUsed = executor;
        break;
      }

      // Quota error (exit code 2) - try fallback
      if (lastResult.exitCode === 2) {
        logger.info({ executor, exitCode: 2 }, "Quota exhausted, trying fallback");
        fallbacksAttempted++;
        continue;
      }

      // Other errors - check if we should fallback
      if (decision.fallbackChain.includes(executor as ExecutorType)) {
        logger.warn({ executor, exitCode: lastResult.exitCode }, "Executor failed, trying fallback");
        fallbacksAttempted++;
        continue;
      }

      // No more fallbacks
      executorUsed = executor;
      break;

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ executor, error: message }, "Executor threw exception");

      lastResult = {
        output: `Error: ${message}`,
        exitCode: 1,
        duration: Date.now() - startTime,
        executor,
      };

      fallbacksAttempted++;
    }
  }

  // All executors failed - FAIL LOUD (no silent deferral)
  if (lastResult && lastResult.exitCode !== 0) {
    logger.error(
      {
        executorsAttempted: executorChain.slice(0, fallbacksAttempted + 1),
        lastError: lastResult.output?.slice(0, 200),
        taskType: request.taskType,
        urgency: request.urgency,
      },
      "ALL EXECUTORS EXHAUSTED - FAIL LOUD"
    );

    return {
      output: `EXECUTOR EXHAUSTION: All executors failed. Last error: ${lastResult.output?.slice(0, 500)}`,
      exitCode: 1,
      duration: Date.now() - startTime,
      executor: "router",
      decision,
      executorUsed,
      fallbacksAttempted,
      failed: true,  // Signal that this needs manual intervention
    };
  }

  return {
    ...(lastResult || {
      output: "No executor available",
      exitCode: 1,
      duration: Date.now() - startTime,
      executor: "router",
    }),
    decision,
    executorUsed,
    fallbacksAttempted,
  };
}

// ============================================
// INDIVIDUAL EXECUTOR DISPATCH
// ============================================

async function executeOnExecutor(
  executor: ExecutorType,
  request: RoutingRequest
): Promise<ExecutorResult> {
  const { query, context = "", cwd = process.cwd(), model } = request;

  switch (executor) {
    case "gemini-cli":
      return executeGeminiCLI(query, context, {
        model: model || "gemini-3-flash-preview",
        yolo: true,
        sandbox: true,
      } as GeminiCLIOptions);

    case "gemini-api":
      return executeGeminiAPI(context ? `${context}\n\n---\n\n${query}` : query, {
        model: model || "flash",
        maxTokens: 8192,
      } as GeminiAPIOptions);

    case "kimi":
      return executeKimiCommand(context ? `${context}\n\n---\n\n${query}` : query, {
        modelSize: "large",
        maxTokens: 8192,
      } as KimiExecutorOptions);

    case "claude":
      return executeClaudeCommand(query, {
        cwd,
      } as ClaudeExecutorOptions);

    case "codex":
      // Codex is a Claude subagent
      return executeClaudeCommand(query, {
        cwd,
        subagent: "codex",
      } as ClaudeExecutorOptions);

    default:
      throw new Error(`Unknown executor: ${executor}`);
  }
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
    dailyCost: getDailyCost(),
    deferredTasks: deferralStats.pending + deferralStats.processing,
    pendingDeferrals: deferralStats.pending,
    dbConnected: _db !== null,
  };
}

/**
 * Quick check if any executor is available for immediate use
 */
export function canExecuteImmediately(taskType: TaskType = "general"): boolean {
  // Claude/Codex always available
  if (taskType === "code-change" || taskType === "verification") {
    return true;
  }

  // Check Gemini CLI or Kimi for free execution
  const cliStatus = getGeminiCLIPoolStatus();
  return !cliStatus.allExhausted;
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
  sessionExecutor: "claude" | "gemini" | "codex" | "kimi" | "chatgpt"
): ExecutorType {
  switch (sessionExecutor) {
    case "claude":
      return "claude";
    case "gemini":
      return "gemini-cli";
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
