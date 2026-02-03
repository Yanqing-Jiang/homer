/**
 * Database-backed Router State Management
 *
 * Provides persistence for:
 * - Executor account rotation state (unified executor_accounts table)
 * - Cost tracking with daily aggregation
 * - Deferral queue for batch processing
 */

import type Database from "better-sqlite3";
import { createHash } from "crypto";
import { logger } from "../utils/logger.js";
import type { RoutingRequest, RoutingDecision, TaskType, DeferredTask } from "./router.js";

// ============================================
// ACCOUNT STATE (DB-backed)
// ============================================

interface DBAccountRow {
  id: string;
  executor: string;
  name: string;
  auth_method: string;
  home_path: string | null;
  daily_limit: number | null;
  tokens_used_today: number;
  cooldown_until: string | null;
  consecutive_failures: number;
  status: string;
  last_request_at: string | null;
}

export class AccountManager {
  private stmts: {
    getAll: Database.Statement<[]>;
    getByExecutor: Database.Statement<[string]>;
    getAvailable: Database.Statement<[string, string]>;
    setCooldown: Database.Statement<[string, string]>;
    incrementFailures: Database.Statement<[string]>;
    resetFailures: Database.Statement<[string]>;
    recordUsage: Database.Statement<[string, string]>;
    resetAllCooldowns: Database.Statement<[string]>;
    updateStatus: Database.Statement<[string, string]>;
    incrementTokens: Database.Statement<[number, string]>;
    resetDailyTokens: Database.Statement<[]>;
  };

  constructor(db: Database.Database) {
    this.stmts = {
      getAll: db.prepare(`
        SELECT id, executor, name, auth_method, home_path, daily_limit,
               tokens_used_today, cooldown_until, consecutive_failures, status, last_request_at
        FROM executor_accounts
        ORDER BY executor, id
      `),
      getByExecutor: db.prepare(`
        SELECT id, executor, name, auth_method, home_path, daily_limit,
               tokens_used_today, cooldown_until, consecutive_failures, status, last_request_at
        FROM executor_accounts
        WHERE executor = ?
        ORDER BY id
      `),
      getAvailable: db.prepare(`
        SELECT id, executor, name, auth_method, home_path, daily_limit,
               tokens_used_today, cooldown_until, consecutive_failures, status, last_request_at
        FROM executor_accounts
        WHERE executor = ?
          AND status = 'active'
          AND (cooldown_until IS NULL OR cooldown_until <= ?)
          AND consecutive_failures < 5
          AND (daily_limit IS NULL OR tokens_used_today < daily_limit)
        ORDER BY last_request_at ASC NULLS FIRST
        LIMIT 1
      `),
      setCooldown: db.prepare(`
        UPDATE executor_accounts
        SET cooldown_until = ?, consecutive_failures = consecutive_failures + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `),
      incrementFailures: db.prepare(`
        UPDATE executor_accounts
        SET consecutive_failures = consecutive_failures + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `),
      resetFailures: db.prepare(`
        UPDATE executor_accounts
        SET consecutive_failures = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `),
      recordUsage: db.prepare(`
        UPDATE executor_accounts
        SET last_request_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `),
      resetAllCooldowns: db.prepare(`
        UPDATE executor_accounts
        SET cooldown_until = NULL, consecutive_failures = 0, updated_at = CURRENT_TIMESTAMP
        WHERE executor = ?
      `),
      updateStatus: db.prepare(`
        UPDATE executor_accounts
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `),
      incrementTokens: db.prepare(`
        UPDATE executor_accounts
        SET tokens_used_today = tokens_used_today + ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `),
      resetDailyTokens: db.prepare(`
        UPDATE executor_accounts
        SET tokens_used_today = 0, updated_at = CURRENT_TIMESTAMP
      `),
    };
  }

  getAll(): DBAccountRow[] {
    return this.stmts.getAll.all() as DBAccountRow[];
  }

  getByExecutor(executor: string): DBAccountRow[] {
    return this.stmts.getByExecutor.all(executor) as DBAccountRow[];
  }

  getNextAvailable(executor: string): DBAccountRow | null {
    const now = new Date().toISOString();
    return (this.stmts.getAvailable.get(executor, now) as DBAccountRow) || null;
  }

  reportQuotaError(accountId: string): void {
    const cooldownUntil = new Date(Date.now() + 3600000).toISOString(); // 1 hour
    this.stmts.setCooldown.run(cooldownUntil, accountId);
    logger.warn({ accountId, cooldownUntil }, "Account quota exhausted");
  }

  reportError(accountId: string): void {
    this.stmts.incrementFailures.run(accountId);
  }

  reportSuccess(accountId: string): void {
    this.stmts.resetFailures.run(accountId);
    this.stmts.recordUsage.run(new Date().toISOString(), accountId);
  }

  incrementTokenUsage(accountId: string, tokens: number): void {
    this.stmts.incrementTokens.run(tokens, accountId);
  }

  getPoolStatus(executor: string): {
    totalAccounts: number;
    availableAccounts: number;
    allExhausted: boolean;
    nextAvailableIn: number | null;
  } {
    const now = new Date();
    const nowStr = now.toISOString();
    const all = this.getByExecutor(executor);
    const available = all.filter(
      (a) =>
        a.status === "active" &&
        (a.cooldown_until === null || a.cooldown_until <= nowStr) &&
        a.consecutive_failures < 5 &&
        (a.daily_limit === null || a.tokens_used_today < a.daily_limit)
    );
    const inCooldown = all.filter(
      (a) =>
        a.status === "active" &&
        a.cooldown_until !== null &&
        a.cooldown_until > nowStr &&
        a.consecutive_failures < 5
    );

    let nextAvailableIn: number | null = null;
    if (available.length === 0 && inCooldown.length > 0) {
      const cooldownEnds = inCooldown.map((a) =>
        new Date(a.cooldown_until!).getTime() - now.getTime()
      );
      nextAvailableIn = Math.min(...cooldownEnds);
    }

    return {
      totalAccounts: all.length,
      availableAccounts: available.length,
      allExhausted: available.length === 0,
      nextAvailableIn,
    };
  }

  resetAllCooldowns(executor: string): void {
    this.stmts.resetAllCooldowns.run(executor);
    logger.info({ executor }, "All account cooldowns reset");
  }

  resetDailyTokenCounts(): void {
    this.stmts.resetDailyTokens.run();
    logger.info("Daily token counts reset for all accounts");
  }

  setAccountStatus(accountId: string, status: "active" | "disabled" | "rate_limited" | "quota_exceeded"): void {
    this.stmts.updateStatus.run(status, accountId);
  }
}

// ============================================
// COST TRACKING (DB-backed)
// ============================================

// Approximate costs per 1K tokens (USD)
const COST_PER_1K_TOKENS: Record<string, { input: number; output: number }> = {
  "gemini-cli": { input: 0, output: 0 },
  "gemini-api": { input: 0.00025, output: 0.001 },
  kimi: { input: 0, output: 0 },
  claude: { input: 0.003, output: 0.015 },
  codex: { input: 0.003, output: 0.015 },
};

export class CostTracker {
  private stmts: {
    insert: Database.Statement<[string, string | null, number, number, number, number, string, string | null, string | null, string | null, string | null]>;
    getDailySummary: Database.Statement<[string]>;
    getWeeklyCosts: Database.Statement<[]>;
  };

  constructor(db: Database.Database) {
    this.stmts = {
      insert: db.prepare(`
        INSERT INTO executor_costs
          (executor, executor_account, input_tokens, output_tokens, cost_usd, timestamp, date_key, job_id, intent_id, run_id, query_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getDailySummary: db.prepare(`
        SELECT * FROM daily_cost_summary WHERE date_key = ?
      `),
      getWeeklyCosts: db.prepare(`
        SELECT date_key, total_cost, gemini_cli_queries, gemini_api_cost, kimi_queries, claude_cost, codex_cost
        FROM daily_cost_summary
        WHERE date_key >= date('now', '-7 days')
        ORDER BY date_key DESC
      `),
    };
  }

  private getDateKey(): string {
    return new Date().toISOString().split("T")[0]!;
  }

  private hashQuery(query: string): string {
    return createHash("sha256").update(query).digest("hex").slice(0, 16);
  }

  calculateCost(
    executor: string,
    inputTokens: number,
    outputTokens: number
  ): number {
    const rates = COST_PER_1K_TOKENS[executor] || { input: 0, output: 0 };
    return (
      (inputTokens / 1000) * rates.input +
      (outputTokens / 1000) * rates.output
    );
  }

  estimateCost(
    executor: string,
    estimatedInputTokens: number,
    estimatedOutputRatio: number = 0.5
  ): number {
    return this.calculateCost(
      executor,
      estimatedInputTokens,
      Math.floor(estimatedInputTokens * estimatedOutputRatio)
    );
  }

  track(
    executor: string,
    inputTokens: number,
    outputTokens: number,
    options?: { jobId?: string; query?: string; intentId?: string; runId?: string; executorAccount?: string }
  ): number {
    const cost = this.calculateCost(executor, inputTokens, outputTokens);
    const timestamp = Date.now();
    const dateKey = this.getDateKey();
    const queryHash = options?.query ? this.hashQuery(options.query) : null;

    this.stmts.insert.run(
      executor,
      options?.executorAccount || null,
      inputTokens,
      outputTokens,
      cost,
      timestamp,
      dateKey,
      options?.jobId || null,
      options?.intentId || null,
      options?.runId || null,
      queryHash
    );

    logger.debug(
      { executor, inputTokens, outputTokens, cost, dateKey },
      "Cost tracked"
    );

    return cost;
  }

  getDailyCost(date?: string): number {
    const dateKey = date || this.getDateKey();
    const row = this.stmts.getDailySummary.get(dateKey) as
      | { total_cost: number }
      | undefined;
    return row?.total_cost || 0;
  }

  getDailySummary(
    date?: string
  ): {
    dateKey: string;
    totalCost: number;
    geminiCliQueries: number;
    geminiApiCost: number;
    kimiQueries: number;
    claudeCost: number;
    codexCost: number;
  } | null {
    const dateKey = date || this.getDateKey();
    const row = this.stmts.getDailySummary.get(dateKey) as
      | {
          date_key: string;
          total_cost: number;
          gemini_cli_queries: number;
          gemini_api_cost: number;
          kimi_queries: number;
          claude_cost: number;
          codex_cost: number;
        }
      | undefined;

    if (!row) return null;

    return {
      dateKey: row.date_key,
      totalCost: row.total_cost,
      geminiCliQueries: row.gemini_cli_queries,
      geminiApiCost: row.gemini_api_cost,
      kimiQueries: row.kimi_queries,
      claudeCost: row.claude_cost,
      codexCost: row.codex_cost,
    };
  }

  getWeeklyCosts(): Array<{
    dateKey: string;
    totalCost: number;
    geminiCliQueries: number;
    geminiApiCost: number;
    kimiQueries: number;
    claudeCost: number;
    codexCost: number;
  }> {
    const rows = this.stmts.getWeeklyCosts.all() as Array<{
      date_key: string;
      total_cost: number;
      gemini_cli_queries: number;
      gemini_api_cost: number;
      kimi_queries: number;
      claude_cost: number;
      codex_cost: number;
    }>;

    return rows.map((row) => ({
      dateKey: row.date_key,
      totalCost: row.total_cost,
      geminiCliQueries: row.gemini_cli_queries,
      geminiApiCost: row.gemini_api_cost,
      kimiQueries: row.kimi_queries,
      claudeCost: row.claude_cost,
      codexCost: row.codex_cost,
    }));
  }
}

// ============================================
// DEFERRAL QUEUE (DB-backed)
// ============================================

interface DBDeferredTaskRow {
  id: string;
  query: string;
  context: string | null;
  task_type: string;
  urgency: string;
  estimated_tokens: number | null;
  cwd: string | null;
  model: string | null;
  intent_id: string | null;
  decision_json: string;
  created_at: number;
  scheduled_for: number;
  attempts: number;
  last_attempt_at: number | null;
  last_error: string | null;
  status: string;
  result_output: string | null;
  result_exit_code: number | null;
}

export class DeferralQueue {
  private stmts: {
    insert: Database.Statement<[string, string, string | null, string, string, number | null, string | null, string | null, string | null, string, number, number]>;
    updateStatus: Database.Statement<[string, number, string | null, string]>;
    complete: Database.Statement<[string, number, string]>;
    getPending: Database.Statement<[number, number]>;
    getById: Database.Statement<[string]>;
    delete: Database.Statement<[string]>;
    getStats: Database.Statement<[]>;
  };

  constructor(db: Database.Database) {
    this.stmts = {
      insert: db.prepare(`
        INSERT INTO deferred_tasks
          (id, query, context, task_type, urgency, estimated_tokens, cwd, model, intent_id, decision_json, created_at, scheduled_for)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateStatus: db.prepare(`
        UPDATE deferred_tasks
        SET status = ?, attempts = attempts + 1, last_attempt_at = ?, last_error = ?
        WHERE id = ?
      `),
      complete: db.prepare(`
        UPDATE deferred_tasks
        SET status = 'completed', result_output = ?, result_exit_code = ?
        WHERE id = ?
      `),
      getPending: db.prepare(`
        SELECT * FROM deferred_tasks
        WHERE status = 'pending' AND scheduled_for <= ?
        ORDER BY scheduled_for ASC
        LIMIT ?
      `),
      getById: db.prepare(`SELECT * FROM deferred_tasks WHERE id = ?`),
      delete: db.prepare(`DELETE FROM deferred_tasks WHERE id = ?`),
      getStats: db.prepare(`
        SELECT status, COUNT(*) as count
        FROM deferred_tasks
        GROUP BY status
      `),
    };
  }

  private generateId(): string {
    return `defer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  defer(
    request: RoutingRequest,
    decision: RoutingDecision,
    scheduleForMs: number = 3600000
  ): string {
    const id = this.generateId();
    const now = Date.now();

    this.stmts.insert.run(
      id,
      request.query,
      request.context || null,
      request.taskType || "general",
      request.urgency || "batch",
      request.estimatedTokens || null,
      request.cwd || null,
      request.model || null,
      request.intentId || null,
      JSON.stringify(decision),
      now,
      now + scheduleForMs
    );

    logger.info(
      {
        deferralId: id,
        scheduledFor: new Date(now + scheduleForMs).toISOString(),
        taskType: request.taskType,
      },
      "Task deferred to database"
    );

    return id;
  }

  getPending(limit: number = 10): DeferredTask[] {
    const now = Date.now();
    const rows = this.stmts.getPending.all(now, limit) as DBDeferredTaskRow[];

    return rows.map((row) => ({
      id: row.id,
      request: {
        query: row.query,
        context: row.context || undefined,
        taskType: row.task_type as TaskType,
        urgency: row.urgency as "immediate" | "soon" | "batch",
        estimatedTokens: row.estimated_tokens || undefined,
        cwd: row.cwd || undefined,
        model: row.model || undefined,
        intentId: row.intent_id || undefined,
      },
      decision: JSON.parse(row.decision_json) as RoutingDecision,
      createdAt: row.created_at,
      scheduledFor: row.scheduled_for,
      attempts: row.attempts,
      lastError: row.last_error || undefined,
      status: row.status as DeferredTask["status"],
    }));
  }

  updateStatus(
    id: string,
    status: "pending" | "processing" | "completed" | "failed",
    error?: string
  ): void {
    this.stmts.updateStatus.run(status, Date.now(), error || null, id);
  }

  complete(id: string, output: string, exitCode: number): void {
    this.stmts.complete.run(output, exitCode, id);
  }

  remove(id: string): void {
    this.stmts.delete.run(id);
  }

  getStats(): { pending: number; processing: number; completed: number; failed: number } {
    const rows = this.stmts.getStats.all() as Array<{
      status: string;
      count: number;
    }>;

    const stats = { pending: 0, processing: 0, completed: 0, failed: 0 };
    for (const row of rows) {
      stats[row.status as keyof typeof stats] = row.count;
    }
    return stats;
  }
}

// ============================================
// UNIFIED ROUTER STATE
// ============================================

export interface RouterState {
  accounts: AccountManager;
  costs: CostTracker;
  deferrals: DeferralQueue;
}

export function createRouterState(db: Database.Database): RouterState {
  return {
    accounts: new AccountManager(db),
    costs: new CostTracker(db),
    deferrals: new DeferralQueue(db),
  };
}
