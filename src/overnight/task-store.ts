/**
 * Overnight Task Store
 *
 * CRUD operations for overnight tasks, iterations, and morning choices.
 * Uses the StateManager's database connection.
 */

import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import type {
  OvernightTask,
  OvernightIteration,
  MorningChoice,
  OvernightMilestone,
  OvernightTaskStatus,
  IterationStatus,
  OvernightTaskType,
  ApproachLabel,
  ApproachName,
  RankedOption,
  ComparisonMatrix,
  MilestoneType,
} from "./types.js";

// ============================================
// ROW TYPES (DATABASE)
// ============================================

interface TaskRow {
  id: string;
  type: string;
  subject: string;
  constraints: string | null;
  iterations: number;
  chat_id: number;
  message_id: number | null;
  status: string;
  scheduled_for: string | null;
  confidence_score: number | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface IterationRow {
  id: string;
  task_id: string;
  approach_label: string;
  approach_name: string;
  approach_description: string | null;
  status: string;
  workspace_path: string | null;
  git_branch: string | null;
  output: string | null;
  artifacts: string | null;
  validation_score: number | null;
  validation_notes: string | null;
  executor: string | null;
  token_usage: number | null;
  duration_ms: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface ChoiceRow {
  id: string;
  task_id: string;
  options: string;
  comparison_matrix: string | null;
  recommendation: string | null;
  recommendation_reason: string | null;
  message_id: number | null;
  selected_option: string | null;
  selected_at: string | null;
  pr_url: string | null;
  pr_number: number | null;
  expires_at: string;
  created_at: string;
}

interface MilestoneRow {
  id: number;
  task_id: string;
  milestone: string;
  message: string;
  message_id: number | null;
  created_at: string;
}

// ============================================
// TASK STORE CLASS
// ============================================

export class OvernightTaskStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ============================================
  // TASK OPERATIONS
  // ============================================

  createTask(params: {
    type: OvernightTaskType;
    subject: string;
    constraints?: string[];
    iterations?: number;
    chatId: number;
    messageId?: number;
    scheduledFor?: Date;
    confidenceScore?: number;
  }): OvernightTask {
    const id = `overnight_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO overnight_tasks (
        id, type, subject, constraints, iterations,
        chat_id, message_id, status, scheduled_for,
        confidence_score, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(
      id,
      params.type,
      params.subject,
      params.constraints ? JSON.stringify(params.constraints) : null,
      params.iterations ?? 3,
      params.chatId,
      params.messageId ?? null,
      params.scheduledFor?.toISOString() ?? null,
      params.confidenceScore ?? null,
      now
    );

    return this.getTask(id)!;
  }

  getTask(id: string): OvernightTask | null {
    const row = this.db.prepare(
      "SELECT * FROM overnight_tasks WHERE id = ?"
    ).get(id) as TaskRow | undefined;

    return row ? this.mapTaskRow(row) : null;
  }

  getQueuedTasks(): OvernightTask[] {
    const rows = this.db.prepare(`
      SELECT * FROM overnight_tasks
      WHERE status = 'queued'
      ORDER BY created_at ASC
    `).all() as TaskRow[];

    return rows.map((r) => this.mapTaskRow(r));
  }

  getTasksByStatus(status: OvernightTaskStatus): OvernightTask[] {
    const rows = this.db.prepare(`
      SELECT * FROM overnight_tasks
      WHERE status = ?
      ORDER BY created_at DESC
    `).all(status) as TaskRow[];

    return rows.map((r) => this.mapTaskRow(r));
  }

  getTasksByChatId(chatId: number, limit = 10): OvernightTask[] {
    const rows = this.db.prepare(`
      SELECT * FROM overnight_tasks
      WHERE chat_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(chatId, limit) as TaskRow[];

    return rows.map((r) => this.mapTaskRow(r));
  }

  updateTaskStatus(
    id: string,
    status: OvernightTaskStatus,
    extra?: { error?: string; startedAt?: Date; completedAt?: Date }
  ): void {
    let query = "UPDATE overnight_tasks SET status = ?";
    const params: (string | null)[] = [status];

    if (extra?.error) {
      query += ", error = ?";
      params.push(extra.error);
    }

    if (extra?.startedAt) {
      query += ", started_at = ?";
      params.push(extra.startedAt.toISOString());
    }

    if (extra?.completedAt) {
      query += ", completed_at = ?";
      params.push(extra.completedAt.toISOString());
    }

    query += " WHERE id = ?";
    params.push(id);

    this.db.prepare(query).run(...params);
  }

  deleteTask(id: string): void {
    // Cascades to iterations, choices, milestones
    this.db.prepare("DELETE FROM overnight_tasks WHERE id = ?").run(id);
  }

  private mapTaskRow(row: TaskRow): OvernightTask {
    return {
      id: row.id,
      type: row.type as OvernightTaskType,
      subject: row.subject,
      constraints: row.constraints ? JSON.parse(row.constraints) : [],
      iterations: row.iterations,
      chatId: row.chat_id,
      messageId: row.message_id ?? undefined,
      status: row.status as OvernightTaskStatus,
      scheduledFor: row.scheduled_for ? new Date(row.scheduled_for) : undefined,
      confidenceScore: row.confidence_score ?? undefined,
      error: row.error ?? undefined,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    };
  }

  // ============================================
  // ITERATION OPERATIONS
  // ============================================

  createIteration(params: {
    taskId: string;
    approachLabel: ApproachLabel;
    approachName: ApproachName;
    approachDescription?: string;
    executor?: string;
  }): OvernightIteration {
    const id = `iter_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO overnight_iterations (
        id, task_id, approach_label, approach_name,
        approach_description, executor, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.taskId,
      params.approachLabel,
      params.approachName,
      params.approachDescription ?? null,
      params.executor ?? null,
      now
    );

    return this.getIteration(id)!;
  }

  getIteration(id: string): OvernightIteration | null {
    const row = this.db.prepare(
      "SELECT * FROM overnight_iterations WHERE id = ?"
    ).get(id) as IterationRow | undefined;

    return row ? this.mapIterationRow(row) : null;
  }

  getIterationsByTask(taskId: string): OvernightIteration[] {
    const rows = this.db.prepare(`
      SELECT * FROM overnight_iterations
      WHERE task_id = ?
      ORDER BY approach_label ASC
    `).all(taskId) as IterationRow[];

    return rows.map((r) => this.mapIterationRow(r));
  }

  updateIterationStatus(
    id: string,
    status: IterationStatus,
    extra?: {
      workspacePath?: string;
      gitBranch?: string;
      output?: string;
      artifacts?: string[];
      validationScore?: number;
      validationNotes?: string;
      tokenUsage?: number;
      durationMs?: number;
      startedAt?: Date;
      completedAt?: Date;
    }
  ): void {
    let query = "UPDATE overnight_iterations SET status = ?";
    const params: (string | number | null)[] = [status];

    if (extra?.workspacePath) {
      query += ", workspace_path = ?";
      params.push(extra.workspacePath);
    }

    if (extra?.gitBranch) {
      query += ", git_branch = ?";
      params.push(extra.gitBranch);
    }

    if (extra?.output) {
      query += ", output = ?";
      params.push(extra.output);
    }

    if (extra?.artifacts) {
      query += ", artifacts = ?";
      params.push(JSON.stringify(extra.artifacts));
    }

    if (extra?.validationScore !== undefined) {
      query += ", validation_score = ?";
      params.push(extra.validationScore);
    }

    if (extra?.validationNotes) {
      query += ", validation_notes = ?";
      params.push(extra.validationNotes);
    }

    if (extra?.tokenUsage !== undefined) {
      query += ", token_usage = ?";
      params.push(extra.tokenUsage);
    }

    if (extra?.durationMs !== undefined) {
      query += ", duration_ms = ?";
      params.push(extra.durationMs);
    }

    if (extra?.startedAt) {
      query += ", started_at = ?";
      params.push(extra.startedAt.toISOString());
    }

    if (extra?.completedAt) {
      query += ", completed_at = ?";
      params.push(extra.completedAt.toISOString());
    }

    query += " WHERE id = ?";
    params.push(id);

    this.db.prepare(query).run(...params);
  }

  private mapIterationRow(row: IterationRow): OvernightIteration {
    return {
      id: row.id,
      taskId: row.task_id,
      approachLabel: row.approach_label as ApproachLabel,
      approachName: row.approach_name as ApproachName,
      approachDescription: row.approach_description ?? undefined,
      status: row.status as IterationStatus,
      workspacePath: row.workspace_path ?? undefined,
      gitBranch: row.git_branch ?? undefined,
      output: row.output ?? undefined,
      artifacts: row.artifacts ? JSON.parse(row.artifacts) : [],
      validationScore: row.validation_score ?? undefined,
      validationNotes: row.validation_notes ?? undefined,
      executor: row.executor as OvernightIteration["executor"],
      tokenUsage: row.token_usage ?? undefined,
      durationMs: row.duration_ms ?? undefined,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    };
  }

  // ============================================
  // MORNING CHOICE OPERATIONS
  // ============================================

  createMorningChoice(params: {
    taskId: string;
    options: RankedOption[];
    comparisonMatrix: ComparisonMatrix;
    recommendation: ApproachLabel;
    recommendationReason: string;
    expiresAt: Date;
  }): MorningChoice {
    const id = `choice_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO morning_choices (
        id, task_id, options, comparison_matrix,
        recommendation, recommendation_reason,
        expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.taskId,
      JSON.stringify(params.options),
      JSON.stringify(params.comparisonMatrix),
      params.recommendation,
      params.recommendationReason,
      params.expiresAt.toISOString(),
      now
    );

    return this.getMorningChoice(id)!;
  }

  getMorningChoice(id: string): MorningChoice | null {
    const row = this.db.prepare(
      "SELECT * FROM morning_choices WHERE id = ?"
    ).get(id) as ChoiceRow | undefined;

    return row ? this.mapChoiceRow(row) : null;
  }

  getMorningChoiceByTask(taskId: string): MorningChoice | null {
    const row = this.db.prepare(
      "SELECT * FROM morning_choices WHERE task_id = ? ORDER BY created_at DESC LIMIT 1"
    ).get(taskId) as ChoiceRow | undefined;

    return row ? this.mapChoiceRow(row) : null;
  }

  getPendingMorningChoices(): MorningChoice[] {
    const now = new Date().toISOString();
    const rows = this.db.prepare(`
      SELECT * FROM morning_choices
      WHERE selected_option IS NULL AND expires_at > ?
      ORDER BY created_at ASC
    `).all(now) as ChoiceRow[];

    return rows.map((r) => this.mapChoiceRow(r));
  }

  updateMorningChoiceSelection(
    id: string,
    selection: ApproachLabel | "skip",
    extra?: { prUrl?: string; prNumber?: number; messageId?: number }
  ): void {
    const now = new Date().toISOString();
    let query = "UPDATE morning_choices SET selected_option = ?, selected_at = ?";
    const params: (string | number | null)[] = [selection, now];

    if (extra?.prUrl) {
      query += ", pr_url = ?";
      params.push(extra.prUrl);
    }

    if (extra?.prNumber) {
      query += ", pr_number = ?";
      params.push(extra.prNumber);
    }

    if (extra?.messageId) {
      query += ", message_id = ?";
      params.push(extra.messageId);
    }

    query += " WHERE id = ?";
    params.push(id);

    this.db.prepare(query).run(...params);
  }

  setMorningChoiceMessageId(id: string, messageId: number): void {
    this.db.prepare(
      "UPDATE morning_choices SET message_id = ? WHERE id = ?"
    ).run(messageId, id);
  }

  expireOldChoices(): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE morning_choices
      SET selected_option = 'expired'
      WHERE selected_option IS NULL AND expires_at < ?
    `).run(now);

    // Also update associated tasks
    this.db.prepare(`
      UPDATE overnight_tasks
      SET status = 'expired'
      WHERE id IN (
        SELECT task_id FROM morning_choices
        WHERE selected_option = 'expired'
      )
    `).run();

    return result.changes;
  }

  private mapChoiceRow(row: ChoiceRow): MorningChoice {
    return {
      id: row.id,
      taskId: row.task_id,
      options: JSON.parse(row.options) as RankedOption[],
      comparisonMatrix: row.comparison_matrix
        ? JSON.parse(row.comparison_matrix)
        : { headers: [], rows: [] },
      recommendation: (row.recommendation ?? "A") as ApproachLabel,
      recommendationReason: row.recommendation_reason ?? "",
      messageId: row.message_id ?? undefined,
      selectedOption: row.selected_option as MorningChoice["selectedOption"],
      selectedAt: row.selected_at ? new Date(row.selected_at) : undefined,
      prUrl: row.pr_url ?? undefined,
      prNumber: row.pr_number ?? undefined,
      expiresAt: new Date(row.expires_at),
      createdAt: new Date(row.created_at),
    };
  }

  // ============================================
  // MILESTONE OPERATIONS
  // ============================================

  createMilestone(params: {
    taskId: string;
    milestone: MilestoneType;
    message: string;
    messageId?: number;
  }): OvernightMilestone {
    const now = new Date().toISOString();

    const result = this.db.prepare(`
      INSERT INTO overnight_milestones (
        task_id, milestone, message, message_id, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      params.taskId,
      params.milestone,
      params.message,
      params.messageId ?? null,
      now
    );

    return {
      id: result.lastInsertRowid as number,
      taskId: params.taskId,
      milestone: params.milestone,
      message: params.message,
      messageId: params.messageId,
      createdAt: new Date(now),
    };
  }

  getMilestonesByTask(taskId: string): OvernightMilestone[] {
    const rows = this.db.prepare(`
      SELECT * FROM overnight_milestones
      WHERE task_id = ?
      ORDER BY created_at ASC
    `).all(taskId) as MilestoneRow[];

    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      milestone: r.milestone as MilestoneType,
      message: r.message,
      messageId: r.message_id ?? undefined,
      createdAt: new Date(r.created_at),
    }));
  }

  // ============================================
  // STATISTICS
  // ============================================

  getTaskStats(): {
    total: number;
    queued: number;
    executing: number;
    completed: number;
    failed: number;
  } {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) as count
      FROM overnight_tasks
      GROUP BY status
    `).all() as { status: string; count: number }[];

    const stats = {
      total: 0,
      queued: 0,
      executing: 0,
      completed: 0,
      failed: 0,
    };

    for (const row of rows) {
      stats.total += row.count;
      if (row.status === "queued" || row.status === "clarifying") {
        stats.queued += row.count;
      } else if (["planning", "executing", "synthesizing"].includes(row.status)) {
        stats.executing += row.count;
      } else if (["ready", "presented", "selected", "applied"].includes(row.status)) {
        stats.completed += row.count;
      } else if (["failed", "expired", "skipped"].includes(row.status)) {
        stats.failed += row.count;
      }
    }

    return stats;
  }

  // ============================================
  // CLEANUP
  // ============================================

  cleanupOldTasks(maxAgeDays = 30): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(`
      DELETE FROM overnight_tasks
      WHERE created_at < ? AND status IN ('applied', 'skipped', 'expired', 'failed')
    `).run(cutoff);

    return result.changes;
  }
}
