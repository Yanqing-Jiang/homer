/**
 * Unified Agent Runtime Types
 *
 * Core abstractions: Goals → Intents → Proposals → Runs
 *
 * Flow:
 *   Discovery → Proposal (idea) → [Q&A] → Proposal (plan) → Intent → Run
 *                   ↓                           ↓
 *              User approves             Auto-approved (low risk)
 */

// ============================================
// ENUMS & LITERALS
// ============================================

export type GoalCategory = 'work' | 'side_income' | 'learning' | 'life' | 'homer';
export type GoalStatus = 'active' | 'paused' | 'achieved' | 'abandoned';

export type IntentType = 'research' | 'code' | 'content' | 'analysis' | 'maintenance' | 'notification';
export type IntentStatus = 'pending' | 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';

export type ProposalStage = 'idea' | 'research' | 'plan' | 'archived' | 'rejected';
export type ProposalType = 'feature' | 'research' | 'content' | 'improvement' | 'maintenance';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'needs_info';

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';

export type RiskLevel = 'low' | 'medium' | 'high';
export type EffortEstimate = 'trivial' | 'small' | 'medium' | 'large' | 'epic';

export type Executor = 'claude' | 'gemini' | 'kimi' | 'codex' | 'api';
export type Lane = 'work' | 'life' | 'default';

export type ApprovalDecision = 'approved' | 'rejected' | 'deferred' | 'modified';

export type DiscoverySourceType = 'feed' | 'scrape' | 'api' | 'manual';

export type AccountStatus = 'active' | 'rate_limited' | 'disabled' | 'quota_exceeded';
export type AuthMethod = 'cli' | 'api_key' | 'oauth';

// ============================================
// GOALS
// ============================================

export interface Goal {
  id: string;
  title: string;
  description?: string;

  category: GoalCategory;
  priority: number;  // 0-100

  status: GoalStatus;
  progress: number;  // 0.0 to 1.0

  parentGoalId?: string;

  tags?: string[];
  metadata?: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
  achievedAt?: Date;
}

export interface GoalInput {
  title: string;
  description?: string;
  category: GoalCategory;
  priority?: number;
  parentGoalId?: string;
  tags?: string[];
}

// ============================================
// INTENTS
// ============================================

export interface Intent {
  id: string;
  title: string;
  description?: string;

  intentType: IntentType;
  riskLevel: RiskLevel;

  priority: number;
  scheduledFor?: Date;
  deadline?: Date;

  lane: Lane;
  executorPreference?: Executor;

  query: string;
  contextFiles?: string[];
  workingDir?: string;

  goalId?: string;
  sourceProposalId?: string;
  parentIntentId?: string;

  status: IntentStatus;

  tags?: string[];
  metadata?: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
}

export interface IntentInput {
  title: string;
  description?: string;
  intentType: IntentType;
  riskLevel?: RiskLevel;
  priority?: number;
  scheduledFor?: Date;
  deadline?: Date;
  lane?: Lane;
  executorPreference?: Executor;
  query: string;
  contextFiles?: string[];
  workingDir?: string;
  goalId?: string;
  sourceProposalId?: string;
  parentIntentId?: string;
  tags?: string[];
}

// ============================================
// PROPOSALS
// ============================================

export interface Proposal {
  id: string;
  title: string;
  summary?: string;

  stage: ProposalStage;

  proposalType: ProposalType;
  riskLevel: RiskLevel;

  content: string;  // Markdown

  source: string;  // 'discovery' | 'night_supervisor' | 'user' | 'agent'
  sourceDetail?: string;
  sourceUrl?: string;

  goalId?: string;
  parentProposalId?: string;

  approvalStatus: ApprovalStatus;
  approvedBy?: string;
  approvedAt?: Date;
  rejectionReason?: string;

  relevanceScore?: number;
  urgencyScore?: number;
  effortEstimate?: EffortEstimate;

  chatId?: number;
  messageId?: number;

  tags?: string[];
  metadata?: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
}

export interface ProposalInput {
  title: string;
  summary?: string;
  proposalType: ProposalType;
  riskLevel?: RiskLevel;
  content: string;
  source: string;
  sourceDetail?: string;
  sourceUrl?: string;
  goalId?: string;
  relevanceScore?: number;
  urgencyScore?: number;
  effortEstimate?: EffortEstimate;
  tags?: string[];
  expiresAt?: Date;
}

export interface ProposalQA {
  id: string;
  proposalId: string;
  question: string;
  answer?: string;
  askedBy: 'system' | 'user';
  answeredAt?: Date;
  sequence: number;
  createdAt: Date;
}

// ============================================
// RUNS
// ============================================

export interface Run {
  id: string;
  intentId: string;

  executor: Executor;
  executorAccount?: string;

  sessionId?: string;
  contextHash?: string;

  status: RunStatus;

  output?: string;
  error?: string;
  exitCode?: number;

  artifacts?: string[];

  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;

  tokensInput?: number;
  tokensOutput?: number;
  tokensTotal?: number;
  costUsd?: number;

  workerId?: string;
  heartbeatAt?: Date;

  attemptNumber: number;
  retryOfRunId?: string;
}

export interface RunInput {
  intentId: string;
  executor: Executor;
  executorAccount?: string;
  sessionId?: string;
  contextHash?: string;
  workerId?: string;
}

export interface RunResult {
  status: RunStatus;
  output?: string;
  error?: string;
  exitCode?: number;
  artifacts?: string[];
  tokensInput?: number;
  tokensOutput?: number;
  costUsd?: number;
}

// ============================================
// EXECUTOR ACCOUNTS
// ============================================

export interface ExecutorAccount {
  id: string;
  executor: Executor;

  name: string;
  authMethod: AuthMethod;

  dailyLimit?: number;
  monthlyLimit?: number;
  tokensUsedToday: number;
  tokensUsedMonth: number;

  requestsPerMinute?: number;
  lastRequestAt?: Date;
  consecutiveFailures: number;

  status: AccountStatus;
  cooldownUntil?: Date;

  quotaResetDay: number;
  lastQuotaReset?: Date;

  createdAt: Date;
  updatedAt: Date;
}

// ============================================
// APPROVAL HISTORY
// ============================================

export interface ApprovalRecord {
  id: number;
  entityType: 'proposal' | 'intent' | 'run';
  entityId: string;
  decision: ApprovalDecision;
  reason?: string;
  proposalType?: ProposalType;
  riskLevel?: RiskLevel;
  source?: string;
  relevanceScore?: number;
  decidedBy: string;
  presentedAt: Date;
  decidedAt: Date;
  responseTimeMs?: number;
  createdAt: Date;
}

// ============================================
// DISCOVERY SOURCES
// ============================================

export interface DiscoverySource {
  id: string;
  name: string;
  sourceType: DiscoverySourceType;
  config?: Record<string, unknown>;
  enabled: boolean;
  lastCheckedAt?: Date;
  lastCursor?: string;
  itemsFoundTotal: number;
  proposalsCreatedTotal: number;
  checkIntervalMinutes: number;
  nextCheckAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================
// STATE MACHINE: PROPOSAL LIFECYCLE
// ============================================

/**
 * Proposal State Machine
 *
 *                    ┌──────────────────┐
 *                    │                  │
 *   ┌───────────┐    ▼    ┌──────────┐  │   ┌──────────┐
 *   │  CREATE   │───►│   IDEA     │──┼──►│ RESEARCH │
 *   └───────────┘    │            │  │   │          │
 *                    └──────┬─────┘  │   └────┬─────┘
 *                           │        │        │
 *        ┌──────────────────┼────────┘        │
 *        │                  │                 │
 *        ▼                  ▼                 ▼
 *   ┌──────────┐      ┌──────────┐     ┌──────────┐
 *   │ ARCHIVED │◄─────│   PLAN   │◄────┤ (refine) │
 *   │          │      │          │     └──────────┘
 *   └──────────┘      └────┬─────┘
 *        ▲                 │
 *        │                 ▼
 *   ┌──────────┐      ┌──────────┐     ┌──────────┐
 *   │ REJECTED │◄─────│ APPROVED │────►│  INTENT  │
 *   └──────────┘      └──────────┘     │ CREATED  │
 *                                      └──────────┘
 *
 * Transitions:
 *   idea       → research    (user: "tell me more" / "details")
 *   idea       → plan        (fast-track for simple ideas)
 *   idea       → archived    (auto-expire or user dismiss)
 *   idea       → rejected    (user: "not interested")
 *   research   → plan        (research complete, refined understanding)
 *   research   → archived    (research showed no value)
 *   plan       → approved    (user: "approve" or auto for low-risk)
 *   plan       → rejected    (user: "reject")
 *   plan       → archived    (expired)
 *   approved   → intent      (creates Intent record)
 */

export type ProposalTransition =
  | { from: 'idea'; to: 'research'; action: 'request_details' }
  | { from: 'idea'; to: 'plan'; action: 'fast_track' }
  | { from: 'idea'; to: 'archived'; action: 'expire' | 'dismiss' }
  | { from: 'idea'; to: 'rejected'; action: 'reject' }
  | { from: 'research'; to: 'plan'; action: 'finalize_research' }
  | { from: 'research'; to: 'archived'; action: 'research_negative' }
  | { from: 'plan'; to: 'archived'; action: 'expire' }
  | { from: 'plan'; to: 'rejected'; action: 'reject' };

export const VALID_TRANSITIONS: Record<ProposalStage, ProposalStage[]> = {
  idea: ['research', 'plan', 'archived', 'rejected'],
  research: ['plan', 'archived', 'rejected'],
  plan: ['archived', 'rejected'],
  archived: [],  // Terminal
  rejected: [],  // Terminal
};

export function canTransition(from: ProposalStage, to: ProposalStage): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ============================================
// INTENT STATE MACHINE
// ============================================

/**
 * Intent State Machine
 *
 *   ┌──────────┐
 *   │ PENDING  │───────────────────────────────┐
 *   └────┬─────┘                               │
 *        │ schedule()                          │ cancel()
 *        ▼                                     │
 *   ┌──────────┐                               │
 *   │SCHEDULED │───────────────────────────────┼───┐
 *   └────┬─────┘                               │   │
 *        │ execute()                           │   │
 *        ▼                                     │   │
 *   ┌──────────┐                               │   │
 *   │ RUNNING  │───────────────────────────────┼───┤
 *   └────┬─────┘                               │   │
 *        ├────────────┬──────────┐             │   │
 *        │            │          │             │   │
 *        ▼            ▼          ▼             ▼   ▼
 *   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
 *   │COMPLETED │ │  FAILED  │ │ TIMEOUT  │ │CANCELLED │
 *   └──────────┘ └──────────┘ └──────────┘ └──────────┘
 */

export const INTENT_TRANSITIONS: Record<IntentStatus, IntentStatus[]> = {
  pending: ['scheduled', 'running', 'cancelled'],
  scheduled: ['running', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: ['pending'],  // Can retry
  cancelled: [],
};

// ============================================
// EVENTS
// ============================================

export type RuntimeEvent =
  | { type: 'proposal_created'; proposal: Proposal }
  | { type: 'proposal_stage_changed'; proposalId: string; from: ProposalStage; to: ProposalStage }
  | { type: 'proposal_approved'; proposalId: string; intentId: string }
  | { type: 'proposal_rejected'; proposalId: string; reason?: string }
  | { type: 'intent_created'; intent: Intent }
  | { type: 'intent_status_changed'; intentId: string; from: IntentStatus; to: IntentStatus }
  | { type: 'run_started'; run: Run }
  | { type: 'run_completed'; run: Run; result: RunResult }
  | { type: 'run_failed'; run: Run; error: string }
  | { type: 'goal_progress_updated'; goalId: string; progress: number }
  | { type: 'executor_quota_warning'; accountId: string; usagePercent: number };

export type RuntimeEventHandler = (event: RuntimeEvent) => void | Promise<void>;

// ============================================
// QUERY OPTIONS
// ============================================

export interface ProposalQueryOptions {
  stage?: ProposalStage | ProposalStage[];
  approvalStatus?: ApprovalStatus;
  source?: string;
  goalId?: string;
  limit?: number;
  offset?: number;
  orderBy?: 'created_at' | 'relevance_score' | 'urgency_score';
  orderDir?: 'asc' | 'desc';
}

export interface IntentQueryOptions {
  status?: IntentStatus | IntentStatus[];
  lane?: Lane;
  goalId?: string;
  intentType?: IntentType;
  limit?: number;
  offset?: number;
}

export interface RunQueryOptions {
  intentId?: string;
  status?: RunStatus | RunStatus[];
  executor?: Executor;
  executorAccount?: string;
  limit?: number;
  offset?: number;
}

// ============================================
// AGGREGATE TYPES
// ============================================

export interface ProposalWithContext extends Proposal {
  goal?: Goal;
  qaItems?: ProposalQA[];
  unansweredQuestions?: number;
}

export interface IntentWithContext extends Intent {
  goal?: Goal;
  proposal?: Proposal;
  activeRuns?: number;
  lastRun?: Run;
}

export interface RuntimeStats {
  goals: {
    total: number;
    active: number;
    achieved: number;
  };
  proposals: {
    total: number;
    pending: number;
    byStage: Record<ProposalStage, number>;
  };
  intents: {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
  };
  runs: {
    today: number;
    tokensToday: number;
    costToday: number;
    successRate: number;
  };
  executors: {
    activeAccounts: number;
    quotaWarnings: string[];
  };
}
