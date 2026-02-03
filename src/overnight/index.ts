/**
 * Overnight Work Module
 *
 * Enables ad-hoc overnight task processing via Telegram:
 * - "work on xyz tonight" → Prototype generation (3 approaches)
 * - "research xyz for me tonight" → Research deep-dive with synthesis
 *
 * Each task runs overnight with:
 * - Parallel execution using different strategies
 * - Cross-validation of results
 * - Morning presentation with inline choices
 * - PR creation on selection
 */

// Types
export * from "./types.js";

// Core components
export { parseOvernightIntent, mightBeOvernightRequest, formatIntentConfirmation, getTaskTypeDisplay } from "./intent-parser.js";
export { OvernightTaskStore } from "./task-store.js";
export { WorkspaceManager, getWorkspaceManager } from "./workspace.js";
export { PrototypeOrchestrator } from "./prototype-orchestrator.js";
export { ResearchOrchestrator } from "./research-orchestrator.js";
export { MorningPresenter, encodeCallbackData, type SelectionResult, type InlineKeyboardButton } from "./morning-presenter.js";
