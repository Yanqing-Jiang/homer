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
import { executeGeminiCLI, getAccountStatus, type GeminiCLIOptions } from "./opencode-cli.js";
import { executeGeminiAPI, type GeminiAPIOptions, type GeminiAPIResult } from "./gemini.js";
import { executeCodexCLI } from "./codex-cli.js";
import { executeKimiCLI, type KimiCLIOptions } from "./kimi-cli.js";
import { executeClaudeCommand, type ClaudeExecutorOptions } from "./claude.js";
import type { ExecutorResult } from "./types.js";
import { runWithFallbackChain, DEFAULT_CHAIN, type ExecutorKind } from "./fallback-orchestrator.js";
import { AccountManager, CostTracker, DeferralQueue, createRouterState, type RouterState } from "./router-db.js";
import { getModelPreferences } from "../preferences/engine.js";

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
  | "opencode"
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
  opencode: { input: 0, output: 0 },               // Free (OpenCode CLI)
  "gemini-api": { input: 0.00025, output: 0.001 }, // $0.25/$1.00 per 1M (flash)
  "kimi": { input: 0, output: 0 },                 // Kimi CLI (Moonshot managed, free tier)
  "claude": { input: 0.003, output: 0.015 },       // Sonnet pricing
  "codex": { input: 0.003, output: 0.015 },        // Uses Claude internally
};

export function trackCost(
  executor: ExecutorType,
  inputTokens: number,
  outputTokens: number,
  options?: { jobId?: string; query?: string; intentId?: string }
): number {
  // Cost telemetry intentionally disabled.
  void executor;
  void inputTokens;
  void outputTokens;
  void options;
  return 0;
}

export function getDailyCost(date?: string): number {
  // Cost telemetry intentionally disabled.
  void date;
  return 0;
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

function buildRoutingCacheKey(taskType: string, promptLength: number, urgency: string): string {
  // Bucket prompt length to reduce cache misses
  const bucket = promptLength < 1000 ? "short" : promptLength < 10000 ? "medium" : "long";
  return `${taskType}:${bucket}:${urgency}`;
}

function buildRoutingPrompt(features: {
  taskType: string;
  promptLength: number;
  urgency: string;
  timeOfDay: number;
  preferences: string;
}): string {
  return `Pick the best executor for this task. Available executors and their strengths:
- claude: Best for complex reasoning, code generation, nuanced analysis. Expensive.
- opencode (Gemini Flash): Best for research, file reading, browser tasks. Free. Fast.
- codex (GPT-5.3): Best for deep reasoning, architecture, debugging. Expensive. Slow.
- kimi (K2.5): Best for web search, long-context analysis, multilingual tasks. Free.

Task type: ${features.taskType}
Prompt length: ${features.promptLength} chars
Urgency: ${features.urgency}
Time: ${features.timeOfDay}h
${features.preferences ? `User model preferences:\n${features.preferences}` : ""}

Rules:
- For "batch" or overnight tasks, prefer free executors (opencode, kimi)
- For "code-change", prefer claude or codex
- For "discovery", prefer opencode or kimi
- For "long-context" (>10000 chars), prefer kimi
- For "verification", prefer codex

Return JSON: { "executor": "claude|opencode|codex|kimi", "fallbackChain": ["...", "..."], "reason": "one sentence" }`;
}

function parseRoutingResponse(output: string): { executor: ExecutorType; fallbackChain: ExecutorType[]; reason: string } | null {
  try {
    const parsed = JSON.parse(output);
    const validExecutors: ExecutorType[] = ["claude", "opencode", "codex", "kimi"];
    if (!validExecutors.includes(parsed.executor)) return null;
    return {
      executor: parsed.executor,
      fallbackChain: (parsed.fallbackChain || []).filter((e: string) => validExecutors.includes(e as ExecutorType)),
      reason: parsed.reason || "LLM-selected",
    };
  } catch {
    return null;
  }
}

/**
 * Primary routing decision — LLM-driven with hardcoded fallback.
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

  // Check cache first
  const promptLength = (request.query?.length || 0) + (request.context?.length || 0);
  const cacheKey = buildRoutingCacheKey(taskType, promptLength, urgency);
  const cached = routingCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < ROUTING_CACHE_TTL) {
    return { ...cached.decision, reason: `[cached] ${cached.decision.reason}` };
  }

  // Deterministic fast-path for common patterns
  const cliStatus = getGeminiCLIPoolStatus();
  const defaultFallbackChain: ExecutorType[] = ["codex", "kimi", "opencode"];
  if (cliStatus.allExhausted) {
    const idx = defaultFallbackChain.indexOf("opencode");
    if (idx >= 0) defaultFallbackChain.splice(idx, 1);
  }

  // Use task-type heuristics (sync, no LLM call — fast path)
  let executor: ExecutorType = "claude";
  let reason = `${taskType} task`;

  switch (taskType) {
    case "discovery":
      executor = cliStatus.allExhausted ? "kimi" : "opencode";
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
      executor = cliStatus.allExhausted ? "kimi" : "opencode";
      reason = "Batch → free executor (overnight)";
      break;
    default:
      executor = "claude";
      reason = "General → Claude (default)";
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

/**
 * Async LLM-driven routing — for use when the caller can await.
 * Falls back to makeRoutingDecision() on failure.
 */
export async function makeSmartRoutingDecision(request: RoutingRequest): Promise<RoutingDecision> {
  const {
    taskType = "general",
    urgency = "immediate",
    estimatedTokens = 2000,
  } = request;

  // Force executor short-circuits
  if (request.forceExecutor) {
    return makeRoutingDecision(request);
  }

  const promptLength = (request.query?.length || 0) + (request.context?.length || 0);
  const cacheKey = buildRoutingCacheKey(taskType, promptLength, urgency);
  const cached = routingCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < ROUTING_CACHE_TTL) {
    return { ...cached.decision, reason: `[cached] ${cached.decision.reason}` };
  }

  // Gather model preferences from DB
  let prefContext = "";
  try {
    if (_db) {
      const prefs = getModelPreferences(_db);
      if (prefs.length > 0) {
        prefContext = prefs.map(p => `${p.dimension}: ${p.score.toFixed(2)}`).join(", ");
      }
    }
  } catch { /* preferences may not exist yet */ }

  try {
    const result = await executeGeminiAPI(
      buildRoutingPrompt({
        taskType,
        promptLength,
        urgency,
        timeOfDay: new Date().getHours(),
        preferences: prefContext,
      }),
      { model: "flash3", maxTokens: 200, responseMimeType: "application/json" }
    );

    if (result.exitCode === 0 && result.output) {
      const parsed = parseRoutingResponse(result.output);
      if (parsed) {
        const decision: RoutingDecision = {
          executor: parsed.executor,
          fallbackChain: parsed.fallbackChain,
          reason: `[smart] ${parsed.reason}`,
          estimatedCost: estimateCost(parsed.executor, estimatedTokens),
          canDefer: urgency !== "immediate",
          deferred: false,
        };

        // Cache
        routingCache.set(cacheKey, { decision, timestamp: Date.now() });

        logger.info({
          executor: parsed.executor,
          reason: parsed.reason,
          taskType,
        }, "Smart routing decision made");

        return decision;
      }
    }
  } catch (err) {
    logger.debug({ error: err }, "Smart routing LLM call failed, using defaults");
  }

  // Fallback to deterministic routing
  return makeRoutingDecision(request);
}

function mapExecutorTypeToKind(executor: ExecutorType): ExecutorKind | null {
  switch (executor) {
    case "claude":
      return "claude";
    case "opencode":
      return "gemini";
    case "codex":
      return "codex";
    case "kimi":
      return "kimi";
    case "gemini-api":
      return null;
    default:
      return null;
  }
}

function mapExecutorKindToType(executor: ExecutorKind): ExecutorType {
  switch (executor) {
    case "claude":
      return "claude";
    case "gemini":
      return "opencode";
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
    return [...DEFAULT_CHAIN];
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

  if (decision.executor === "gemini-api") {
    const apiResult = await executeOnExecutor(decision.executor, request);
    if (apiResult.exitCode === 0 && "inputTokens" in apiResult) {
      const inputTokens = (apiResult as GeminiAPIResult).inputTokens || request.estimatedTokens || 2000;
      const outputTokens = (apiResult as GeminiAPIResult).outputTokens || Math.floor(inputTokens * 0.5);
      trackCost(decision.executor, inputTokens, outputTokens, {
        jobId: request.jobId,
        query: request.query,
        intentId: request.intentId,
      });
    }

    return {
      ...apiResult,
      decision,
      executorUsed: "gemini-api",
      fallbacksAttempted: 0,
      fallbackUsed: false,
      failed: apiResult.exitCode !== 0,
    };
  }

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

    if (executor === "claude") {
      const res = await executeClaudeCommand(query, {
        cwd,
        model: request.model,
      } as ClaudeExecutorOptions);
      return {
        ...res,
        error: res.exitCode === 0 ? undefined : res.output,
        startedAt,
        completedAt: new Date(),
      };
    }

    if (executor === "gemini") {
      const res = await executeGeminiCLI(query, "", {
        model: request.model || "gemini-3-flash-preview",
        sandbox: true,
        yolo: true,
      } as GeminiCLIOptions);
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

  const lastResult = fallbackResult.result;
  const executorUsed = mapExecutorKindToType(fallbackResult.executorUsed);
  const fallbacksAttempted = fallbackResult.attempts.length;

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
// INDIVIDUAL EXECUTOR DISPATCH
// ============================================

async function executeOnExecutor(
  executor: ExecutorType,
  request: RoutingRequest
): Promise<ExecutorResult> {
  const { query, context = "", cwd = process.cwd(), model } = request;

  switch (executor) {
    case "opencode":
      return executeGeminiCLI(query, context, {
        model: model || "gemini-3-flash-preview",
        yolo: true,
        sandbox: true,
      } as GeminiCLIOptions);

    case "gemini-api":
      return executeGeminiAPI(context ? `${context}\n\n---\n\n${query}` : query, {
        model: model || "flash",
      } as GeminiAPIOptions);

    case "kimi":
      return executeKimiCLI(context ? `${context}\n\n---\n\n${query}` : query, "", {
        model: model || undefined, // Use Kimi CLI config default (moonshot-ai/kimi-k2.5)
        timeout: 1200000,
        yolo: true,
        workDir: cwd,
      } as KimiCLIOptions);

    case "claude":
      return executeClaudeCommand(query, {
        cwd,
      } as ClaudeExecutorOptions);

    case "codex":
      return executeCodexCLI(query, {
        cwd,
        timeout: 1200000,
      });

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
    case "opencode":
      return "opencode";
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
