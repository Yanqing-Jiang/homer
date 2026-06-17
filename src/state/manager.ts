import Database from "better-sqlite3";
import { randomUUID, createHash } from "crypto";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { logger } from "../utils/logger.js";
import { threadEvents } from "../events/thread-events.js";
import { sessionEvents } from "../events/session-events.js";

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
  private _db: Database.Database;
  private _closed = false;
  private ttlMs: number;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this._db = new Database(dbPath);
    const configuredTtl = Number.parseInt(process.env.SESSION_TTL_HOURS ?? "8", 10);
    const ttlHours = Number.isFinite(configuredTtl) && configuredTtl > 0 ? configuredTtl : 8;
    this.ttlMs = ttlHours * 60 * 60 * 1000;
    this.init();
  }

  /** Expose database for scheduler to query incomplete runs */
  getDb(): Database.Database {
    return this._db;
  }

  /** Public database accessor for backward compatibility with meetings/web APIs */
  get db(): Database.Database {
    return this._db;
  }

  private init(): void {
    // Prevent SQLITE_BUSY when daemon and MCP server write concurrently
    this._db.pragma("busy_timeout = 5000");
    // WAL mode for better concurrent read/write performance
    this._db.pragma("journal_mode = WAL");
    // Enable foreign key enforcement (SQLite defaults to OFF per-connection)
    this._db.pragma("foreign_keys = ON");

    this._db.exec(`
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

      -- Notification audit trail
      CREATE TABLE IF NOT EXISTS notification_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL DEFAULT 'telegram',
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        job_run_id INTEGER REFERENCES scheduled_job_runs(id) ON DELETE SET NULL,
        intent TEXT NOT NULL,
        decision TEXT NOT NULL,
        title TEXT,
        message_text TEXT NOT NULL,
        reason TEXT,
        metadata_json TEXT,
        telegram_message_id INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_notification_events_source
        ON notification_events(source_type, source_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_notification_events_job_run_id
        ON notification_events(job_run_id);
      CREATE INDEX IF NOT EXISTS idx_notification_events_decision
        ON notification_events(decision);
      CREATE INDEX IF NOT EXISTS idx_notification_events_created_at
        ON notification_events(created_at);

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

      -- Pending plans for implementation approval
      CREATE TABLE IF NOT EXISTS pending_plans (
        job_id TEXT PRIMARY KEY,
        plan TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- Executor state for persistent switching
      CREATE TABLE IF NOT EXISTS executor_state (
        lane TEXT PRIMARY KEY,
        executor TEXT NOT NULL DEFAULT 'claude',
        model TEXT,
        session_id TEXT,
        switched_at INTEGER NOT NULL,
        message_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS executor_session_map (
        lane TEXT NOT NULL,
        executor TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL,
        account_id INTEGER,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        PRIMARY KEY (lane, executor, model)
      );

      CREATE INDEX IF NOT EXISTS idx_executor_session_map_lane ON executor_session_map(lane);
      CREATE INDEX IF NOT EXISTS idx_executor_session_map_activity ON executor_session_map(last_used_at);

      -- Telegram replyable message registry (see migration 090).
      -- Mirrored here because init() runs before runMigrations().
      CREATE TABLE IF NOT EXISTS telegram_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        telegram_message_id INTEGER NOT NULL,
        lane TEXT NOT NULL,
        role TEXT NOT NULL,
        message_kind TEXT NOT NULL,
        thread_id TEXT,
        thread_message_id TEXT,
        run_id TEXT,
        session_id TEXT,
        message_text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        UNIQUE(chat_id, telegram_message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_telegram_messages_lane
        ON telegram_messages(lane, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_telegram_messages_expiry
        ON telegram_messages(expires_at);
    `);

    logger.debug("State manager initialized");
  }

  getOrCreateSession(lane: string): Session {
    const now = Date.now();
    const cutoff = now - this.ttlMs;

    // Try to find an active session for this lane
    const existing = this._db.prepare(
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
    this._db.prepare(
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
    this._db.prepare(
        `UPDATE sessions
         SET last_activity_at = ?, message_count = message_count + 1
         WHERE id = ?`
      )
      .run(now, sessionId);
  }

  getMostRecentSession(): Session | null {
    const now = Date.now();
    const cutoff = now - this.ttlMs;

    const session = this._db.prepare(
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

    return this._db.prepare(
        `SELECT id, lane, created_at as createdAt, last_activity_at as lastActivityAt, message_count as messageCount
         FROM sessions
         WHERE last_activity_at > ?
         ORDER BY last_activity_at DESC`
      )
      .all(cutoff) as Session[];
  }

  cleanupExpiredSessions(): number {
    const cutoff = Date.now() - this.ttlMs;
    const result = this._db.prepare(`DELETE FROM sessions WHERE last_activity_at < ?`).run(cutoff);

    if (result.changes > 0) {
      logger.info({ deletedCount: result.changes }, "Cleaned up expired sessions");
    }

    return result.changes;
  }

  get isOpen(): boolean {
    return !this._closed;
  }

  close(): void {
    this._closed = true;
    this._db.close();
  }

  // ── Pipeline dirty-flag methods ────────────────────────────

  markPipelineDirty(pipeline: string, source: string): void {
    this._db.prepare(`
      INSERT INTO pipeline_dirty (pipeline, is_dirty, last_trigger, marked_at)
      VALUES (?, 1, ?, datetime('now'))
      ON CONFLICT(pipeline) DO UPDATE SET
        is_dirty = 1,
        last_trigger = excluded.last_trigger,
        marked_at = excluded.marked_at
    `).run(pipeline, source);
  }

  isPipelineDirty(pipeline: string): boolean {
    const row = this._db.prepare(
      "SELECT is_dirty FROM pipeline_dirty WHERE pipeline = ?"
    ).get(pipeline) as { is_dirty: number } | undefined;
    return row?.is_dirty === 1;
  }

  clearPipelineDirty(pipeline: string): void {
    this._db.prepare(
      "UPDATE pipeline_dirty SET is_dirty = 0, cleared_at = datetime('now') WHERE pipeline = ?"
    ).run(pipeline);
  }

  // Executor session methods for Claude --resume
  // Uses composite key (lane:subcontext) for project isolation
  private getSessionKey(lane: string, subcontext?: string): string {
    return subcontext ? `${lane}:${subcontext}` : lane;
  }

  getClaudeSessionId(lane: string, subcontext?: string): string | null {
    const key = this.getSessionKey(lane, subcontext);
    const cutoff = Date.now() - this.ttlMs;
    const result = this._db.prepare(
        `SELECT claude_session_id FROM executor_sessions
         WHERE lane = ? AND last_used_at > ?`
      )
      .get(key, cutoff) as { claude_session_id: string } | undefined;

    return result?.claude_session_id ?? null;
  }

  setClaudeSessionId(lane: string, claudeSessionId: string, subcontext?: string): void {
    const key = this.getSessionKey(lane, subcontext);
    const now = Date.now();
    this._db.prepare(
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
    this._db.prepare(`UPDATE executor_sessions SET last_used_at = ? WHERE lane = ?`)
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
    this._db.prepare(
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

    return this._db.prepare(query).get(...params) as Job | null;
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

    this._db.prepare(query).run(...params);
  }

  getRunningJobsCount(lane?: string): number {
    let query = `SELECT COUNT(*) as count FROM job_queue WHERE status = 'running'`;
    const params: string[] = [];

    if (lane) {
      query += ` AND lane = ?`;
      params.push(lane);
    }

    const result = this._db.prepare(query).get(...params) as { count: number };
    return result.count;
  }

  /**
   * Recover stale jobs from previous crashed instances.
   * Jobs that were 'running' but older than threshold are reset to 'pending'.
   */
  recoverStaleJobs(staleThresholdMs: number): number {
    const cutoff = Date.now() - staleThresholdMs;
    const result = this._db.prepare(
      `UPDATE job_queue
       SET status = 'pending', started_at = NULL, attempts = attempts
       WHERE status = 'running' AND started_at < ?`
    ).run(cutoff);

    return result.changes;
  }

  /**
   * Clear is_running flags on all scheduled jobs — called on daemon startup
   * to recover from crashes that left flags stuck.
   */
  clearStaleScheduledJobFlags(): void {
    const result = this._db.prepare(
      `UPDATE scheduled_job_state SET is_running = 0 WHERE is_running = 1`
    ).run();
    if (result.changes > 0) {
      logger.warn({ count: result.changes }, "Cleared stale scheduled job running flags");
    }
  }

  getJobById(jobId: string): Job | null {
    return this._db.prepare(
        `SELECT id, lane, executor, query, status, chat_id as chatId, message_id as messageId,
                created_at as createdAt, started_at as startedAt, completed_at as completedAt,
                attempts, error, result
         FROM job_queue WHERE id = ?`
      )
      .get(jobId) as Job | null;
  }

  getRecentJobs(limit: number = 50): Job[] {
    return this._db.prepare(
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
    const result = this._db.prepare(
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
    const result = this._db.prepare(`DELETE FROM job_queue WHERE completed_at < ? AND status IN ('completed', 'failed')`)
      .run(cutoff);
    return result.changes;
  }

  // ============================================
  // Idea Review State (Daily Limits)
  // ============================================

  private getLocalDateKey(date?: Date): string {
    const d = date ?? new Date();
    // en-CA yields YYYY-MM-DD
    return new Intl.DateTimeFormat("en-CA").format(d);
  }

  getIdeaReviewCount(date?: Date): number {
    const key = this.getLocalDateKey(date);
    const row = this._db.prepare(
      "SELECT sent_count as sentCount FROM idea_review_state WHERE date = ?"
    ).get(key) as { sentCount?: number } | undefined;
    return row?.sentCount ?? 0;
  }

  incrementIdeaReviewCount(delta: number = 1, date?: Date): number {
    const key = this.getLocalDateKey(date);
    this._db.prepare(
      `INSERT INTO idea_review_state (date, sent_count, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(date) DO UPDATE SET sent_count = sent_count + excluded.sent_count,
       updated_at = CURRENT_TIMESTAMP`
    ).run(key, delta);

    return this.getIdeaReviewCount(date);
  }

  // Scheduled job methods
  recordScheduledJobStart(jobId: string, jobName: string, sourceFile: string): number | null {
    const txn = this._db.transaction(() => {
      const now = new Date().toISOString();

      this._db.prepare(
        `INSERT OR IGNORE INTO scheduled_job_state (job_id, source_file, is_running, updated_at)
         VALUES (?, ?, 0, ?)`
      ).run(jobId, sourceFile, now);

      const lock = this._db.prepare(
        `UPDATE scheduled_job_state
         SET source_file = ?, last_run_at = ?, is_running = 1, updated_at = ?
         WHERE job_id = ? AND is_running = 0`
      ).run(sourceFile, now, now, jobId);

      if (lock.changes === 0) return null;

      const result = this._db.prepare(
        `INSERT INTO scheduled_job_runs (job_id, job_name, source_file, started_at, success)
         VALUES (?, ?, ?, ?, 0)`
      ).run(jobId, jobName, sourceFile, now);

      return result.lastInsertRowid as number;
    });

    const runId = txn();
    if (runId === null) {
      logger.warn({ jobId }, "Job already running, skipping this trigger");
    }
    return runId;
  }

  /**
   * Record a job failure but keep the is_running lock held.
   * Used before failure takeover so cron can't re-trigger the job.
   */
  recordScheduledJobFailed(
    runId: number,
    _jobId: string,
    output: string,
    error?: string,
    exitCode?: number
  ): void {
    this._db.prepare(
      `UPDATE scheduled_job_runs
       SET completed_at = ?, success = 0, output = ?, error = ?, exit_code = ?
       WHERE id = ?`
    ).run(new Date().toISOString(), output, error ?? null, exitCode ?? null, runId);
    // NOTE: does NOT update scheduled_job_state.is_running or consecutive_failures
  }

  recordScheduledJobComplete(
    runId: number,
    jobId: string,
    success: boolean,
    output: string,
    error?: string,
    exitCode?: number
  ): void {
    const now = new Date().toISOString();

    // Update the specific run by runId (not by job_id)
    this._db.prepare(
        `UPDATE scheduled_job_runs
         SET completed_at = ?, success = ?, output = ?, error = ?, exit_code = ?
         WHERE id = ?`
      )
      .run(now, success ? 1 : 0, output, error ?? null, exitCode ?? null, runId);

    // Update job state and clear is_running flag
    if (success) {
      this._db.prepare(
          `UPDATE scheduled_job_state
           SET last_success_at = ?, consecutive_failures = 0, is_running = 0, updated_at = ?
           WHERE job_id = ?`
        )
        .run(now, now, jobId);
    } else {
      this._db.prepare(
          `UPDATE scheduled_job_state
           SET consecutive_failures = consecutive_failures + 1, is_running = 0, updated_at = ?
           WHERE job_id = ?`
        )
        .run(now, jobId);
    }
  }

  /**
   * Update the next scheduled run time for a job
   */
  updateScheduledJobNextRun(jobId: string, nextRunAt: Date | null): void {
    const nextRunStr = nextRunAt ? nextRunAt.toISOString() : null;
    const nextRunMs = nextRunAt ? nextRunAt.getTime() : null;
    this._db.prepare(
        `UPDATE scheduled_job_state
         SET next_run_at = ?, next_run_at_ms = ?, updated_at = ?
         WHERE job_id = ?`
      )
      .run(nextRunStr, nextRunMs, new Date().toISOString(), jobId);
  }

  /**
   * Update next_run_at_ms for DB-driven catch-up
   */
  updateNextRunAtMs(jobId: string, ms: number | null): void {
    this._db.prepare(
      `UPDATE scheduled_job_state SET next_run_at_ms = ?, updated_at = ? WHERE job_id = ?`
    ).run(ms, new Date().toISOString(), jobId);
  }

  /**
   * Get jobs that are overdue (next_run_at_ms in the past, not running, enabled)
   */
  getDueJobs(): Array<{ jobId: string; nextRunAtMs: number; lastTriggeredAt: string | null }> {
    return this._db.prepare(
      `SELECT job_id as jobId, next_run_at_ms as nextRunAtMs, last_triggered_at as lastTriggeredAt
       FROM scheduled_job_state
       WHERE next_run_at_ms < ? AND is_running = 0 AND enabled = 1
       ORDER BY next_run_at_ms ASC`
    ).all(Date.now()) as Array<{ jobId: string; nextRunAtMs: number; lastTriggeredAt: string | null }>;
  }

  /**
   * Record that a job was triggered by the compensation system
   */
  recordCompensationTrigger(jobId: string): void {
    this._db.prepare(
      `UPDATE scheduled_job_state SET last_triggered_at = ?, updated_at = ? WHERE job_id = ?`
    ).run(new Date().toISOString(), new Date().toISOString(), jobId);
  }

  getScheduledJobState(jobId: string): ScheduledJobState | null {
    return this._db.prepare(
        `SELECT job_id as jobId, source_file as sourceFile, enabled,
                last_run_at as lastRunAt, last_success_at as lastSuccessAt,
                next_run_at as nextRunAt,
                consecutive_failures as consecutiveFailures, updated_at as updatedAt
         FROM scheduled_job_state WHERE job_id = ?`
      )
      .get(jobId) as ScheduledJobState | null;
  }

  getRecentScheduledJobRuns(jobId: string, limit: number = 10): ScheduledJobRun[] {
    return this._db.prepare(
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
    return this._db.prepare(
        `SELECT job_id as jobId, source_file as sourceFile, enabled,
                last_run_at as lastRunAt, last_success_at as lastSuccessAt,
                next_run_at as nextRunAt,
                consecutive_failures as consecutiveFailures, updated_at as updatedAt
         FROM scheduled_job_state
         ORDER BY updated_at DESC`
      )
      .all() as ScheduledJobState[];
  }

  /**
   * Ensure DB rows exist for all known jobs at boot.
   * Uses INSERT OR IGNORE so existing rows are untouched.
   */
  ensureJobStateRows(jobs: Array<{ jobId: string; sourceFile: string; enabled: boolean }>): void {
    const stmt = this._db.prepare(
      `INSERT OR IGNORE INTO scheduled_job_state (job_id, source_file, enabled, updated_at)
       VALUES (?, ?, ?, ?)`
    );
    const now = new Date().toISOString();
    const tx = this._db.transaction(() => {
      for (const j of jobs) {
        stmt.run(j.jobId, j.sourceFile, j.enabled ? 1 : 0, now);
      }
    });
    tx();
  }

  /**
   * Sync enabled state from schedule config into DB.
   * Prevents drift between schedule.json and scheduled_job_state table.
   */
  syncScheduledJobEnabled(jobStates: { jobId: string; enabled: boolean }[]): void {
    const stmt = this._db.prepare(
      `UPDATE scheduled_job_state SET enabled = ?, updated_at = ? WHERE job_id = ?`
    );
    const now = new Date().toISOString();
    const txn = this._db.transaction(() => {
      for (const { jobId, enabled } of jobStates) {
        stmt.run(enabled ? 1 : 0, now, jobId);
      }
    });
    txn();
  }

  cleanupOldScheduledJobRuns(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): number {
    const cutoffDate = new Date(Date.now() - maxAgeMs).toISOString();
    const txn = this._db.transaction(() => {
      // Delete/nullify child rows first to satisfy FK constraints
      this._db.prepare(
        `DELETE FROM failure_takeover_runs WHERE job_run_id IN
         (SELECT id FROM scheduled_job_runs WHERE completed_at < ?)`
      ).run(cutoffDate);
      this._db.prepare(
        `DELETE FROM job_artifacts WHERE job_run_id IN
         (SELECT id FROM scheduled_job_runs WHERE completed_at < ?)`
      ).run(cutoffDate);
      this._db.prepare(
        `UPDATE notification_events SET job_run_id = NULL WHERE job_run_id IN
         (SELECT id FROM scheduled_job_runs WHERE completed_at < ?)`
      ).run(cutoffDate);
      return this._db.prepare(
        `DELETE FROM scheduled_job_runs WHERE completed_at < ?`
      ).run(cutoffDate);
    });
    return txn().changes;
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
    this._db.prepare(
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
    this._db.prepare(`UPDATE reminders SET status = 'sent', sent_at = ? WHERE id = ?`)
      .run(now, id);
  }

  cancelReminder(id: string): boolean {
    const result = this._db.prepare(`UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'`)
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
    const row = this._db.prepare(
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
    const result = this._db.prepare(`DELETE FROM reminders WHERE sent_at < ? OR (status = 'cancelled' AND created_at < ?)`)
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

  // ============================================
  // Web UI Chat Session Methods (stubs for future implementation)
  // These use 'any' types to accommodate partially implemented Web UI code
  // ============================================

  listChatSessions(options?: {
    includeArchived?: boolean;
    limit?: number;
    cursor?: string;
  }): ChatSession[] {
    const includeArchived = options?.includeArchived ?? false;
    const limit = options?.limit ?? 50;
    const cursor = options?.cursor;

    const whereClauses: string[] = [];
    const params: Array<string | number> = [];

    if (!includeArchived) {
      whereClauses.push("archived_at IS NULL");
    }

    if (cursor) {
      whereClauses.push("updated_at < ?");
      params.push(cursor);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    return this._db.prepare(
        `SELECT id, name, created_at as createdAt, updated_at as updatedAt, archived_at as archivedAt
         FROM chat_sessions
         ${whereSql}
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(...params, limit) as ChatSession[];
  }

  createChatSession(session: { id: string; name: string }): ChatSession {
    const now = new Date().toISOString();
    this._db.prepare(
        `INSERT INTO chat_sessions (id, name, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, NULL)`
      )
      .run(session.id, session.name, now, now);

    return this.getChatSession(session.id) as ChatSession;
  }

  getChatSession(id: string): ChatSession | null {
    const row = this._db.prepare(
        `SELECT id, name, created_at as createdAt, updated_at as updatedAt, archived_at as archivedAt
         FROM chat_sessions WHERE id = ?`
      )
      .get(id) as ChatSession | undefined;

    return row ?? null;
  }

  ensureChatSession(id: string, name: string, archived = false): ChatSession {
    const existing = this.getChatSession(id);
    if (existing) {
      if (archived && !existing.archivedAt) {
        this.updateChatSession(id, { archivedAt: new Date().toISOString() });
        return this.getChatSession(id) as ChatSession;
      }
      return existing;
    }

    const now = new Date().toISOString();
    this._db.prepare(
        `INSERT INTO chat_sessions (id, name, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, name, now, now, archived ? now : null);

    return this.getChatSession(id) as ChatSession;
  }

  updateChatSession(id: string, updates: { name?: string; archivedAt?: string | null }): void {
    const fields: string[] = [];
    const params: Array<string | null> = [];

    if (updates.name !== undefined) {
      fields.push("name = ?");
      params.push(updates.name);
    }

    if (updates.archivedAt !== undefined) {
      fields.push("archived_at = ?");
      params.push(updates.archivedAt);
    }

    // Always bump updated_at
    fields.push("updated_at = ?");
    params.push(new Date().toISOString());

    if (fields.length === 0) return;

    this._db.prepare(
        `UPDATE chat_sessions SET ${fields.join(", ")} WHERE id = ?`
      )
      .run(...params, id);
  }

  markSessionRead(sessionId: string): void {
    const now = new Date().toISOString();
    this._db.prepare(
      `INSERT INTO session_reads (session_id, read_at) VALUES (?, ?)
       ON CONFLICT(session_id) DO UPDATE SET read_at = ?`
    ).run(sessionId, now, now);
  }

  getSessionReadAt(sessionId: string): string | null {
    const row = this._db.prepare(
      `SELECT read_at FROM session_reads WHERE session_id = ?`
    ).get(sessionId) as { read_at: string } | undefined;
    return row?.read_at ?? null;
  }

  deleteChatSession(id: string): void {
    this._db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
  }

  listThreads(sessionId: string): Thread[] {
    return this._db.prepare(
        `SELECT id, chat_session_id as chatSessionId, title, provider, model, status,
                external_session_id as externalSessionId, parent_thread_id as parentThreadId,
                branch_point_message_id as branchPointMessageId, last_message_at as lastMessageAt,
                created_at as createdAt
         FROM threads WHERE chat_session_id = ?
         ORDER BY last_message_at DESC NULLS LAST, created_at DESC`
      )
      .all(sessionId) as Thread[];
  }

  createThread(thread: {
    id: string;
    chatSessionId: string;
    title?: string | null;
    provider: string;
    model?: string | null;
    parentThreadId?: string | null;
    branchPointMessageId?: string | null;
  }): Thread {
    this._db.prepare(
        `INSERT INTO threads (id, chat_session_id, title, provider, model, status, external_session_id,
                              parent_thread_id, branch_point_message_id, last_message_at)
         VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?, NULL)`
      )
      .run(
        thread.id,
        thread.chatSessionId,
        thread.title ?? null,
        thread.provider,
        thread.model ?? null,
        thread.parentThreadId ?? null,
        thread.branchPointMessageId ?? null
      );

    return this.getThread(thread.id) as Thread;
  }

  ensureThreadForLane(
    lane: string,
    options?: { title?: string; provider?: string; model?: string | null }
  ): Thread {
    if (this._closed) throw new Error("StateManager is closed");
    const existing = this.getThread(lane);
    if (existing) return existing;

    const systemSessionId = "tg:system";
    const session = this.ensureChatSession(systemSessionId, "Telegram", true);
    const title = options?.title ?? `Telegram ${lane.replace(/^tg:/, "")}`;
    const provider = options?.provider ?? "telegram";
    const model = options?.model ?? null;

    return this.createThread({
      id: lane,
      chatSessionId: session.id,
      title,
      provider,
      model,
    });
  }

  getThread(id: string): Thread | null {
    const row = this._db.prepare(
        `SELECT id, chat_session_id as chatSessionId, title, provider, model, status,
                external_session_id as externalSessionId, parent_thread_id as parentThreadId,
                branch_point_message_id as branchPointMessageId, last_message_at as lastMessageAt,
                created_at as createdAt
         FROM threads WHERE id = ?`
      )
      .get(id) as Thread | undefined;

    return row ?? null;
  }

  updateThread(id: string, updates: {
    title?: string | null;
    status?: string;
    externalSessionId?: string | null;
    model?: string | null;
    provider?: string | null;
    lastMessageAt?: string | null;
  }): void {
    const fields: string[] = [];
    const params: Array<string | null> = [];

    if (updates.title !== undefined) {
      fields.push("title = ?");
      params.push(updates.title);
    }
    if (updates.status !== undefined) {
      fields.push("status = ?");
      params.push(updates.status);
    }
    if (updates.externalSessionId !== undefined) {
      fields.push("external_session_id = ?");
      params.push(updates.externalSessionId);
    }
    if (updates.model !== undefined) {
      fields.push("model = ?");
      params.push(updates.model);
    }
    if (updates.provider !== undefined) {
      fields.push("provider = ?");
      params.push(updates.provider);
    }
    if (updates.lastMessageAt !== undefined) {
      fields.push("last_message_at = ?");
      params.push(updates.lastMessageAt);
    }

    if (fields.length === 0) return;

    this._db.prepare(
        `UPDATE threads SET ${fields.join(", ")} WHERE id = ?`
      )
      .run(...params, id);
  }

  listThreadMessages(threadId: string, options?: { limit?: number; beforeId?: string }): ThreadMessage[] {
    const limit = options?.limit ?? 100;
    const beforeId = options?.beforeId;

    if (beforeId) {
      const rows = this._db.prepare(
          `SELECT id, thread_id as threadId, role, content, metadata, created_at as createdAt
           FROM thread_messages
           WHERE thread_id = ?
             AND created_at < (SELECT created_at FROM thread_messages WHERE id = ?)
           ORDER BY created_at ASC
           LIMIT ?`
        )
        .all(threadId, beforeId, limit) as Array<ThreadMessage & { metadata: string | null }>;

      return rows.map((row) => ({
        ...row,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
      }));
    }

    const rows = this._db.prepare(
        `SELECT id, thread_id as threadId, role, content, metadata, created_at as createdAt
         FROM thread_messages
         WHERE thread_id = ?
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(threadId, limit) as Array<ThreadMessage & { metadata: string | null }>;

    return rows.map((row) => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    }));
  }

  getThreadMessages(threadId: string, limit = 50, beforeId?: string): ThreadMessage[] {
    const rows = beforeId
      ? this._db.prepare(
          `SELECT id, thread_id as threadId, role, content, metadata, created_at as createdAt
           FROM thread_messages
           WHERE thread_id = ?
             AND created_at < (SELECT created_at FROM thread_messages WHERE id = ?)
           ORDER BY created_at DESC
           LIMIT ?`
        ).all(threadId, beforeId, limit)
      : this._db.prepare(
          `SELECT id, thread_id as threadId, role, content, metadata, created_at as createdAt
           FROM thread_messages
           WHERE thread_id = ?
           ORDER BY created_at DESC
           LIMIT ?`
        ).all(threadId, limit);

    return (rows as Array<ThreadMessage & { metadata: string | null }>).map((row) => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    }));
  }

  getLaneMessages(lane: string, limit = 50, beforeId?: string): ThreadMessage[] {
    this.ensureThreadForLane(lane);
    return this.getThreadMessages(lane, limit, beforeId);
  }

  createThreadMessage(message: {
    id: string;
    threadId: string;
    role: "user" | "assistant" | "system";
    content: string;
    metadata?: Record<string, unknown> | null;
  }): ThreadMessage {
    const now = new Date().toISOString();
    const metadataJson = message.metadata ? JSON.stringify(message.metadata) : null;

    this._db.prepare(
        `INSERT INTO thread_messages (id, thread_id, role, content, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(message.id, message.threadId, message.role, message.content, metadataJson, now);

    // Update thread + session timestamps (activity_at only bumped by messages, not rename/archive)
    this._db.prepare(`UPDATE threads SET last_message_at = ? WHERE id = ?`).run(now, message.threadId);
    this._db.prepare(
        `UPDATE chat_sessions SET updated_at = ?, activity_at = ?
         WHERE id = (SELECT chat_session_id FROM threads WHERE id = ?)`
      )
      .run(now, now, message.threadId);

    const result: ThreadMessage = {
      id: message.id,
      threadId: message.threadId,
      role: message.role,
      content: message.content,
      metadata: message.metadata ?? null,
      createdAt: now,
    };

    // Emit event for real-time SSE subscribers
    try {
      threadEvents.emitMessage(message.threadId, result);
    } catch (e) {
      logger.warn({ error: e, threadId: message.threadId }, "Thread event emission failed");
    }

    // Emit session-level activity event
    try {
      const thread = this.getThread(message.threadId);
      if (thread) {
        sessionEvents.emitSessionEvent({
          type: "activity",
          sessionId: thread.chatSessionId,
          data: { threadId: message.threadId, messageId: result.id },
        });
      }
    } catch (e) {
      logger.warn({ error: e }, "Session event emission failed");
    }

    return result;
  }

  getThreadLinks(threadId: string): ThreadLink[] {
    return this._db.prepare(
        `SELECT thread_id as threadId, link_type as linkType, link_id as linkId, created_at as createdAt
         FROM thread_links WHERE thread_id = ?`
      )
      .all(threadId) as ThreadLink[];
  }

  createThreadLink(link: { threadId: string; linkType: string; linkId: string }): void {
    this._db.prepare(
        `INSERT OR IGNORE INTO thread_links (thread_id, link_type, link_id)
         VALUES (?, ?, ?)`
      )
      .run(link.threadId, link.linkType, link.linkId);
  }

  getLinkedThreads(entityType: string, entityId: string): string[] {
    const rows = this._db.prepare(
        `SELECT thread_id as threadId FROM thread_links WHERE link_type = ? AND link_id = ?`
      )
      .all(entityType, entityId) as { threadId: string }[];

    return rows.map((r) => r.threadId);
  }

  // ============================================
  // Queue Methods for Worker
  // ============================================

  claimNextPendingJob(_workerId?: string, lane?: string): Job | null {
    const job = this.getNextPendingJob(lane);
    if (job) {
      this.updateJobStatus(job.id, "running");
    }
    return job;
  }

  touchJobHeartbeat(jobId: string): boolean {
    // Update started_at as heartbeat indicator
    const now = Date.now();
    const result = this._db.prepare(`UPDATE job_queue SET started_at = ? WHERE id = ? AND status = 'running'`)
      .run(now, jobId);
    return result.changes > 0;
  }

  failAllRunningJobs(): void {
    const now = Date.now();
    this._db.prepare(
      `UPDATE job_queue SET status = 'failed', completed_at = ?, error = 'Daemon shutdown' WHERE status = 'running'`
    ).run(now);
  }

  failAllRunningCliRuns(): number {
    const now = Date.now();
    const result = this._db.prepare(
      `UPDATE cli_runs SET status = 'failed', completed_at = ?, error = 'Daemon shutdown' WHERE status = 'running'`
    ).run(now);
    return result.changes;
  }

  /**
   * Clear stale is_running flags from scheduled_job_state.
   * Call on startup to prevent jobs stuck after crashes.
   */
  resetScheduledJobRunFlags(): number {
    const result = this._db.prepare(
      `UPDATE scheduled_job_state SET is_running = 0 WHERE is_running = 1`
    ).run();
    return result.changes;
  }

  /**
   * Mark orphaned job runs (started but never completed) as failed.
   * Call on startup after clearing is_running flags.
   */
  cleanupOrphanedJobRuns(): number {
    const result = this._db.prepare(`
      UPDATE scheduled_job_runs
      SET completed_at = CURRENT_TIMESTAMP,
          success = 0,
          error = 'Daemon restarted before job completed'
      WHERE completed_at IS NULL
    `).run();
    return result.changes;
  }

  // ============================================
  // Pending Plans (Implementation Approval)
  // ============================================

  /**
   * Save a plan that requires user approval before execution
   */
  savePendingPlan(jobId: string, plan: string): void {
    this._db.prepare(`
      INSERT OR REPLACE INTO pending_plans (job_id, plan, created_at)
      VALUES (?, ?, ?)
    `).run(jobId, plan, Date.now());
  }

  /**
   * Get a pending plan by job ID
   */
  getPendingPlan(jobId: string): string | null {
    const row = this._db.prepare(
      "SELECT plan FROM pending_plans WHERE job_id = ?"
    ).get(jobId) as { plan: string } | undefined;

    return row?.plan ?? null;
  }

  /**
   * List all pending plans
   */
  listPendingPlans(): Array<{ jobId: string; plan: string; createdAt: number }> {
    try {
      return this._db.prepare(`
        SELECT job_id as jobId, plan, created_at as createdAt
        FROM pending_plans
        ORDER BY created_at DESC
      `).all() as Array<{ jobId: string; plan: string; createdAt: number }>;
    } catch {
      return [];
    }
  }

  /**
   * Clear a pending plan after approval or rejection
   */
  clearPendingPlan(jobId: string): void {
    this._db.prepare("DELETE FROM pending_plans WHERE job_id = ?").run(jobId);
  }

  // ============================================
  // Plan Reviews (Structured Cards)
  // ============================================

  /**
   * Save a structured plan review for Telegram card rendering.
   */
  savePlanReview(planId: string, planJson: string, title: string, riskLevel: string, source?: string, chatId?: number): void {
    this._db.prepare(`
      INSERT OR REPLACE INTO plan_reviews (id, status, revision_number, title, plan_json, risk_level, source, chat_id, created_at, updated_at)
      VALUES (?, 'pending_review', 1, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(planId, title, planJson, riskLevel, source ?? null, chatId ?? null);
  }

  /**
   * Get a plan review by ID.
   */
  getPlanReview(planId: string): { id: string; parentPlanId: string | null; status: string; revisionNumber: number; title: string; planJson: string; riskLevel: string; source: string | null; chatId: number | null; cardMessageId: number | null; createdAt: string; updatedAt: string; decidedAt: string | null; decisionFeedback: string | null } | null {
    try {
      const row = this._db.prepare(`
        SELECT id, parent_plan_id as parentPlanId, status, revision_number as revisionNumber,
               title, plan_json as planJson, risk_level as riskLevel, source,
               chat_id as chatId, card_message_id as cardMessageId,
               created_at as createdAt, updated_at as updatedAt,
               decided_at as decidedAt, decision_feedback as decisionFeedback
        FROM plan_reviews WHERE id = ?
      `).get(planId) as NonNullable<ReturnType<StateManager["getPlanReview"]>> | undefined;
      return row ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Update plan review status and optional fields.
   */
  updatePlanReviewStatus(planId: string, status: string, opts?: { cardMessageId?: number; decidedAt?: boolean; feedback?: string; planJson?: string; revisionNumber?: number }): void {
    const sets = ["status = ?", "updated_at = datetime('now')"];
    const params: unknown[] = [status];

    if (opts?.cardMessageId != null) { sets.push("card_message_id = ?"); params.push(opts.cardMessageId); }
    if (opts?.decidedAt) { sets.push("decided_at = datetime('now')"); }
    if (opts?.feedback != null) { sets.push("decision_feedback = ?"); params.push(opts.feedback); }
    if (opts?.planJson != null) { sets.push("plan_json = ?"); params.push(opts.planJson); }
    if (opts?.revisionNumber != null) { sets.push("revision_number = ?"); params.push(opts.revisionNumber); }

    params.push(planId);
    this._db.prepare(`UPDATE plan_reviews SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  // plan_revision_feedback — table dropped in migration 072 (0 rows ever existed)

  // ============================================
  // Executor State (Persistent Switching)
  // ============================================

  private normalizeExecutorModel(model?: string | null): string {
    return model ?? "";
  }

  /**
   * Get stored session id for a specific executor/model.
   */
  getStoredExecutorSessionId(
    lane: string,
    executor: ExecutorStateType,
    model?: string | null
  ): string | null {
    const session = this.getStoredExecutorSession(lane, executor, model);
    return session.sessionId;
  }

  /**
   * Get stored session metadata for a specific executor/model.
   */
  getStoredExecutorSession(
    lane: string,
    executor: ExecutorStateType,
    model?: string | null
  ): { sessionId: string | null; accountId?: number | null } {
    const cutoff = Date.now() - this.ttlMs;
    const normalizedModel = this.normalizeExecutorModel(model);
    const row = this._db.prepare(
      `SELECT session_id as sessionId, account_id as accountId
       FROM executor_session_map
       WHERE lane = ? AND executor = ? AND model = ? AND last_used_at > ?`
    ).get(lane, executor, normalizedModel, cutoff) as { sessionId?: string; accountId?: number | null } | undefined;

    return { sessionId: row?.sessionId ?? null, accountId: row?.accountId ?? null };
  }

  /**
   * Store session id for a specific executor/model.
   */
  setStoredExecutorSessionId(
    lane: string,
    executor: ExecutorStateType,
    sessionId: string,
    model?: string | null,
    accountId?: number | null
  ): void {
    const now = Date.now();
    const normalizedModel = this.normalizeExecutorModel(model);
    this._db.prepare(
      `INSERT INTO executor_session_map (lane, executor, model, session_id, account_id, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(lane, executor, model) DO UPDATE SET
         session_id = excluded.session_id,
         account_id = excluded.account_id,
         last_used_at = excluded.last_used_at`
    ).run(lane, executor, normalizedModel, sessionId, accountId ?? null, now, now);
  }

  /**
   * Clear stored executor sessions for a lane (optionally scoped).
   */
  clearStoredExecutorSessions(lane: string, executor?: ExecutorStateType, model?: string | null): void {
    if (!executor) {
      this._db.prepare("DELETE FROM executor_session_map WHERE lane = ?").run(lane);
      return;
    }

    if (model !== undefined) {
      const normalizedModel = this.normalizeExecutorModel(model);
      this._db.prepare(
        "DELETE FROM executor_session_map WHERE lane = ? AND executor = ? AND model = ?"
      ).run(lane, executor, normalizedModel);
      return;
    }

    this._db.prepare(
      "DELETE FROM executor_session_map WHERE lane = ? AND executor = ?"
    ).run(lane, executor);
  }

  /**
   * Get the current executor for a lane
   */
  getCurrentExecutor(lane: string): ExecutorState | null {
    const result = this._db.prepare(
      `SELECT lane, executor, model, session_id as sessionId, switched_at as switchedAt, message_count as messageCount
       FROM executor_state WHERE lane = ?`
    ).get(lane) as ExecutorStateRow | undefined;

    if (!result) return null;

    return {
      lane: result.lane,
      executor: result.executor as ExecutorStateType,
      model: result.model,
      sessionId: result.sessionId ?? null,
      switchedAt: result.switchedAt,
      messageCount: result.messageCount,
    };
  }

  /**
   * Set the current executor for a lane (persists until /new)
   */
  setCurrentExecutor(lane: string, executor: ExecutorStateType, model?: string, sessionId?: string | null): void {
    const now = Date.now();
    const resolvedSessionId = sessionId === undefined
      ? this.getStoredExecutorSessionId(lane, executor, model)
      : sessionId;
    this._db.prepare(
      `INSERT INTO executor_state (lane, executor, model, session_id, switched_at, message_count)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT(lane) DO UPDATE SET
         executor = excluded.executor,
         model = excluded.model,
         session_id = excluded.session_id,
         switched_at = excluded.switched_at,
         message_count = 0`
    ).run(lane, executor, model ?? null, resolvedSessionId ?? null, now);

    logger.debug({ lane, executor, model, sessionId: resolvedSessionId ?? null }, "Set executor state");
  }

  /**
   * Increment message count for executor state
   */
  incrementExecutorMessageCount(lane: string): void {
    this._db.prepare(
      `UPDATE executor_state SET message_count = message_count + 1 WHERE lane = ?`
    ).run(lane);
  }

  /**
   * Update executor session id for a lane
   */
  setExecutorSessionId(
    lane: string,
    sessionId: string | null,
    executor?: ExecutorStateType,
    model?: string | null,
    accountId?: number | null
  ): void {
    this._db.prepare(
      `UPDATE executor_state SET session_id = ? WHERE lane = ?`
    ).run(sessionId, lane);

    const effectiveExecutor = executor ?? this.getCurrentExecutor(lane)?.executor;
    const effectiveModel = model ?? this.getCurrentExecutor(lane)?.model ?? null;

    if (effectiveExecutor && sessionId) {
      this.setStoredExecutorSessionId(lane, effectiveExecutor, sessionId, effectiveModel, accountId ?? null);
    }
  }

  /**
   * Clear executor state (reset to default on /new)
   */
  clearExecutor(lane: string): void {
    this._db.prepare("DELETE FROM executor_state WHERE lane = ?").run(lane);
    logger.debug({ lane }, "Cleared executor state");
  }

  /**
   * Get all active executor states
   */
  getAllExecutorStates(): ExecutorState[] {
    return this._db.prepare(
      `SELECT lane, executor, model, session_id as sessionId, switched_at as switchedAt, message_count as messageCount
       FROM executor_state ORDER BY switched_at DESC`
    ).all() as ExecutorState[];
  }

  // ============================================
  // CLI Runs (Non-streaming execution tracking)
  // ============================================

  createCliRun(run: {
    id: string;
    lane: string;
    executor: string;
    threadId?: string | null;
    status: CLIRunStatus;
    startedAt: number;
  }): void {
    this._db.prepare(
      `INSERT INTO cli_runs (id, lane, executor, thread_id, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      run.id,
      run.lane,
      run.executor,
      run.threadId ?? null,
      run.status,
      run.startedAt
    );
  }

  updateCliRunStream(runId: string, updates: {
    appendDelta?: string | null;
    phase?: string | null;
    seq?: number | null;
    updatedAt?: number | null;
  }): void {
    const fields: string[] = [];
    const params: Array<string | number | null> = [];

    if (updates.appendDelta) {
      fields.push("stream_text = COALESCE(stream_text, '') || ?");
      params.push(updates.appendDelta);
    }

    if (updates.phase !== undefined) {
      fields.push("stream_phase = ?");
      params.push(updates.phase);
    }

    if (updates.seq !== undefined) {
      fields.push("stream_seq = ?");
      params.push(updates.seq);
    }

    if (updates.updatedAt !== undefined) {
      fields.push("stream_updated_at = ?");
      params.push(updates.updatedAt);
    }

    if (fields.length === 0) return;

    params.push(runId);

    this._db.prepare(
      `UPDATE cli_runs
       SET ${fields.join(", ")}
       WHERE id = ?`
    ).run(...params);
  }

  updateCliRunStatus(runId: string, status: CLIRunStatus): void {
    this._db.prepare(
      `UPDATE cli_runs SET status = ? WHERE id = ?`
    ).run(status, runId);
  }

  completeCliRun(runId: string, updates: {
    status: CLIRunStatus;
    completedAt: number;
    exitCode?: number | null;
    output?: string | null;
    error?: string | null;
    executor?: string | null;
  }): void {
    const fields = [
      "status = ?",
      "completed_at = ?",
      "exit_code = ?",
      "output = ?",
      "error = ?",
    ];
    const params: Array<string | number | null> = [
      updates.status,
      updates.completedAt,
      updates.exitCode ?? null,
      updates.output ?? null,
      updates.error ?? null,
    ];

    if (updates.executor) {
      fields.push("executor = ?");
      params.push(updates.executor);
    }

    params.push(runId);

    this._db.prepare(
      `UPDATE cli_runs
       SET ${fields.join(", ")}
       WHERE id = ?`
    ).run(...params);
  }

  getCliRun(runId: string): CLIRunRecord | null {
    const row = this._db.prepare(
      `SELECT id, lane, executor, thread_id as threadId, status,
              started_at as startedAt, completed_at as completedAt,
              exit_code as exitCode, output, error,
              stream_text as streamText, stream_phase as streamPhase,
              stream_seq as streamSeq, stream_updated_at as streamUpdatedAt
       FROM cli_runs WHERE id = ?`
    ).get(runId) as CLIRunRecord | undefined;
    return row ?? null;
  }

  getActiveCliRunForLane(lane: string): CLIRunRecord | null {
    const row = this._db.prepare(
      `SELECT id, lane, executor, thread_id as threadId, status,
              started_at as startedAt, completed_at as completedAt,
              exit_code as exitCode, output, error,
              stream_text as streamText, stream_phase as streamPhase,
              stream_seq as streamSeq, stream_updated_at as streamUpdatedAt
       FROM cli_runs
       WHERE lane = ? AND status = 'running'
       ORDER BY started_at DESC
       LIMIT 1`
    ).get(lane) as CLIRunRecord | undefined;
    return row ?? null;

  }

  // ============================================
  // Run Events (step persistence for replay)
  // ============================================

  createRunEvent(event: {
    id: string;
    runId: string;
    threadId: string;
    kind: string;
    label?: string;
    labelDone?: string;
    payload?: Record<string, unknown>;
  }): void {
    const payloadJson = event.payload
      ? JSON.stringify(event.payload).slice(0, 4096)
      : null;
    this._db.prepare(
      `INSERT INTO run_events (id, run_id, thread_id, kind, label, label_done, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(event.id, event.runId, event.threadId, event.kind,
          event.label ?? null, event.labelDone ?? null, payloadJson,
          new Date().toISOString());
  }

  getRunEvents(runId: string): Array<{
    id: string; runId: string; threadId: string; kind: string;
    label: string | null; labelDone: string | null; payloadJson: string | null; createdAt: string;
  }> {
    return this._db.prepare(
      `SELECT id, run_id as runId, thread_id as threadId, kind, label, label_done as labelDone,
              payload_json as payloadJson, created_at as createdAt
       FROM run_events WHERE run_id = ? ORDER BY created_at ASC`
    ).all(runId) as Array<{
      id: string; runId: string; threadId: string; kind: string;
      label: string | null; labelDone: string | null; payloadJson: string | null; createdAt: string;
    }>;
  }

  getLatestRunEventsForThread(threadId: string, limit = 50): Array<{
    id: string; runId: string; threadId: string; kind: string;
    label: string | null; labelDone: string | null; payloadJson: string | null; createdAt: string;
  }> {
    return this._db.prepare(
      `SELECT re.id, re.run_id as runId, re.thread_id as threadId, re.kind, re.label,
              re.label_done as labelDone, re.payload_json as payloadJson, re.created_at as createdAt
       FROM run_events re
       JOIN cli_runs cr ON cr.id = re.run_id
       WHERE re.thread_id = ?
       ORDER BY re.created_at DESC
       LIMIT ?`
    ).all(threadId, limit) as Array<{
      id: string; runId: string; threadId: string; kind: string;
      label: string | null; labelDone: string | null; payloadJson: string | null; createdAt: string;
    }>;
  }

  cleanupOldRunEvents(daysToKeep = 7): number {
    const cutoff = new Date(Date.now() - daysToKeep * 86400000).toISOString();
    const result = this._db.prepare(
      `DELETE FROM run_events WHERE created_at < ?`
    ).run(cutoff);
    return result.changes;
  }

  // ============================================
  // Pending Context (Executor Handoff)
  // ============================================

  /**
   * Store pending context for next executor execution
   * Used when switching executors to pass conversation history
   */
  setPendingContext(lane: string, context: string, sourceExecutor?: string): void {
    this._db.prepare(
      `INSERT INTO pending_context (lane, context, source_executor)
       VALUES (?, ?, ?)
       ON CONFLICT(lane) DO UPDATE SET
         context = excluded.context,
         source_executor = excluded.source_executor,
         created_at = CURRENT_TIMESTAMP`
    ).run(lane, context, sourceExecutor ?? null);

    logger.debug({ lane, sourceExecutor }, "Stored pending context for handoff");
  }

  /**
   * Get pending context for a lane
   */
  getPendingContext(lane: string): { context: string; sourceExecutor: string | null } | null {
    const row = this._db.prepare(
      `SELECT context, source_executor as sourceExecutor
       FROM pending_context
       WHERE lane = ?`
    ).get(lane) as { context: string; sourceExecutor: string | null } | undefined;

    return row ?? null;
  }

  /**
   * Clear pending context after it has been used
   */
  clearPendingContext(lane: string): void {
    this._db.prepare("DELETE FROM pending_context WHERE lane = ?").run(lane);
    logger.debug({ lane }, "Cleared pending context");
  }

  /**
   * Get executor message count for double-history guard
   * Returns the current message count for the active executor on this lane
   */
  getExecutorMessageCount(lane: string): number {
    const state = this.getCurrentExecutor(lane);
    return state?.messageCount ?? 0;
  }

  // ============================================
  // Daily Log Archive (Raw → SQLite)
  // ============================================

  archiveDailyLog(date: string, rawContent: string): void {
    const incomingSize = Buffer.byteLength(rawContent, "utf-8");

    // Guard: refuse to overwrite a larger raw archive (prevents summary clobbering raw data on rerun)
    const existing = this.getDailyLogArchive(date);
    if (existing && existing.rawSizeBytes > incomingSize * 1.5) {
      logger.warn(
        { date, existingSize: existing.rawSizeBytes, incomingSize },
        "Refusing to overwrite larger raw archive — likely a rerun after stripping"
      );
      return;
    }

    this._db.prepare(
      `INSERT INTO daily_log_archive (date, raw_content, raw_size_bytes)
       VALUES (?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         raw_content = excluded.raw_content,
         raw_size_bytes = excluded.raw_size_bytes,
         archived_at = CURRENT_TIMESTAMP`
    ).run(date, rawContent, incomingSize);
  }

  markDailyLogStripped(date: string, summaryContent: string): void {
    this._db.prepare(
      `UPDATE daily_log_archive
       SET summary_content = ?, stripped_at = CURRENT_TIMESTAMP
       WHERE date = ?`
    ).run(summaryContent, date);
  }

  getDailyLogArchive(date: string): DailyLogArchive | null {
    const row = this._db.prepare(
      `SELECT date, raw_content as rawContent, raw_size_bytes as rawSizeBytes,
              summary_content as summaryContent, archived_at as archivedAt, stripped_at as strippedAt
       FROM daily_log_archive WHERE date = ?`
    ).get(date) as DailyLogArchive | undefined;
    return row ?? null;
  }

  isDailyLogArchived(date: string): boolean {
    const row = this._db.prepare(
      "SELECT 1 FROM daily_log_archive WHERE date = ?"
    ).get(date);
    return row !== undefined;
  }

  listDailyLogArchiveDates(): string[] {
    const rows = this._db.prepare(
      "SELECT date FROM daily_log_archive ORDER BY date DESC"
    ).all() as { date: string }[];
    return rows.map(r => r.date);
  }

  // ============================================
  // Session Transcripts (Full Archive)
  // ============================================

  hasSessionTranscript(contentHash: string): boolean {
    const row = this._db.prepare(
      "SELECT 1 FROM session_transcripts WHERE content_hash = ?"
    ).get(contentHash);
    return row !== undefined;
  }

  // NOTE: transcript rows are created exclusively by CLISessionImporter.storeFullTranscript()
  // (src/cli-sessions/importer.ts), which computes the transcript_hash needed for Cosmos
  // sync. A dormant insertSessionTranscript() helper was removed here to keep one correct
  // write path — any new transcript insert MUST go through the importer (or set transcript_hash).

  getSessionTranscript(contentHash: string): SessionTranscript | null {
    const row = this._db.prepare(
      `SELECT content_hash as contentHash, agent, session_id as sessionId,
              messages_json as messagesJson, native_file_path as nativeFilePath,
              model, project, started_at as startedAt, ended_at as endedAt,
              message_count as messageCount, uncompressed_size as uncompressedSize,
              created_at as createdAt
       FROM session_transcripts WHERE content_hash = ?`
    ).get(contentHash) as SessionTranscript | undefined;
    return row ?? null;
  }

  getSessionTranscriptsForDate(date: string): SessionTranscript[] {
    const nextDay = new Date(date + "T00:00:00");
    nextDay.setDate(nextDay.getDate() + 1);
    const nextDayStr = nextDay.toISOString().slice(0, 10);
    return this._db.prepare(
      `SELECT content_hash as contentHash, agent, session_id as sessionId,
              messages_json as messagesJson, native_file_path as nativeFilePath,
              model, project, started_at as startedAt, ended_at as endedAt,
              message_count as messageCount, uncompressed_size as uncompressedSize,
              created_at as createdAt
       FROM session_transcripts
       WHERE (started_at >= ? AND started_at < ?)
       ORDER BY started_at ASC`
    ).all(date, nextDayStr) as SessionTranscript[];
  }

  // Memory File Snapshots — removed in migration 072 (git handles version control)

  // ============================================
  // Backup Runs (Audit Trail)
  // ============================================

  recordBackupRun(run: {
    backupType: string;
    backupPath: string;
    dbSizeBytes: number;
    backupSizeBytes: number;
    checksum: string;
    integrityCheck: string;
    retentionTier: string;
  }): number {
    const result = this._db.prepare(
      `INSERT INTO backup_runs (backup_type, backup_path, db_size_bytes, backup_size_bytes, checksum, integrity_check, retention_tier)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      run.backupType, run.backupPath, run.dbSizeBytes, run.backupSizeBytes,
      run.checksum, run.integrityCheck, run.retentionTier
    );
    return result.lastInsertRowid as number;
  }

  getRecentBackupRuns(limit: number = 10): BackupRun[] {
    return this._db.prepare(
      `SELECT id, backup_type as backupType, backup_path as backupPath,
              db_size_bytes as dbSizeBytes, backup_size_bytes as backupSizeBytes,
              checksum, integrity_check as integrityCheck,
              retention_tier as retentionTier, created_at as createdAt
       FROM backup_runs ORDER BY created_at DESC LIMIT ?`
    ).all(limit) as BackupRun[];
  }

  // ============================================
  // Job Artifacts (Decision Trail)
  // ============================================

  insertJobArtifact(artifact: {
    jobRunId: number;
    jobName: string;
    stage: string;
    artifactType: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): number {
    const contentHash = createHash("sha256").update(artifact.content).digest("hex");
    const sizeBytes = Buffer.byteLength(artifact.content, "utf-8");
    const metadataJson = artifact.metadata ? JSON.stringify(artifact.metadata) : null;

    const result = this._db.prepare(
      `INSERT INTO job_artifacts (job_run_id, job_name, stage, artifact_type, content, content_hash, size_bytes, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      artifact.jobRunId, artifact.jobName, artifact.stage,
      artifact.artifactType, artifact.content, contentHash,
      sizeBytes, metadataJson
    );
    return result.lastInsertRowid as number;
  }

  getJobArtifacts(jobRunId: number): JobArtifact[] {
    return this._db.prepare(
      `SELECT id, job_run_id as jobRunId, job_name as jobName, stage,
              artifact_type as artifactType, content, content_hash as contentHash,
              size_bytes as sizeBytes, metadata_json as metadataJson,
              created_at as createdAt
       FROM job_artifacts WHERE job_run_id = ?
       ORDER BY id ASC`
    ).all(jobRunId) as JobArtifact[];
  }

  getRecentJobArtifactsByName(jobName: string, limit: number = 10): JobArtifact[] {
    return this._db.prepare(
      `SELECT id, job_run_id as jobRunId, job_name as jobName, stage,
              artifact_type as artifactType, content_hash as contentHash,
              size_bytes as sizeBytes, metadata_json as metadataJson,
              created_at as createdAt
       FROM job_artifacts WHERE job_name = ?
       ORDER BY created_at DESC LIMIT ?`
    ).all(jobName, limit) as JobArtifact[];
  }

  // ============================================
  // Session Summaries Lifecycle (Migration 039)
  // ============================================

  /**
   * Insert a pre-timeout flush checkpoint into session_summaries.
   * Sole caller: memory/flush.ts (captures session state before idle timeout kills it).
   * Agent-driven journaling was removed — live sessions are captured by session-harvester
   * reading the CLI jsonl transcripts directly.
   */
  insertFlushCheckpoint(title: string, summary: string, project?: string): string {
    const id = `flush_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    // Timestamp in hash is intentional: each flush is a unique checkpoint, so we
    // don't want dedup collapsing sequential flushes of the same session.
    const contentHash = createHash("sha256")
      .update(title + summary + now)
      .digest("hex");

    this._db.prepare(
      `INSERT INTO session_summaries (id, agent, started_at, project, title, summary, content_hash, created_at, status, processed_for_promotion, origin_device)
       VALUES (?, 'daemon', ?, ?, ?, ?, ?, ?, 'active', 0, 'mac-mini')`
    ).run(id, now, project ?? null, title, summary, contentHash, now);

    return id;
  }

  /**
   * Get oldest unprocessed sessions for nightly-memory promotion (queue-based).
   * No date filter — drains the backlog in order.
   */
  getUnprocessedSessionsBatch(limit: number = 50): SessionSummaryRow[] {
    return this._db.prepare(
      `SELECT id, agent, started_at as startedAt, ended_at as endedAt, model, project,
              title, message_count as messageCount, summary, is_sub_agent as isSubAgent,
              created_at as createdAt, status
       FROM session_summaries
       WHERE status = 'active'
         AND processed_for_promotion = 0
       ORDER BY COALESCE(started_at, created_at) ASC
       LIMIT ?`
    ).all(limit) as SessionSummaryRow[];
  }

  /**
   * Count of unprocessed sessions in the backlog.
   */
  getUnprocessedSessionCount(): number {
    const row = this._db.prepare(
      `SELECT COUNT(*) as cnt FROM session_summaries WHERE status = 'active' AND processed_for_promotion = 0`
    ).get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Hours since the oldest unprocessed session was created.
   * Returns 0 if no unprocessed sessions exist.
   */
  getOldestUnprocessedSessionAge(): number {
    const row = this._db.prepare(
      `SELECT MIN(COALESCE(started_at, created_at)) as oldest
       FROM session_summaries
       WHERE status = 'active' AND processed_for_promotion = 0`
    ).get() as { oldest: string | null };
    if (!row.oldest) return 0;
    const ageMs = Date.now() - new Date(row.oldest).getTime();
    return Math.round(ageMs / 3600000 * 10) / 10; // 1 decimal place
  }

  /**
   * @deprecated Use getUnprocessedSessionsBatch instead — date-window query orphans old rows.
   */
  getUnprocessedSessions(dateStart: string, dateEnd: string): SessionSummaryRow[] {
    return this._db.prepare(
      `SELECT id, agent, started_at as startedAt, ended_at as endedAt, model, project,
              title, message_count as messageCount, summary, is_sub_agent as isSubAgent,
              created_at as createdAt, status
       FROM session_summaries
       WHERE status = 'active'
         AND processed_for_promotion = 0
         AND COALESCE(started_at, created_at) >= ?
         AND COALESCE(started_at, created_at) < ?
       ORDER BY COALESCE(started_at, created_at) ASC`
    ).all(dateStart, dateEnd) as SessionSummaryRow[];
  }

  /**
   * Mark sessions as processed for promotion (after nightly-memory runs).
   */
  markSessionsProcessed(ids: string[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const result = this._db.prepare(
      `UPDATE session_summaries SET processed_for_promotion = 1 WHERE id IN (${placeholders})`
    ).run(...ids);
    return result.changes;
  }

  /**
   * Archive sessions (soft-delete with reason tracking).
   */
  archiveSessions(ids: string[], reason?: string): number {
    if (ids.length === 0) return 0;
    const now = new Date().toISOString();
    const placeholders = ids.map(() => "?").join(",");
    const result = this._db.prepare(
      `UPDATE session_summaries
       SET status = 'archived', archive_reason = ?, archived_at = ?
       WHERE id IN (${placeholders}) AND status = 'active'`
    ).run(reason ?? null, now, ...ids);
    return result.changes;
  }

  /**
   * Unarchive sessions (restore to active).
   */
  unarchiveSessions(ids: string[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const result = this._db.prepare(
      `UPDATE session_summaries
       SET status = 'active', archive_reason = NULL, archived_at = NULL
       WHERE id IN (${placeholders}) AND status = 'archived'`
    ).run(...ids);
    return result.changes;
  }

  /**
   * Get recent sessions from session_summaries for context building.
   * Used by shared-context, night/context, weekly-consolidation.
   */
  getRecentSessions(days: number, opts?: { activeOnly?: boolean; excludeSubAgents?: boolean }): SessionSummaryRow[] {
    const activeOnly = opts?.activeOnly ?? true;
    const excludeSubAgents = opts?.excludeSubAgents ?? false;

    let sql = `
      SELECT id, agent, started_at as startedAt, ended_at as endedAt, model, project,
             title, message_count as messageCount, summary, is_sub_agent as isSubAgent,
             created_at as createdAt, status
      FROM session_summaries
      WHERE COALESCE(started_at, created_at) >= date('now', ?)
    `;
    const params: (string | number)[] = [`-${days} days`];

    if (activeOnly) {
      sql += " AND status = 'active'";
    }
    if (excludeSubAgents) {
      sql += " AND is_sub_agent = 0";
    }

    sql += " ORDER BY COALESCE(started_at, created_at) ASC";

    return this._db.prepare(sql).all(...params) as SessionSummaryRow[];
  }

  // ============================================
  // Promoted Facts CAS Dedup (Migration 045)
  // ============================================

  /**
   * Normalize content for hashing: collapse whitespace, lowercase, trim.
   */
  private normalizeForHash(content: string): string {
    return content.replace(/\s+/g, " ").trim().toLowerCase();
  }

  /**
   * Compute a SHA-256 hash for dedup of promoted facts.
   * Section is included so the same content can be filed under different sections
   * (e.g., a preference relevant to both "Communication" and "Writing Style").
   */
  private factHash(content: string, targetFile: string, section?: string | null): string {
    return createHash("sha256")
      .update(this.normalizeForHash(content) + "::" + targetFile + "::" + (section ?? ""))
      .digest("hex");
  }

  /**
   * Check if a fact has already been promoted (by content hash).
   * Now backed by knowledge_claims instead of promoted_facts.
   */
  checkFactExists(content: string, targetFile: string, section?: string | null): boolean {
    const hash = this.factHash(content, targetFile, section);
    const row = this._db.prepare(
      "SELECT 1 FROM knowledge_claims WHERE content_hash = ? AND target_file = ? AND status = 'approved' LIMIT 1"
    ).get(hash, targetFile.replace(".md", ""));
    return row !== undefined;
  }

  /**
   * Record a promoted fact for dedup tracking.
   * Now inserts into knowledge_claims with status='approved'.
   */
  recordPromotedFact(
    content: string,
    targetFile: string,
    section: string | null,
    source: "nightly" | "weekly" | "mcp" | "unknown"
  ): void {
    const hash = this.factHash(content, targetFile, section);
    const normalizedFile = targetFile.replace(".md", "");
    const existing = this._db.prepare(
      "SELECT 1 FROM knowledge_claims WHERE content_hash = ? AND target_file = ? AND status NOT IN ('rejected', 'archived', 'expired') LIMIT 1"
    ).get(hash, normalizedFile);
    if (existing) return; // already exists

    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 10);
    const id = `kc_${ts}_${rand}`;
    this._db.prepare(
      `INSERT INTO knowledge_claims (id, content, content_hash, target_file, section, claim_type, confidence, status, decided_at, decided_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'fact', 1.0, 'approved', datetime('now'), ?, datetime('now'))`
    ).run(id, content, hash, normalizedFile, section, source);
  }

  /**
   * Get recently promoted facts (for context-bridge).
   * Now reads from knowledge_claims instead of promoted_facts.
   */
  getRecentPromotedFacts(days: number = 7): Array<{ content: string; targetFile: string; section: string | null; promotedAt: string; source: string }> {
    return this._db.prepare(
      `SELECT content, target_file as targetFile, section, created_at as promotedAt, COALESCE(decided_by, 'unknown') as source
       FROM knowledge_claims
       WHERE status = 'approved' AND created_at >= datetime('now', ?)
       ORDER BY created_at DESC`
    ).all(`-${days} days`) as Array<{ content: string; targetFile: string; section: string | null; promotedAt: string; source: string }>;
  }

  // ============================================
  // CLI Harvest Watermarks (Migration 046)
  // ============================================

  /**
   * Get the last scan epoch (ms) for a CLI agent.
   * Returns null if no watermark exists (first run).
   */
  getHarvestWatermark(agent: string): number | null {
    const row = this._db.prepare(
      "SELECT last_scan_epoch_ms FROM cli_harvest_watermark WHERE agent = ?"
    ).get(agent) as { last_scan_epoch_ms: number } | undefined;
    return row?.last_scan_epoch_ms ?? null;
  }

  /**
   * Set the harvest watermark for a CLI agent. INSERT ON CONFLICT UPDATE.
   */
  setHarvestWatermark(agent: string, epochMs: number): void {
    this._db.prepare(
      `INSERT INTO cli_harvest_watermark (agent, last_scan_epoch_ms)
       VALUES (?, ?)
       ON CONFLICT(agent) DO UPDATE SET
         last_scan_epoch_ms = excluded.last_scan_epoch_ms,
         last_scan_at = datetime('now')`
    ).run(agent, epochMs);
  }

  // --- Telegram replyable message registry (for reply-as-quote context) ---

  recordTelegramMessage(row: {
    chatId: number;
    telegramMessageId: number;
    lane: string;
    role: "assistant" | "system" | "prompt";
    messageKind: "conversation";
    threadId?: string | null;
    threadMessageId?: string | null;
    runId?: string | null;
    sessionId?: string | null;
    messageText: string;
    ttlMs?: number;
  }): void {
    if (!this._db || !this.isOpen) return;
    const now = Date.now();
    const ttl = row.ttlMs ?? 30 * 24 * 60 * 60 * 1000; // 30 days
    try {
      this._db.prepare(
        `INSERT OR REPLACE INTO telegram_messages
           (chat_id, telegram_message_id, lane, role, message_kind,
            thread_id, thread_message_id, run_id, session_id,
            message_text, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.chatId,
        row.telegramMessageId,
        row.lane,
        row.role,
        row.messageKind,
        row.threadId ?? null,
        row.threadMessageId ?? null,
        row.runId ?? null,
        row.sessionId ?? null,
        row.messageText,
        now,
        now + ttl,
      );
    } catch (err) {
      logger.warn({ err, chatId: row.chatId, telegramMessageId: row.telegramMessageId }, "recordTelegramMessage failed");
    }
  }

  getTelegramMessage(chatId: number, telegramMessageId: number): TelegramMessageRecord | null {
    if (!this._db || !this.isOpen) return null;
    const row = this._db.prepare(
      `SELECT chat_id as chatId, telegram_message_id as telegramMessageId, lane,
              role, message_kind as messageKind, thread_id as threadId,
              thread_message_id as threadMessageId,
              run_id as runId, session_id as sessionId,
              message_text as messageText, created_at as createdAt,
              expires_at as expiresAt
         FROM telegram_messages
         WHERE chat_id = ? AND telegram_message_id = ?`
    ).get(chatId, telegramMessageId) as TelegramMessageRecord | undefined;
    if (!row) return null;
    if (row.expiresAt && row.expiresAt < Date.now()) return null;
    return row;
  }

  deleteExpiredTelegramMessages(): number {
    if (!this._db || !this.isOpen) return 0;
    const res = this._db.prepare(
      `DELETE FROM telegram_messages WHERE expires_at IS NOT NULL AND expires_at < ?`
    ).run(Date.now());
    return res.changes ?? 0;
  }
}

export interface TelegramMessageRecord {
  chatId: number;
  telegramMessageId: number;
  lane: string;
  role: "assistant" | "system" | "prompt";
  messageKind: "conversation";
  threadId: string | null;
  threadMessageId: string | null;
  runId: string | null;
  sessionId: string | null;
  messageText: string;
  createdAt: number;
  expiresAt: number | null;
}

// Session summary row (from session_summaries table)
export interface SessionSummaryRow {
  id: string;
  agent: string;
  startedAt: string | null;
  endedAt: string | null;
  model: string | null;
  project: string | null;
  title: string | null;
  messageCount: number;
  summary: string;
  isSubAgent: number;
  createdAt: string;
  status: string;
}

// Executor state types
export type ExecutorStateType = "claude" | "gemini" | "codex" | "kimi" | "chatgpt" | "opencode";

export interface ExecutorState {
  lane: string;
  executor: ExecutorStateType;
  model: string | null;
  sessionId: string | null;
  switchedAt: number;
  messageCount: number;
}

interface ExecutorStateRow {
  lane: string;
  executor: string;
  model: string | null;
  sessionId?: string | null;
  switchedAt: number;
  messageCount: number;
}

export interface ScheduledJobState {
  jobId: string;
  sourceFile: string;
  enabled: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  consecutiveFailures: number;
  updatedAt: string;
}

export type CLIRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface CLIRunRecord {
  id: string;
  lane: string;
  executor: string;
  threadId: string | null;
  status: CLIRunStatus;
  startedAt: number;
  completedAt: number | null;
  exitCode: number | null;
  output: string | null;
  error: string | null;
  streamText: string | null;
  streamPhase: string | null;
  streamSeq: number;
  streamUpdatedAt: number | null;
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

// Web UI types
export interface ChatSession {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface Thread {
  id: string;
  chatSessionId: string;
  title: string | null;
  provider: string;
  model: string | null;
  status: string;
  externalSessionId: string | null;
  parentThreadId: string | null;
  branchPointMessageId: string | null;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface ThreadLink {
  threadId: string;
  linkType: string;
  linkId: string;
  createdAt: string;
}

export interface DailyLogArchive {
  date: string;
  rawContent: string;
  rawSizeBytes: number;
  summaryContent: string | null;
  archivedAt: string;
  strippedAt: string | null;
}

export interface SessionTranscript {
  contentHash: string;
  agent: string;
  sessionId: string;
  messagesJson: string;
  nativeFilePath: string | null;
  model: string | null;
  project: string | null;
  startedAt: string | null;
  endedAt: string | null;
  messageCount: number;
  uncompressedSize: number;
  createdAt: string;
}

export interface BackupRun {
  id: number;
  backupType: string;
  backupPath: string;
  dbSizeBytes: number;
  backupSizeBytes: number;
  checksum: string;
  integrityCheck: string;
  retentionTier: string;
  createdAt: string;
}

export interface JobArtifact {
  id: number;
  jobRunId: number;
  jobName: string;
  stage: string;
  artifactType: string;
  content?: string;
  contentHash: string;
  sizeBytes: number;
  metadataJson: string | null;
  createdAt: string;
}
