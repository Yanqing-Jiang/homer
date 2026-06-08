/**
 * Executor Module Index
 *
 * Exports all executor types and the routing system.
 */

// Base types
export type { ExecutorResult, ExecutorOptions } from "./types.js";

// Individual executors
export {
  executeClaudeCommand,
  type ClaudeExecutorOptions,
  type ClaudeExecutorResult,
} from "./claude.js";
export {
  executeCodexCLI,
  type CodexCLIOptions,
  type CodexCLIResult,
} from "./codex-cli.js";
export {
  getAccountStatus,
  resetAccountCooldowns,
  executeOpenCodeCLI,
  executeOpenCodeWithFallback,
  streamOpenCodeCLI,
  type GeminiCLIOptions,
  type GeminiCLIResult,
  type OpenCodeCLIOptions,
  type OpenCodeCLIResult,
} from "./opencode-cli.js";
export {
  executeGeminiCLIDirect,
  executeGeminiFlashResearch,
  executeGeminiProResearch,
  GEMINI_CLI_FLASH_MODEL,
  GEMINI_CLI_PRO_MODEL,
  type GeminiCLIDirectOptions,
  type GeminiCLIDirectResult,
} from "./gemini-cli.js";
export {
  executeGeminiAPI,
  researchWithGemini,
  summarizeWithGemini,
  planWithGemini,
  checkGeminiAPIHealth,
  type GeminiAPIOptions,
  type GeminiAPIResult,
} from "./gemini.js";
export {
  executeKimiCommand,
  summarizeWithKimi,
  extractMemoryFacts,
  type KimiExecutorOptions,
  type KimiExecutorResult,
} from "./kimi.js";
export {
  executeKimiCLI,
  type KimiCLIOptions,
  type KimiCLIResult,
} from "./kimi-cli.js";
export {
  executeKimiAgent,
  kimiResearch,
  kimiDesign,
  kimiSummarize,
  type KimiAgentOptions,
  type KimiAgentResult,
} from "./kimi-agent.js";

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
