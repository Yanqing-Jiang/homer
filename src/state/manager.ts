import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

export interface Session {
  id: string;
  lane: string;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
}

export interface ExecutorSession {
  lane: string;
  claudeSessionId: string;
  createdAt: number;
  lastUsedAt: number;
}

export class StateManager {
  private db: Database.Database;
  private ttlMs: number;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.ttlMs = config.session.ttlHours * 60 * 60 * 1000;
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        lane TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL,
        message_count INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_lane ON sessions(lane);
      CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(last_activity_at);

      CREATE TABLE IF NOT EXISTS executor_sessions (
        lane TEXT PRIMARY KEY,
        claude_session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_queue (
        id TEXT PRIMARY KEY,
        lane TEXT NOT NULL,
        executor TEXT NOT NULL,
        query TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        chat_id INTEGER NOT NULL,
        message_id INTEGER,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        attempts INTEGER DEFAULT 0,
        error TEXT,
        result TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_queue_status ON job_queue(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_queue_lane ON job_queue(lane, status);

      -- Scheduled job run history
      CREATE TABLE IF NOT EXISTS scheduled_job_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        job_name TEXT NOT NULL,
        source_file TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        success INTEGER NOT NULL DEFAULT 0,
        output TEXT,
        error TEXT,
        exit_code INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_job_runs_job_id ON scheduled_job_runs(job_id);
      CREATE INDEX IF NOT EXISTS idx_job_runs_started_at ON scheduled_job_runs(started_at);

      -- Scheduled job state tracking
      CREATE TABLE IF NOT EXISTS scheduled_job_state (
        job_id TEXT PRIMARY KEY,
        source_file TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        last_success_at TEXT,
        consecutive_failures INTEGER DEFAULT 0,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      -- Reminders
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        message TEXT NOT NULL,
        due_at TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT 'default',
        created_at TEXT NOT NULL,
        sent_at TEXT,
        status TEXT DEFAULT 'pending'
      );

      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at, status);
      CREATE INDEX IF NOT EXISTS idx_reminders_chat ON reminders(chat_id, status);
    `);

    logger.debug("State manager initialized");
  }

  getOrCreateSession(lane: string): Session {
    const now = Date.now();
    const cutoff = now - this.ttlMs;

    // Try to find an active session for this lane
    const existing = this.db
      .prepare(
        `SELECT id, lane, created_at as createdAt, last_activity_at as lastActivityAt, message_count as messageCount
         FROM sessions
         WHERE lane = ? AND last_activity_at > ?
         ORDER BY last_activity_at DESC
         LIMIT 1`
      )
      .get(lane, cutoff) as Session | undefined;

    if (existing) {
      logger.debug({ sessionId: existing.id, lane }, "Resuming existing session");
      return existing;
    }

    // Create new session
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO sessions (id, lane, created_at, last_activity_at, message_count)
         VALUES (?, ?, ?, ?, 0)`
      )
      .run(id, lane, now, now);

    logger.info({ sessionId: id, lane }, "Created new session");

    return {
      id,
      lane,
      createdAt: now,
      lastActivityAt: now,
      messageCount: 0,
    };
  }

  updateSessionActivity(sessionId: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE sessions
         SET last_activity_at = ?, message_count = message_count + 1
         WHERE id = ?`
      )
      .run(now, sessionId);
  }

  getMostRecentSession(): Session | null {
    const now = Date.now();
    const cutoff = now - this.ttlMs;

    const session = this.db
      .prepare(
        `SELECT id, lane, created_at as createdAt, last_activity_at as lastActivityAt, message_count as messageCount
         FROM sessions
         WHERE last_activity_at > ?
         ORDER BY last_activity_at DESC
         LIMIT 1`
      )
      .get(cutoff) as Session | undefined;

    return session ?? null;
  }

  getActiveSessions(): Session[] {
    const now = Date.now();
    const cutoff = now - this.ttlMs;

    return this.db
      .prepare(
        `SELECT id, lane, created_at as createdAt, last_activity_at as lastActivityAt, message_count as messageCount
         FROM sessions
         WHERE last_activity_at > ?
         ORDER BY last_activity_at DESC`
      )
      .all(cutoff) as Session[];
  }

  cleanupExpiredSessions(): number {
    const cutoff = Date.now() - this.ttlMs;
    const result = this.db.prepare(`DELETE FROM sessions WHERE last_activity_at < ?`).run(cutoff);

    if (result.changes > 0) {
      logger.info({ deletedCount: result.changes }, "Cleaned up expired sessions");
    }

    return result.changes;
  }

  close(): void {
    this.db.close();
  }

  // Executor session methods for Claude --resume
  // Uses composite key (lane:subcontext) for project isolation
  private getSessionKey(lane: string, subcontext?: string): string {
    return subcontext ? `${lane}:${subcontext}` : lane;
  }

  getClaudeSessionId(lane: string, subcontext?: string): string | null {
    const key = this.getSessionKey(lane, subcontext);
    const cutoff = Date.now() - this.ttlMs;
    const result = this.db
      .prepare(
        `SELECT claude_session_id FROM executor_sessions
         WHERE lane = ? AND last_used_at > ?`
      )
      .get(key, cutoff) as { claude_session_id: string } | undefined;

    return result?.claude_session_id ?? null;
  }

  setClaudeSessionId(lane: string, claudeSessionId: string, subcontext?: string): void {
    const key = this.getSessionKey(lane, subcontext);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO executor_sessions (lane, claude_session_id, created_at, last_used_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(lane) DO UPDATE SET
           claude_session_id = excluded.claude_session_id,
           last_used_at = excluded.last_used_at`
      )
      .run(key, claudeSessionId, now, now);

    logger.debug({ key, claudeSessionId }, "Stored Claude session ID");
  }

  updateClaudeSessionActivity(lane: string, subcontext?: string): void {
    const key = this.getSessionKey(lane, subcontext);
    const now = Date.now();
    this.db
      .prepare(`UPDATE executor_sessions SET last_used_at = ? WHERE lane = ?`)
      .run(now, key);
  }

  // Job queue methods
  createJob(job: {
    id: string;
    lane: string;
    executor: string;
    query: string;
    chatId: number;
    messageId?: number;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO job_queue (id, lane, executor, query, chat_id, message_id, created_at, status, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0)`
      )
      .run(job.id, job.lane, job.executor, job.query, job.chatId, job.messageId ?? null, now);
  }

  getNextPendingJob(lane?: string): Job | null {
    let query = `
      SELECT id, lane, executor, query, status, chat_id as chatId, message_id as messageId,
             created_at as createdAt, started_at as startedAt, completed_at as completedAt,
             attempts, error, result
      FROM job_queue
      WHERE status = 'pending'
    `;
    const params: (string | undefined)[] = [];

    if (lane) {
      query += ` AND lane = ?`;
      params.push(lane);
    }

    query += ` ORDER BY created_at ASC LIMIT 1`;

    return this.db.prepare(query).get(...params) as Job | null;
  }

  updateJobStatus(
    jobId: string,
    status: "pending" | "running" | "completed" | "failed",
    extra?: { error?: string; result?: string }
  ): void {
    const now = Date.now();
    let query = `UPDATE job_queue SET status = ?`;
    const params: (string | number | null)[] = [status];

    if (status === "running") {
      query += `, started_at = ?, attempts = attempts + 1`;
      params.push(now);
    } else if (status === "completed" || status === "failed") {
      query += `, completed_at = ?`;
      params.push(now);
    }

    if (extra?.error) {
      query += `, error = ?`;
      params.push(extra.error);
    }

    if (extra?.result) {
      query += `, result = ?`;
      params.push(extra.result);
    }

    query += ` WHERE id = ?`;
    params.push(jobId);

    this.db.prepare(query).run(...params);
  }

  getRunningJobsCount(lane?: string): number {
    let query = `SELECT COUNT(*) as count FROM job_queue WHERE status = 'running'`;
    const params: string[] = [];

    if (lane) {
      query += ` AND lane = ?`;
      params.push(lane);
    }

    const result = this.db.prepare(query).get(...params) as { count: number };
    return result.count;
  }

  getJobById(jobId: string): Job | null {
    return this.db
      .prepare(
        `SELECT id, lane, executor, query, status, chat_id as chatId, message_id as messageId,
                created_at as createdAt, started_at as startedAt, completed_at as completedAt,
                attempts, error, result
         FROM job_queue WHERE id = ?`
      )
      .get(jobId) as Job | null;
  }

  getRecentJobs(limit: number = 50): Job[] {
    return this.db
      .prepare(
        `SELECT id, lane, executor, query, status, chat_id as chatId, message_id as messageId,
                created_at as createdAt, started_at as startedAt, completed_at as completedAt,
                attempts, error, result
         FROM job_queue
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit) as Job[];
  }

  getJobStats(): { pending: number; running: number; completed: number; failed: number } {
    const result = this.db
      .prepare(
        `SELECT status, COUNT(*) as count FROM job_queue GROUP BY status`
      )
      .all() as { status: string; count: number }[];

    const stats = { pending: 0, running: 0, completed: 0, failed: 0 };
    for (const row of result) {
      if (row.status in stats) {
        stats[row.status as keyof typeof stats] = row.count;
      }
    }
    return stats;
  }

  cleanupOldJobs(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.db
      .prepare(`DELETE FROM job_queue WHERE completed_at < ? AND status IN ('completed', 'failed')`)
      .run(cutoff);
    return result.changes;
  }

  // Scheduled job methods
  recordScheduledJobStart(jobId: string, jobName: string, sourceFile: string): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO scheduled_job_runs (job_id, job_name, source_file, started_at, success)
         VALUES (?, ?, ?, ?, 0)`
      )
      .run(jobId, jobName, sourceFile, now);

    // Update or create job state
    this.db
      .prepare(
        `INSERT INTO scheduled_job_state (job_id, source_file, last_run_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           last_run_at = excluded.last_run_at,
           updated_at = excluded.updated_at`
      )
      .run(jobId, sourceFile, now, now);

    return result.lastInsertRowid as number;
  }

  recordScheduledJobComplete(
    jobId: string,
    success: boolean,
    output: string,
    error?: string,
    exitCode?: number
  ): void {
    const now = new Date().toISOString();

    // Update the most recent run for this job
    this.db
      .prepare(
        `UPDATE scheduled_job_runs
         SET completed_at = ?, success = ?, output = ?, error = ?, exit_code = ?
         WHERE job_id = ? AND completed_at IS NULL
         ORDER BY id DESC LIMIT 1`
      )
      .run(now, success ? 1 : 0, output, error ?? null, exitCode ?? null, jobId);

    // Update job state
    if (success) {
      this.db
        .prepare(
          `UPDATE scheduled_job_state
           SET last_success_at = ?, consecutive_failures = 0, updated_at = ?
           WHERE job_id = ?`
        )
        .run(now, now, jobId);
    } else {
      this.db
        .prepare(
          `UPDATE scheduled_job_state
           SET consecutive_failures = consecutive_failures + 1, updated_at = ?
           WHERE job_id = ?`
        )
        .run(now, jobId);
    }
  }

  getScheduledJobState(jobId: string): ScheduledJobState | null {
    return this.db
      .prepare(
        `SELECT job_id as jobId, source_file as sourceFile, enabled,
                last_run_at as lastRunAt, last_success_at as lastSuccessAt,
                consecutive_failures as consecutiveFailures, updated_at as updatedAt
         FROM scheduled_job_state WHERE job_id = ?`
      )
      .get(jobId) as ScheduledJobState | null;
  }

  getRecentScheduledJobRuns(jobId: string, limit: number = 10): ScheduledJobRun[] {
    return this.db
      .prepare(
        `SELECT id, job_id as jobId, job_name as jobName, source_file as sourceFile,
                started_at as startedAt, completed_at as completedAt,
                success, output, error, exit_code as exitCode
         FROM scheduled_job_runs
         WHERE job_id = ?
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(jobId, limit) as ScheduledJobRun[];
  }

  getAllScheduledJobStates(): ScheduledJobState[] {
    return this.db
      .prepare(
        `SELECT job_id as jobId, source_file as sourceFile, enabled,
                last_run_at as lastRunAt, last_success_at as lastSuccessAt,
                consecutive_failures as consecutiveFailures, updated_at as updatedAt
         FROM scheduled_job_state
         ORDER BY updated_at DESC`
      )
      .all() as ScheduledJobState[];
  }

  cleanupOldScheduledJobRuns(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): number {
    const cutoffDate = new Date(Date.now() - maxAgeMs).toISOString();
    const result = this.db
      .prepare(`DELETE FROM scheduled_job_runs WHERE completed_at < ?`)
      .run(cutoffDate);
    return result.changes;
  }

  // Reminder methods
  createReminder(reminder: {
    id: string;
    chatId: number;
    message: string;
    dueAt: string;
    context: string;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO reminders (id, chat_id, message, due_at, context, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`
      )
      .run(
        reminder.id,
        reminder.chatId,
        reminder.message,
        reminder.dueAt,
        reminder.context,
        reminder.createdAt
      );
  }

  getPendingReminders(): Reminder[] {
    const now = new Date().toISOString();
    return (this.db
      .prepare(
        `SELECT id, chat_id as chatId, message, due_at as dueAt, context,
                created_at as createdAt, sent_at as sentAt, status
         FROM reminders
         WHERE status = 'pending' AND due_at <= ?
         ORDER BY due_at ASC`
      )
      .all(now) as ReminderRow[])
      .map((row) => this.mapReminderRow(row));
  }

  markReminderSent(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE reminders SET status = 'sent', sent_at = ? WHERE id = ?`)
      .run(now, id);
  }

  cancelReminder(id: string): boolean {
    const result = this.db
      .prepare(`UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'`)
      .run(id);
    return result.changes > 0;
  }

  getRemindersByChat(chatId: number, limit: number = 10): Reminder[] {
    return (this.db
      .prepare(
        `SELECT id, chat_id as chatId, message, due_at as dueAt, context,
                created_at as createdAt, sent_at as sentAt, status
         FROM reminders
         WHERE chat_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(chatId, limit) as ReminderRow[])
      .map((row) => this.mapReminderRow(row));
  }

  getPendingRemindersByChat(chatId: number): Reminder[] {
    return (this.db
      .prepare(
        `SELECT id, chat_id as chatId, message, due_at as dueAt, context,
                created_at as createdAt, sent_at as sentAt, status
         FROM reminders
         WHERE chat_id = ? AND status = 'pending'
         ORDER BY due_at ASC`
      )
      .all(chatId) as ReminderRow[])
      .map((row) => this.mapReminderRow(row));
  }

  getReminderById(id: string): Reminder | null {
    const row = this.db
      .prepare(
        `SELECT id, chat_id as chatId, message, due_at as dueAt, context,
                created_at as createdAt, sent_at as sentAt, status
         FROM reminders
         WHERE id = ?`
      )
      .get(id);

    return row ? this.mapReminderRow(row as ReminderRow) : null;
  }

  cleanupOldReminders(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
    const cutoffDate = new Date(Date.now() - maxAgeMs).toISOString();
    const result = this.db
      .prepare(`DELETE FROM reminders WHERE sent_at < ? OR (status = 'cancelled' AND created_at < ?)`)
      .run(cutoffDate, cutoffDate);
    return result.changes;
  }

  private mapReminderRow(row: ReminderRow): Reminder {
    return {
      id: row.id,
      chatId: row.chatId,
      message: row.message,
      dueAt: new Date(row.dueAt),
      context: row.context,
      createdAt: new Date(row.createdAt),
      sentAt: row.sentAt ? new Date(row.sentAt) : null,
      status: row.status as "pending" | "sent" | "cancelled",
    };
  }
}

export interface ScheduledJobState {
  jobId: string;
  sourceFile: string;
  enabled: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  updatedAt: string;
}

export interface ScheduledJobRun {
  id: number;
  jobId: string;
  jobName: string;
  sourceFile: string;
  startedAt: string;
  completedAt: string | null;
  success: number;
  output: string | null;
  error: string | null;
  exitCode: number | null;
}

export interface Job {
  id: string;
  lane: string;
  executor: string;
  query: string;
  status: "pending" | "running" | "completed" | "failed";
  chatId: number;
  messageId: number | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  attempts: number;
  error: string | null;
  result: string | null;
}

export interface Reminder {
  id: string;
  chatId: number;
  message: string;
  dueAt: Date;
  context: string;
  createdAt: Date;
  sentAt: Date | null;
  status: "pending" | "sent" | "cancelled";
}

interface ReminderRow {
  id: string;
  chatId: number;
  message: string;
  dueAt: string;
  context: string;
  createdAt: string;
  sentAt: string | null;
  status: string;
}
