/**
 * Unified Agent Runtime
 *
 * Event-driven runtime for HOMER that replaces the dual-system
 * (Scheduler + NightSupervisor) with a unified approach.
 *
 * Key concepts:
 * - Goals: What the user cares about achieving
 * - Proposals: Ideas requiring approval (idea → research → plan)
 * - Intents: Approved work items ready for execution
 * - Runs: Actual execution records
 *
 * Features:
 * - Event-driven (not polling)
 * - Fail-loud on exhaustion (no silent deferral)
 * - Multi-executor routing: Gemini CLI → API → Kimi → Claude
 * - Proposal pipeline with AI-generated Q&A
 */

// Types
export * from "./types.js";

// Event Bus
export {
  EventBus,
  getEventBus,
  resetEventBus,
  type Signal,
  type SignalType,
  type SignalPriority,
  type SignalHandler,
} from "./event-bus.js";

// Runtime Loop
export {
  UnifiedRuntime,
  getRuntime,
  createRuntime,
  type RuntimeConfig,
} from "./loop.js";
