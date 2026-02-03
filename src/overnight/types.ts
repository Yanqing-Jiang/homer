/**
 * Overnight Work Types
 *
 * Types for ad-hoc overnight task processing:
 * - Prototype iteration (3 parallel approaches)
 * - Research deep dives (query expansion + synthesis)
 */

// ============================================
// TASK TYPES
// ============================================

export type OvernightTaskType = "prototype_work" | "research_dive";

export type OvernightTaskStatus =
  | "queued"        // Waiting for overnight execution
  | "clarifying"    // Awaiting user clarification
  | "planning"      // Generating approaches
  | "executing"     // Running iterations
  | "synthesizing"  // Cross-validation and ranking
  | "ready"         // Morning choices prepared
  | "presented"     // Choices shown to user
  | "selected"      // User made a selection
  | "applied"       // Selection applied (PR created)
  | "skipped"       // User skipped
  | "failed"        // Execution failed
  | "expired";      // Not reviewed in time

export type IterationStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export type ApproachLabel = "A" | "B" | "C";

export type ApproachName = "Conservative" | "Innovative" | "Pragmatic";

// Use router ExecutorType for compatibility
import type { ExecutorType as RouterExecutorType } from "../executors/router.js";
export type ExecutorType = RouterExecutorType;

// ============================================
// CORE ENTITIES
// ============================================

export interface OvernightTask {
  id: string;
  type: OvernightTaskType;
  subject: string;
  constraints: string[];
  iterations: number;
  chatId: number;
  messageId?: number;
  status: OvernightTaskStatus;
  scheduledFor?: Date;
  confidenceScore?: number;
  error?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface OvernightIteration {
  id: string;
  taskId: string;
  approachLabel: ApproachLabel;
  approachName: ApproachName;
  approachDescription?: string;
  status: IterationStatus;
  workspacePath?: string;
  gitBranch?: string;
  output?: string;
  artifacts: string[];
  validationScore?: number;
  validationNotes?: string;
  executor?: ExecutorType;
  tokenUsage?: number;
  durationMs?: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface MorningChoice {
  id: string;
  taskId: string;
  options: RankedOption[];
  comparisonMatrix: ComparisonMatrix;
  recommendation: ApproachLabel;
  recommendationReason: string;
  messageId?: number;
  selectedOption?: ApproachLabel | "skip";
  selectedAt?: Date;
  prUrl?: string;
  prNumber?: number;
  expiresAt: Date;
  createdAt: Date;
}

export interface OvernightMilestone {
  id: number;
  taskId: string;
  milestone: MilestoneType;
  message: string;
  messageId?: number;
  createdAt: Date;
}

// ============================================
// OPTION & COMPARISON TYPES
// ============================================

export type MilestoneType =
  | "queued"
  | "started"
  | "planning"
  | "iteration_start"
  | "iteration_complete"
  | "synthesis"
  | "ready"
  | "selected"
  | "applied"
  | "failed";

export interface RankedOption {
  label: ApproachLabel;
  name: ApproachName;
  description: string;
  linesChanged: number;
  filesChanged: number;
  riskLevel: "low" | "medium" | "high";
  validationScore: number;
  summary: string;
  highlights: string[];
  concerns?: string[];
}

export interface ComparisonMatrix {
  headers: string[];
  rows: ComparisonRow[];
}

export interface ComparisonRow {
  approach: ApproachLabel;
  name: ApproachName;
  values: Record<string, string | number>;
}

// ============================================
// INTENT PARSING
// ============================================

export interface ParsedOvernightIntent {
  isOvernight: boolean;
  taskType?: OvernightTaskType;
  subject?: string;
  constraints: string[];
  confidence: number;
  rawMessage: string;
  clarificationNeeded?: ClarificationPrompt;
}

export interface ClarificationPrompt {
  question: string;
  options: ClarificationOption[];
}

export interface ClarificationOption {
  label: string;
  value: string;
  description?: string;
}

// ============================================
// ORCHESTRATOR TYPES
// ============================================

export interface ApproachStrategy {
  label: ApproachLabel;
  name: ApproachName;
  description: string;
  executor: ExecutorType;
  prompt: string;
}

export interface PrototypeConfig {
  taskId: string;
  subject: string;
  constraints: string[];
  projectPath?: string;
  iterations: number;
}

export interface ResearchConfig {
  taskId: string;
  subject: string;
  constraints: string[];
  maxQueries: number;
  maxSources: number;
}

export interface OrchestratorResult {
  success: boolean;
  iterations: OvernightIteration[];
  synthesis?: string;
  error?: string;
  durationMs: number;
  totalTokens: number;
}

// ============================================
// WORKSPACE TYPES
// ============================================

export interface WorkspaceConfig {
  taskId: string;
  approachLabel: ApproachLabel;
  basePath: string;
  sourcePath?: string;
}

export interface Workspace {
  path: string;
  branch: string;
  created: boolean;
}

// ============================================
// EXECUTOR ROUTING
// ============================================

/**
 * Maps approach strategy to executor for prototype work:
 * - Conservative: Codex (precision, established patterns)
 * - Innovative: Gemini (creativity, exploration)
 * - Pragmatic: Claude (balanced approach)
 */
export const APPROACH_EXECUTORS: Record<ApproachName, ExecutorType> = {
  Conservative: "codex",
  Innovative: "gemini-cli",
  Pragmatic: "claude",
};

/**
 * Research executor routing:
 * - Query expansion: Gemini (web grounding)
 * - Deep synthesis: Kimi (2M context)
 * - Validation: Codex (verification)
 */
export const RESEARCH_EXECUTORS = {
  queryExpansion: "gemini-cli" as ExecutorType,
  harvest: "gemini-cli" as ExecutorType,
  synthesis: "kimi" as ExecutorType,
  validation: "codex" as ExecutorType,
};

// ============================================
// CONFIGURATION
// ============================================

export interface OvernightConfig {
  // Workspace
  workspacesDir: string;
  workspaceRetentionDays: number;

  // Execution
  defaultIterations: number;
  maxIterations: number;
  jobTimeout: number;
  totalTimeout: number;

  // Budget
  maxBudgetPerTask: number;  // In dollars

  // Presentation
  choiceExpirationHours: number;
  morningBriefingHour: number;

  // Intent parsing
  clarificationThreshold: number;  // Confidence below this triggers clarification
}

export const DEFAULT_OVERNIGHT_CONFIG: OvernightConfig = {
  workspacesDir: `${process.env.HOME}/homer/workspaces`,
  workspaceRetentionDays: 7,
  defaultIterations: 3,
  maxIterations: 5,
  jobTimeout: 600000,     // 10 min per iteration
  totalTimeout: 7200000,  // 2 hours total per task
  maxBudgetPerTask: 5.00,
  choiceExpirationHours: 24,
  morningBriefingHour: 7,
  clarificationThreshold: 0.7,
};

// ============================================
// TELEGRAM CALLBACK DATA
// ============================================

export interface OvernightCallbackData {
  action: "select" | "compare" | "clarify" | "skip";
  taskId: string;
  option?: ApproachLabel | string;
}

export function encodeCallbackData(data: OvernightCallbackData): string {
  return `overnight:${data.action}:${data.taskId}:${data.option || ""}`;
}

export function decodeCallbackData(raw: string): OvernightCallbackData | null {
  const parts = raw.split(":");
  if (parts.length < 3 || parts[0] !== "overnight") return null;

  return {
    action: parts[1] as OvernightCallbackData["action"],
    taskId: parts[2] ?? "",
    option: (parts[3] ?? undefined) as ApproachLabel | string | undefined,
  };
}
