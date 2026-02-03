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
  private _db: Database.Database;
  private ttlMs: number;

  constructor(dbPath: string) {
    this._db = new Database(dbPath);
    this.ttlMs = config.session.ttlHours * 60 * 60 * 1000;
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

  close(): void {
    this._db.close();
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

  // Scheduled job methods
  recordScheduledJobStart(jobId: string, jobName: string, sourceFile: string): number | null {
    const now = new Date().toISOString();

    // Check if job is already running (locking check)
    const runningCheck = this._db.prepare('SELECT is_running FROM scheduled_job_state WHERE job_id = ?')
      .get(jobId) as { is_running: number } | undefined;

    if (runningCheck && runningCheck.is_running === 1) {
      logger.warn({ jobId }, "Job already running, skipping this trigger");
      return null;
    }

    // Create run record
    const result = this._db.prepare(
        `INSERT INTO scheduled_job_runs (job_id, job_name, source_file, started_at, success)
         VALUES (?, ?, ?, ?, 0)`
      )
      .run(jobId, jobName, sourceFile, now);

    const runId = result.lastInsertRowid as number;

    // Update or create job state and set is_running flag
    this._db.prepare(
        `INSERT INTO scheduled_job_state (job_id, source_file, last_run_at, is_running, updated_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           last_run_at = excluded.last_run_at,
           is_running = 1,
           updated_at = excluded.updated_at`
      )
      .run(jobId, sourceFile, now, now);

    return runId;
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

  getScheduledJobState(jobId: string): ScheduledJobState | null {
    return this._db.prepare(
        `SELECT job_id as jobId, source_file as sourceFile, enabled,
                last_run_at as lastRunAt, last_success_at as lastSuccessAt,
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
                consecutive_failures as consecutiveFailures, updated_at as updatedAt
         FROM scheduled_job_state
         ORDER BY updated_at DESC`
      )
      .all() as ScheduledJobState[];
  }

  cleanupOldScheduledJobRuns(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): number {
    const cutoffDate = new Date(Date.now() - maxAgeMs).toISOString();
    const result = this._db.prepare(`DELETE FROM scheduled_job_runs WHERE completed_at < ?`)
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
         ORDER BY created_at DESC`
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

    // Update thread + session timestamps
    this._db.prepare(`UPDATE threads SET last_message_at = ? WHERE id = ?`).run(now, message.threadId);
    this._db.prepare(
        `UPDATE chat_sessions SET updated_at = ?
         WHERE id = (SELECT chat_session_id FROM threads WHERE id = ?)`
      )
      .run(now, message.threadId);

    return {
      id: message.id,
      threadId: message.threadId,
      role: message.role,
      content: message.content,
      metadata: message.metadata ?? null,
      createdAt: now,
    };
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
  // Executor State (Persistent Switching)
  // ============================================

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
    this._db.prepare(
      `INSERT INTO executor_state (lane, executor, model, session_id, switched_at, message_count)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT(lane) DO UPDATE SET
         executor = excluded.executor,
         model = excluded.model,
         session_id = excluded.session_id,
         switched_at = excluded.switched_at,
         message_count = 0`
    ).run(lane, executor, model ?? null, sessionId ?? null, now);

    logger.debug({ lane, executor, model, sessionId }, "Set executor state");
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
  setExecutorSessionId(lane: string, sessionId: string | null): void {
    this._db.prepare(
      `UPDATE executor_state SET session_id = ? WHERE lane = ?`
    ).run(sessionId, lane);
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
  }): void {
    this._db.prepare(
      `UPDATE cli_runs
       SET status = ?, completed_at = ?, exit_code = ?, output = ?, error = ?
       WHERE id = ?`
    ).run(
      updates.status,
      updates.completedAt,
      updates.exitCode ?? null,
      updates.output ?? null,
      updates.error ?? null,
      runId
    );
  }

  getCliRun(runId: string): CLIRunRecord | null {
    const row = this._db.prepare(
      `SELECT id, lane, executor, thread_id as threadId, status,
              started_at as startedAt, completed_at as completedAt,
              exit_code as exitCode, output, error
       FROM cli_runs WHERE id = ?`
    ).get(runId) as CLIRunRecord | undefined;
    return row ?? null;
  }

  getActiveCliRunForLane(lane: string): CLIRunRecord | null {
    const row = this._db.prepare(
      `SELECT id, lane, executor, thread_id as threadId, status,
              started_at as startedAt, completed_at as completedAt,
              exit_code as exitCode, output, error
       FROM cli_runs
       WHERE lane = ? AND status = 'running'
       ORDER BY started_at DESC
       LIMIT 1`
    ).get(lane) as CLIRunRecord | undefined;
    return row ?? null;
  }
}

// Executor state types
export type ExecutorStateType = "claude" | "gemini" | "codex";

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
