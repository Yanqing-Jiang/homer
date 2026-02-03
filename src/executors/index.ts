/**
 * Executor Module Index
 *
 * Exports all executor types and the routing system.
 */

// Base types
export type { ExecutorResult, ExecutorOptions } from "./types.js";

// Individual executors
export { executeClaudeCommand, type ClaudeExecutorOptions, type ClaudeExecutorResult } from "./claude.js";
export { executeCodexCLI, type CodexCLIOptions, type CodexCLIResult } from "./codex-cli.js";
export { executeGeminiCLI, executeGeminiWithFallback, streamGeminiCLI, getAccountStatus, resetAccountCooldowns, type GeminiCLIOptions, type GeminiCLIResult } from "./gemini-cli.js";
export { executeGeminiAPI, researchWithGemini, summarizeWithGemini, planWithGemini, checkGeminiAPIHealth, type GeminiAPIOptions, type GeminiAPIResult } from "./gemini.js";
export { executeKimiCommand, summarizeWithKimi, extractMemoryFacts, type KimiExecutorOptions, type KimiExecutorResult } from "./kimi.js";

// Router system
export {
  // Types
  type TaskType,
  type ExecutorType,
  type Urgency,
  type RoutingRequest,
  type RoutingDecision,
  type RoutedExecutionResult,
  type DeferredTask,
  type AccountPoolStatus,
  type RouterStatus,

  // Core functions
  makeRoutingDecision,
  executeWithRouting,

  // Cost tracking
  trackCost,
  getDailyCost,
  estimateCost,

  // Deferral management
  deferTask,
  getDeferredTasks,
  getPendingDeferrals,
  updateDeferralStatus,
  removeDeferral,
  processDeferredBatch,

  // Status & health
  getGeminiCLIPoolStatus,
  getRouterStatus,
  canExecuteImmediately,
} from "./router.js";

// Database-backed router state
export {
  AccountManager,
  CostTracker,
  DeferralQueue,
  createRouterState,
  type RouterState,
} from "./router-db.js";
