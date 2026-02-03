/**
 * Unified Agent Runtime Loop
 *
 * Event-driven runtime that:
 * - Reacts to signals (time, file, webhook, telegram)
 * - Routes work through Gemini → Kimi → Claude → FAIL
 * - Fails LOUD on exhaustion (no silent deferral)
 * - Manages proposal → intent → run lifecycle
 */

import { Bot } from "grammy";
import Database from "better-sqlite3";
import { logger } from "../utils/logger.js";
import { EventBus, getEventBus, type Signal } from "./event-bus.js";
import { initializeRouter, executeWithRouting, getRouterStatus, type RoutingRequest, type TaskType } from "../executors/router.js";
import type { StateManager } from "../state/manager.js";
import type { Intent, Proposal, Run, IntentStatus, ProposalStage, RiskLevel } from "./types.js";

// ============================================
// RUNTIME CONFIGURATION
// ============================================

export interface RuntimeConfig {
  // Event processing
  processIntervalMs: number;       // How often to check for work (default: 100ms)
  maxConcurrentRuns: number;       // Max parallel executions (default: 3)

  // Fail-loud settings
  alertOnExhaustion: boolean;      // Send Telegram alert when exhausted (default: true)
  exhaustionCooldownMs: number;    // Wait before retrying after exhaustion (default: 5min)

  // Telegram
  chatId: number;                  // Where to send alerts

  // Feature flags
  enableProposalPipeline: boolean;
  enableDiscovery: boolean;
  enableScheduledJobs: boolean;
}

const DEFAULT_CONFIG: RuntimeConfig = {
  processIntervalMs: 100,
  maxConcurrentRuns: 3,
  alertOnExhaustion: true,
  exhaustionCooldownMs: 5 * 60 * 1000,
  chatId: 0,
  enableProposalPipeline: true,
  enableDiscovery: true,
  enableScheduledJobs: true,
};

// ============================================
// RUNTIME STATE
// ============================================

interface RuntimeState {
  running: boolean;
  currentRuns: Map<string, Run>;
  exhaustedUntil: number | null;
  lastExhaustionAlert: number;
  stats: {
    signalsProcessed: number;
    runsStarted: number;
    runsCompleted: number;
    runsFailed: number;
    exhaustionEvents: number;
  };
}

// ============================================
// RUNTIME CLASS
// ============================================

export class UnifiedRuntime {
  private config: RuntimeConfig;
  private state: RuntimeState;
  private eventBus: EventBus;
  private bot: Bot | null = null;
  private db: Database.Database;

  constructor(
    stateManager: StateManager,
    config: Partial<RuntimeConfig> = {}
  ) {
    this.db = stateManager.getDb();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventBus = getEventBus();

    this.state = {
      running: false,
      currentRuns: new Map(),
      exhaustedUntil: null,
      lastExhaustionAlert: 0,
      stats: {
        signalsProcessed: 0,
        runsStarted: 0,
        runsCompleted: 0,
        runsFailed: 0,
        exhaustionEvents: 0,
      },
    };

    // Initialize router with database
    initializeRouter(this.db);

    // Register signal handlers
    this.registerSignalHandlers();
  }

  /**
   * Set the Telegram bot for notifications
   */
  setBot(bot: Bot): void {
    this.bot = bot;
  }

  /**
   * Register handlers for different signal types
   */
  private registerSignalHandlers(): void {
    // Time signals (scheduled triggers)
    this.eventBus.onSignal("time", async (signal) => {
      await this.handleTimeSignal(signal);
    });

    // Telegram signals (user commands)
    this.eventBus.onSignal("telegram", async (signal) => {
      await this.handleTelegramSignal(signal);
    });

    // Internal signals (system events)
    this.eventBus.onSignal("internal", async (signal) => {
      await this.handleInternalSignal(signal);
    });

    // File signals (memory changes, etc.)
    this.eventBus.onSignal("file", async (signal) => {
      await this.handleFileSignal(signal);
    });

    logger.info("Runtime signal handlers registered");
  }

  // ============================================
  // LIFECYCLE
  // ============================================

  /**
   * Start the runtime
   */
  async start(): Promise<void> {
    if (this.state.running) {
      logger.warn("Runtime already running");
      return;
    }

    logger.info({ config: this.config }, "Starting unified runtime");
    this.state.running = true;

    // Start event bus processing
    void this.eventBus.startProcessing(this.config.processIntervalMs);

    // Schedule initial work check
    this.eventBus.signal("internal", "runtime", { action: "check_work" }, "normal");

    logger.info("Unified runtime started");
  }

  /**
   * Stop the runtime
   */
  stop(): void {
    if (!this.state.running) {
      return;
    }

    logger.info("Stopping unified runtime");
    this.state.running = false;
    this.eventBus.stop();

    // Wait for current runs to complete (with timeout)
    if (this.state.currentRuns.size > 0) {
      logger.warn(
        { activeRuns: this.state.currentRuns.size },
        "Runtime stopping with active runs"
      );
    }

    logger.info("Unified runtime stopped");
  }

  // ============================================
  // SIGNAL HANDLERS
  // ============================================

  private async handleTimeSignal(signal: Signal): Promise<void> {
    const data = signal.data as { jobId?: string; intentId?: string };
    this.state.stats.signalsProcessed++;

    if (data.intentId) {
      await this.executeIntent(data.intentId);
    } else if (data.jobId) {
      // Legacy scheduled job support
      logger.debug({ jobId: data.jobId }, "Time signal for legacy job");
    }
  }

  private async handleTelegramSignal(signal: Signal): Promise<void> {
    const data = signal.data as {
      action: string;
      proposalId?: string;
      intentId?: string;
      chatId?: number;
    };
    this.state.stats.signalsProcessed++;

    switch (data.action) {
      case "approve_proposal":
        if (data.proposalId) {
          await this.approveProposal(data.proposalId);
        }
        break;

      case "reject_proposal":
        if (data.proposalId) {
          await this.rejectProposal(data.proposalId);
        }
        break;

      case "retry_intent":
        if (data.intentId) {
          await this.executeIntent(data.intentId);
        }
        break;

      default:
        logger.debug({ action: data.action }, "Unknown telegram action");
    }
  }

  private async handleInternalSignal(signal: Signal): Promise<void> {
    const data = signal.data as { action: string; [key: string]: unknown };
    this.state.stats.signalsProcessed++;

    switch (data.action) {
      case "check_work":
        await this.checkPendingWork();
        // Schedule next check if still running
        if (this.state.running) {
          setTimeout(() => {
            this.eventBus.signal("internal", "runtime", { action: "check_work" }, "low");
          }, 5000); // Check every 5 seconds
        }
        break;

      case "run_completed":
        await this.handleRunCompleted(data.runId as string, data.result as unknown);
        break;

      case "run_failed":
        await this.handleRunFailed(data.runId as string, data.error as string);
        break;

      case "executor_exhausted":
        await this.handleExecutorExhaustion();
        break;

      default:
        logger.debug({ action: data.action }, "Unknown internal action");
    }
  }

  private async handleFileSignal(signal: Signal): Promise<void> {
    const data = signal.data as { path: string; event: string };
    this.state.stats.signalsProcessed++;

    logger.debug({ path: data.path, event: data.event }, "File signal received");
    // Future: trigger discovery or context refresh based on file changes
  }

  // ============================================
  // WORK PROCESSING
  // ============================================

  /**
   * Check for pending work and execute if capacity available
   */
  private async checkPendingWork(): Promise<void> {
    // Check exhaustion cooldown
    if (this.state.exhaustedUntil && Date.now() < this.state.exhaustedUntil) {
      logger.debug("In exhaustion cooldown, skipping work check");
      return;
    }

    // Check capacity
    if (this.state.currentRuns.size >= this.config.maxConcurrentRuns) {
      logger.debug({ currentRuns: this.state.currentRuns.size }, "At max concurrent runs");
      return;
    }

    // Get next runnable intent
    const intent = await this.getNextRunnableIntent();
    if (!intent) {
      return;
    }

    // Execute intent
    await this.executeIntent(intent.id);
  }

  /**
   * Get the next intent ready for execution
   */
  private async getNextRunnableIntent(): Promise<Intent | null> {
    try {
      const row = this.db.prepare(`
        SELECT *
        FROM intents
        WHERE status = 'pending'
          AND (scheduled_for IS NULL OR scheduled_for <= datetime('now'))
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
      `).get() as IntentRow | undefined;

      if (!row) {
        return null;
      }

      return this.rowToIntent(row);
    } catch (error) {
      logger.error({ error }, "Failed to get next runnable intent");
      return null;
    }
  }

  // ============================================
  // INTENT EXECUTION
  // ============================================

  /**
   * Execute an intent
   */
  async executeIntent(intentId: string): Promise<void> {
    // Get intent
    const intent = await this.getIntent(intentId);
    if (!intent) {
      logger.error({ intentId }, "Intent not found");
      return;
    }

    // Check if already running
    if (this.state.currentRuns.has(intentId)) {
      logger.warn({ intentId }, "Intent already running");
      return;
    }

    // Update status to running
    await this.updateIntentStatus(intentId, "running");

    // Create run record
    const runId = await this.createRun(intent);
    this.state.stats.runsStarted++;

    logger.info(
      { intentId, runId, title: intent.title, executor: intent.executorPreference },
      "Starting intent execution"
    );

    // Execute via router
    try {
      const request: RoutingRequest = {
        query: intent.query,
        context: intent.contextFiles?.join("\n"),
        taskType: this.intentTypeToTaskType(intent.intentType),
        urgency: "immediate",
        forceExecutor: intent.executorPreference as RoutingRequest["forceExecutor"],
        cwd: intent.workingDir || process.cwd(),
        intentId: intent.id,
      };

      const result = await executeWithRouting(request);

      // Check for exhaustion (fail-loud)
      if (result.failed) {
        this.state.stats.runsFailed++;
        await this.handleExecutorExhaustion();
        await this.updateIntentStatus(intentId, "failed");
        await this.completeRun(runId, "failed", result.output, result.exitCode);

        // FAIL LOUD - send immediate alert
        await this.sendExhaustionAlert(intent, result.output || "All executors exhausted");
        return;
      }

      // Success
      if (result.exitCode === 0) {
        this.state.stats.runsCompleted++;
        await this.updateIntentStatus(intentId, "completed");
        await this.completeRun(runId, "completed", result.output, result.exitCode);
        logger.info({ intentId, runId }, "Intent completed successfully");
      } else {
        this.state.stats.runsFailed++;
        await this.updateIntentStatus(intentId, "failed");
        await this.completeRun(runId, "failed", result.output, result.exitCode);
        logger.warn({ intentId, runId, exitCode: result.exitCode }, "Intent failed");
      }
    } catch (error) {
      this.state.stats.runsFailed++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.updateIntentStatus(intentId, "failed");
      await this.completeRun(runId, "failed", errorMessage, 1);
      logger.error({ error, intentId, runId }, "Intent execution error");
    } finally {
      this.state.currentRuns.delete(intentId);
    }
  }

  // ============================================
  // FAIL-LOUD EXHAUSTION HANDLING
  // ============================================

  /**
   * Handle executor exhaustion - FAIL LOUD
   */
  private async handleExecutorExhaustion(): Promise<void> {
    this.state.stats.exhaustionEvents++;
    this.state.exhaustedUntil = Date.now() + this.config.exhaustionCooldownMs;

    logger.error(
      { exhaustedUntil: new Date(this.state.exhaustedUntil) },
      "EXECUTOR EXHAUSTION - All executors failed"
    );

    // Only send alert once per cooldown period
    const timeSinceLastAlert = Date.now() - this.state.lastExhaustionAlert;
    if (timeSinceLastAlert > this.config.exhaustionCooldownMs) {
      this.state.lastExhaustionAlert = Date.now();

      if (this.bot && this.config.chatId && this.config.alertOnExhaustion) {
        try {
          const status = getRouterStatus();
          await this.bot.api.sendMessage(
            this.config.chatId,
            `🚨 *EXECUTOR EXHAUSTION*\n\n` +
              `All executors failed. Manual intervention required.\n\n` +
              `*Status:*\n` +
              `• Gemini CLI: ${status.geminiCLI.availableAccounts}/${status.geminiCLI.totalAccounts} available\n` +
              `• Daily cost: $${status.dailyCost.toFixed(4)}\n` +
              `• Deferred tasks: ${status.deferredTasks}\n\n` +
              `*Next check:* ${new Date(this.state.exhaustedUntil || Date.now()).toLocaleTimeString()}\n\n` +
              `Use /retry to force retry or /status for details.`,
            { parse_mode: "Markdown" }
          );
        } catch (error) {
          logger.error({ error }, "Failed to send exhaustion alert");
        }
      }
    }
  }

  /**
   * Send alert for specific intent exhaustion
   */
  private async sendExhaustionAlert(intent: Intent, error: string): Promise<void> {
    if (!this.bot || !this.config.chatId) {
      return;
    }

    try {
      await this.bot.api.sendMessage(
        this.config.chatId,
        `❌ *Intent Failed: ${intent.title}*\n\n` +
          `All executors exhausted.\n\n` +
          `Error: ${error.slice(0, 200)}\n\n` +
          `ID: \`${intent.id}\`\n\n` +
          `Reply with:\n` +
          `• \`/retry ${intent.id}\` - Force retry\n` +
          `• \`/cancel ${intent.id}\` - Cancel intent`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      logger.error({ err }, "Failed to send intent exhaustion alert");
    }
  }

  // ============================================
  // PROPOSAL LIFECYCLE
  // ============================================

  /**
   * Approve a proposal and create intent
   */
  async approveProposal(proposalId: string): Promise<string | null> {
    try {
      // Get proposal
      const proposal = await this.getProposal(proposalId);
      if (!proposal) {
        logger.error({ proposalId }, "Proposal not found");
        return null;
      }

      // Update proposal status
      this.db.prepare(`
        UPDATE proposals
        SET approval_status = 'approved', approved_by = 'user', approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(proposalId);

      // Create intent from proposal
      const intentId = await this.createIntentFromProposal(proposal);

      logger.info({ proposalId, intentId }, "Proposal approved, intent created");
      return intentId;
    } catch (error) {
      logger.error({ error, proposalId }, "Failed to approve proposal");
      return null;
    }
  }

  /**
   * Reject a proposal
   */
  async rejectProposal(proposalId: string, reason?: string): Promise<boolean> {
    try {
      this.db.prepare(`
        UPDATE proposals
        SET approval_status = 'rejected', rejection_reason = ?, stage = 'rejected', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(reason || null, proposalId);

      logger.info({ proposalId, reason }, "Proposal rejected");
      return true;
    } catch (error) {
      logger.error({ error, proposalId }, "Failed to reject proposal");
      return false;
    }
  }

  /**
   * Create an intent from an approved proposal
   */
  private async createIntentFromProposal(proposal: Proposal): Promise<string> {
    const intentId = `intent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    const intentType = this.proposalTypeToIntentType(proposal.proposalType);
    const query = this.generateQueryFromProposal(proposal);

    this.db.prepare(`
      INSERT INTO intents (
        id, title, description, intent_type, risk_level, priority,
        lane, query, goal_id, source_proposal_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      intentId,
      proposal.title,
      proposal.summary,
      intentType,
      proposal.riskLevel,
      50, // Default priority
      "default",
      query,
      proposal.goalId || null,
      proposal.id
    );

    return intentId;
  }

  // ============================================
  // DATABASE HELPERS
  // ============================================

  private async getIntent(intentId: string): Promise<Intent | null> {
    try {
      const row = this.db.prepare(`SELECT * FROM intents WHERE id = ?`).get(intentId) as IntentRow | undefined;
      return row ? this.rowToIntent(row) : null;
    } catch {
      return null;
    }
  }

  private async getProposal(proposalId: string): Promise<Proposal | null> {
    try {
      const row = this.db.prepare(`SELECT * FROM proposals WHERE id = ?`).get(proposalId) as ProposalRow | undefined;
      return row ? this.rowToProposal(row) : null;
    } catch {
      return null;
    }
  }

  private async updateIntentStatus(intentId: string, status: IntentStatus): Promise<void> {
    this.db.prepare(`
      UPDATE intents SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(status, intentId);
  }

  private async createRun(intent: Intent): Promise<string> {
    const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    this.db.prepare(`
      INSERT INTO runs (id, intent_id, executor, status, started_at, attempt_number)
      VALUES (?, ?, ?, 'running', CURRENT_TIMESTAMP, 1)
    `).run(runId, intent.id, intent.executorPreference || "claude");

    return runId;
  }

  private async completeRun(
    runId: string,
    status: "completed" | "failed" | "cancelled",
    output?: string,
    exitCode?: number
  ): Promise<void> {
    this.db.prepare(`
      UPDATE runs
      SET status = ?, output = ?, exit_code = ?, completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(status, output || null, exitCode ?? null, runId);
  }

  private async handleRunCompleted(runId: string, _result: unknown): Promise<void> {
    logger.debug({ runId }, "Run completed signal received");
  }

  private async handleRunFailed(runId: string, error: string): Promise<void> {
    logger.debug({ runId, error }, "Run failed signal received");
  }

  // ============================================
  // TYPE CONVERSIONS
  // ============================================

  private intentTypeToTaskType(intentType: string): TaskType {
    const mapping: Record<string, TaskType> = {
      research: "discovery",
      code: "code-change",
      content: "general",
      analysis: "discovery",
      maintenance: "batch",
      notification: "general",
    };
    return mapping[intentType] || "general";
  }

  private proposalTypeToIntentType(proposalType: string): string {
    const mapping: Record<string, string> = {
      feature: "code",
      research: "research",
      content: "content",
      improvement: "code",
      maintenance: "maintenance",
    };
    return mapping[proposalType] || "research";
  }

  private generateQueryFromProposal(proposal: Proposal): string {
    // Build a query from proposal content
    let query = `Task: ${proposal.title}\n\n`;
    if (proposal.summary) {
      query += `Summary: ${proposal.summary}\n\n`;
    }
    query += `Details:\n${proposal.content}`;
    return query;
  }

  private rowToIntent(row: IntentRow): Intent {
    return {
      id: row.id,
      title: row.title,
      description: row.description || undefined,
      intentType: row.intent_type as Intent["intentType"],
      riskLevel: row.risk_level as RiskLevel,
      priority: row.priority,
      scheduledFor: row.scheduled_for ? new Date(row.scheduled_for) : undefined,
      deadline: row.deadline ? new Date(row.deadline) : undefined,
      lane: row.lane as Intent["lane"],
      executorPreference: row.executor_preference as Intent["executorPreference"] || undefined,
      query: row.query,
      contextFiles: row.context_files ? JSON.parse(row.context_files) : undefined,
      workingDir: row.working_dir || undefined,
      goalId: row.goal_id || undefined,
      sourceProposalId: row.source_proposal_id || undefined,
      parentIntentId: row.parent_intent_id || undefined,
      status: row.status as IntentStatus,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private rowToProposal(row: ProposalRow): Proposal {
    return {
      id: row.id,
      title: row.title,
      summary: row.summary || undefined,
      stage: row.stage as ProposalStage,
      proposalType: row.proposal_type as Proposal["proposalType"],
      riskLevel: row.risk_level as RiskLevel,
      content: row.content,
      source: row.source,
      sourceDetail: row.source_detail || undefined,
      sourceUrl: row.source_url || undefined,
      goalId: row.goal_id || undefined,
      parentProposalId: row.parent_proposal_id || undefined,
      approvalStatus: row.approval_status as Proposal["approvalStatus"],
      approvedBy: row.approved_by || undefined,
      approvedAt: row.approved_at ? new Date(row.approved_at) : undefined,
      rejectionReason: row.rejection_reason || undefined,
      relevanceScore: row.relevance_score ?? undefined,
      urgencyScore: row.urgency_score ?? undefined,
      effortEstimate: row.effort_estimate as Proposal["effortEstimate"] || undefined,
      chatId: row.chat_id ?? undefined,
      messageId: row.message_id ?? undefined,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
    };
  }

  // ============================================
  // STATUS & STATS
  // ============================================

  getStatus(): {
    running: boolean;
    currentRuns: number;
    exhaustedUntil: Date | null;
    eventBus: ReturnType<EventBus["getStatus"]>;
    router: ReturnType<typeof getRouterStatus>;
    stats: RuntimeState["stats"];
  } {
    return {
      running: this.state.running,
      currentRuns: this.state.currentRuns.size,
      exhaustedUntil: this.state.exhaustedUntil ? new Date(this.state.exhaustedUntil) : null,
      eventBus: this.eventBus.getStatus(),
      router: getRouterStatus(),
      stats: { ...this.state.stats },
    };
  }
}

// ============================================
// DATABASE ROW TYPES
// ============================================

interface IntentRow {
  id: string;
  title: string;
  description: string | null;
  intent_type: string;
  risk_level: string;
  priority: number;
  scheduled_for: string | null;
  deadline: string | null;
  lane: string;
  executor_preference: string | null;
  query: string;
  context_files: string | null;
  working_dir: string | null;
  goal_id: string | null;
  source_proposal_id: string | null;
  parent_intent_id: string | null;
  status: string;
  tags: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

interface ProposalRow {
  id: string;
  title: string;
  summary: string | null;
  stage: string;
  proposal_type: string;
  risk_level: string;
  content: string;
  source: string;
  source_detail: string | null;
  source_url: string | null;
  goal_id: string | null;
  parent_proposal_id: string | null;
  approval_status: string;
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  relevance_score: number | null;
  urgency_score: number | null;
  effort_estimate: string | null;
  chat_id: number | null;
  message_id: number | null;
  tags: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

// ============================================
// FACTORY FUNCTION
// ============================================

let _runtime: UnifiedRuntime | null = null;

export function getRuntime(): UnifiedRuntime | null {
  return _runtime;
}

export function createRuntime(
  stateManager: StateManager,
  config?: Partial<RuntimeConfig>
): UnifiedRuntime {
  if (_runtime) {
    _runtime.stop();
  }
  _runtime = new UnifiedRuntime(stateManager, config);
  return _runtime;
}
