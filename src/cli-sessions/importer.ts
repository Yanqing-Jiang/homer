import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { logger } from "../utils/logger.js";
import type { ParsedSession } from "./parsers.js";
import {
  parseCodexSession,
  parseClaudeSession,
  parseOpencodeSession,
  scanCodexSessions,
  scanClaudeSessions,
  scanOpencodeSessions,
  scanThreadSessions,
} from "./parsers.js";
import { statSync } from "fs";
import { summarizeSession, generateTitle, buildRawExcerpt, getLogDate } from "./summarizer.js";

export type AgentType = "codex" | "gemini" | "claude" | "opencode" | "telegram" | "web" | "all";

interface ImportOptions {
  sinceDays?: number;
  agent?: AgentType;
  dryRun?: boolean;
  /** Per-agent cutoff epoch (ms). Overrides sinceDays for agents that have a watermark. */
  cutoffPerAgent?: Record<string, number>;
  /** AbortSignal from the scheduler watchdog — aborts mid-batch processing when timed out. */
  signal?: AbortSignal;
}

interface ImportStats {
  scanned: number;
  imported: number;
  skipped: number;
  subAgents: number;
  errors: number;
}

// Prompt patterns that indicate a sub-agent session
const SUB_AGENT_PATTERNS = [
  "OUTPUT INSTRUCTIONS:",
  "RESEARCH_ONLY_PREFIX",
  "Context:\n",
  "Write full analysis/results to:",
  "Return ONLY a brief summary",
];

/**
 * Detect if a session is a sub-agent (spawned by scheduler/swarm, not interactive)
 */
function isSubAgent(session: ParsedSession, db: Database.Database): boolean {
  // 1. Working directory: /tmp or /private/tmp indicates sub-agent
  if (session.project) {
    const p = session.project.toLowerCase();
    if (p === "/tmp" || p.startsWith("/tmp/") || p === "/private/tmp" || p.startsWith("/private/tmp/")) {
      return true;
    }
  }

  // 2. Cross-ref with scheduled_job_runs: session started within 60s of a job run
  if (session.startedAt) {
    try {
      const sessionStart = new Date(session.startedAt).toISOString();
      const match = db.prepare(`
        SELECT 1 FROM scheduled_job_runs
        WHERE datetime(started_at) BETWEEN datetime(?, '-60 seconds') AND datetime(?, '+60 seconds')
        LIMIT 1
      `).get(sessionStart, sessionStart);
      if (match) return true;
    } catch {
      // Table might not exist in edge cases
    }
  }

  // 3. Prompt patterns in first user message
  const firstUser = session.messages.find((m) => m.role === "user");
  if (firstUser) {
    for (const pattern of SUB_AGENT_PATTERNS) {
      if (firstUser.content.includes(pattern)) {
        return true;
      }
    }
  }

  // 4. Thread-specific: skip threads where user never sent a message (pure bot notifications)
  if (session.agent === "telegram" || session.agent === "web") {
    const hasUserMessage = session.messages.some((m) => m.role === "user");
    if (!hasUserMessage) return true;
  }

  return false;
}

/**
 * Import CLI sessions directly into session_summaries SQLite table
 */
export class CLISessionImporter {
  private db: Database.Database;
  private homeDir: string;

  constructor(db: Database.Database, homeDir: string) {
    this.db = db;
    this.homeDir = homeDir;
  }

  /**
   * Import sessions from all or specific CLI
   */
  async import(options: ImportOptions = {}): Promise<ImportStats> {
    const { sinceDays = 7, agent = "all", dryRun = false, cutoffPerAgent, signal } = options;

    const stats: ImportStats = {
      scanned: 0,
      imported: 0,
      skipped: 0,
      subAgents: 0,
      errors: 0,
    };

    logger.info({ sinceDays, agent, dryRun, hasCutoffs: !!cutoffPerAgent }, "Starting CLI session import");

    // Scan for session files
    const sessionFiles: Array<{ agent: string; path: string }> = [];

    if (agent === "all" || agent === "codex") {
      const codexFiles = scanCodexSessions(this.homeDir, sinceDays, cutoffPerAgent?.codex);
      sessionFiles.push(...codexFiles.map((path) => ({ agent: "codex", path })));
    }

    if (agent === "all" || agent === "claude") {
      const claudeFiles = scanClaudeSessions(this.homeDir, sinceDays, cutoffPerAgent?.claude);
      sessionFiles.push(...claudeFiles.map((path) => ({ agent: "claude", path })));
    }

    if (agent === "all" || agent === "opencode") {
      const opencodeFiles = scanOpencodeSessions(this.homeDir, sinceDays, cutoffPerAgent?.opencode);
      sessionFiles.push(...opencodeFiles.map((path) => ({ agent: "opencode", path })));
    }

    // Scan thread sessions (Telegram + Web UI) — these come pre-parsed, not as files
    let threadSessions: ParsedSession[] = [];
    if (agent === "all" || agent === "telegram" || agent === "web") {
      threadSessions = scanThreadSessions(this.db, sinceDays);
      if (agent === "telegram") {
        threadSessions = threadSessions.filter((s) => s.agent === "telegram");
      } else if (agent === "web") {
        threadSessions = threadSessions.filter((s) => s.agent === "web");
      }
    }

    stats.scanned = sessionFiles.length + threadSessions.length;
    logger.info({ fileCount: sessionFiles.length, threadCount: threadSessions.length }, "Found sessions to process");

    // Process each session file
    for (const { agent: sessionAgent, path } of sessionFiles) {
      if (signal?.aborted) {
        logger.info("Session import aborted by signal (file loop)");
        break;
      }
      try {
        // Parse session
        let session: ParsedSession | null = null;

        if (sessionAgent === "codex") {
          session = parseCodexSession(path);
        } else if (sessionAgent === "claude") {
          session = parseClaudeSession(path);
        } else if (sessionAgent === "opencode") {
          session = parseOpencodeSession(path);
        }

        if (!session) {
          stats.errors++;
          logger.warn({ path }, "Failed to parse session");
          continue;
        }

        // Check if already imported (dedup via content_hash)
        if (this.isAlreadyImported(session.contentHash)) {
          stats.skipped++;
          logger.debug({ sessionId: session.sessionId }, "Session already imported (duplicate)");
          continue;
        }

        // Check if sub-agent
        const subAgent = isSubAgent(session, this.db);
        if (subAgent) {
          stats.subAgents++;

          if (!dryRun) {
            // Record in cli_session_index with status='skipped'
            this.recordSkipped(session);
          }

          logger.debug({ sessionId: session.sessionId, agent: session.agent }, "Skipped sub-agent session");
          continue;
        }

        // Dry run - just count
        if (dryRun) {
          stats.imported++;
          logger.info({ sessionId: session.sessionId, agent: session.agent, messages: session.messageCount }, "Would import session");
          continue;
        }

        // Import session: summarize → INSERT session_summaries → record in cli_session_index
        await this.importSession(session, signal);
        stats.imported++;

        logger.info(
          {
            sessionId: session.sessionId,
            agent: session.agent,
            messages: session.messageCount,
          },
          "Imported session to session_summaries"
        );
      } catch (error) {
        stats.errors++;
        logger.error({ error, path }, "Error processing session");
      }
    }

    // Process thread sessions (Telegram + Web UI) — already parsed
    for (const session of threadSessions) {
      if (signal?.aborted) {
        logger.info("Session import aborted by signal (thread loop)");
        break;
      }
      try {
        // Dedup via content hash
        if (this.isAlreadyImported(session.contentHash)) {
          stats.skipped++;
          logger.debug({ sessionId: session.sessionId }, "Thread session already imported (duplicate)");
          continue;
        }

        // Sub-agent check (cross-ref with scheduled_job_runs, skip bot-only threads)
        const subAgent = isSubAgent(session, this.db);
        if (subAgent) {
          stats.subAgents++;
          if (!dryRun) this.recordSkipped(session);
          continue;
        }

        if (dryRun) {
          stats.imported++;
          logger.info({ sessionId: session.sessionId, agent: session.agent, messages: session.messageCount }, "Would import thread session");
          continue;
        }

        // Import: summarize → INSERT session_summaries
        await this.importSession(session, signal);
        stats.imported++;

        // Update watermark for this thread
        const threadMeta = session as ParsedSession & { _lastMsgId?: string; _threadId?: string; _newCount?: number };
        if (threadMeta._threadId && threadMeta._lastMsgId) {
          this.updateThreadWatermark(
            threadMeta._threadId,
            threadMeta._lastMsgId,
            threadMeta._newCount || session.messageCount
          );
        }

        logger.info(
          { sessionId: session.sessionId, agent: session.agent, messages: session.messageCount },
          "Imported thread session to session_summaries"
        );
      } catch (error) {
        stats.errors++;
        logger.error({ error, sessionId: session.sessionId }, "Error processing thread session");
      }
    }

    logger.info(stats, "Session import completed");
    return stats;
  }

  /**
   * Check if session already imported using content hash
   */
  private isAlreadyImported(contentHash: string): boolean {
    // Check both tables
    const inIndex = this.db
      .prepare("SELECT 1 FROM cli_session_index WHERE content_hash = ?")
      .get(contentHash);
    if (inIndex) return true;

    const inSummaries = this.db
      .prepare("SELECT 1 FROM session_summaries WHERE content_hash = ?")
      .get(contentHash);
    return inSummaries !== undefined;
  }

  /**
   * Record a skipped sub-agent session
   */
  private recordSkipped(session: ParsedSession): void {
    const id = randomUUID();
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO cli_session_index (
            id, agent, native_session_id, native_file_path,
            started_at, ended_at, imported_at,
            content_hash, log_date, message_count, token_estimate,
            status, is_sub_agent, project, title, model
          ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, 'skipped', 1, ?, ?, ?)`
        )
        .run(
          id,
          session.agent,
          session.sessionId,
          session.nativeFilePath,
          session.startedAt || null,
          session.endedAt || null,
          session.contentHash,
          getLogDate(session),
          session.messageCount,
          session.tokenEstimate || null,
          session.project || "",
          generateTitle(session),
          session.model || null
        );
    } catch (error) {
      logger.warn({ error, sessionId: session.sessionId }, "Failed to record skipped session");
    }
  }

  /**
   * Import a single session: summarize → INSERT session_summaries → record in cli_session_index → archive transcript
   */
  private async importSession(session: ParsedSession, signal?: AbortSignal): Promise<void> {
    const id = randomUUID();
    const logDate = getLogDate(session);
    const title = generateTitle(session);
    const rawExcerpt = buildRawExcerpt(session);

    // Smart summarization (template for small, Gemini for larger)
    const summary = await summarizeSession(session, signal);

    // INSERT into session_summaries (FTS5 auto-syncs via trigger)
    this.db
      .prepare(
        `INSERT INTO session_summaries (
          id, agent, native_session_id, started_at, ended_at,
          model, project, title, message_count, summary,
          raw_excerpt, is_sub_agent, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .run(
        id,
        session.agent,
        session.sessionId,
        session.startedAt || null,
        session.endedAt || null,
        session.model || null,
        session.project || null,
        title,
        session.messageCount,
        summary,
        rawExcerpt,
        session.contentHash
      );

    // Record in cli_session_index for dedup tracking
    this.db
      .prepare(
        `INSERT OR IGNORE INTO cli_session_index (
          id, agent, native_session_id, native_file_path,
          started_at, ended_at, imported_at,
          content_hash, log_date, message_count, token_estimate,
          status, is_sub_agent, project, title, model
        ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, 'imported', 0, ?, ?, ?)`
      )
      .run(
        id,
        session.agent,
        session.sessionId,
        session.nativeFilePath,
        session.startedAt || null,
        session.endedAt || null,
        session.contentHash,
        logDate,
        session.messageCount,
        session.tokenEstimate || null,
        session.project || "",
        title,
        session.model || null
      );

    // Archive full transcript to session_transcripts (Phase 2)
    this.storeFullTranscript(session);
  }

  /**
   * Store full session transcript (archive fidelity) in session_transcripts table.
   * For Claude sessions, re-parses with archiveFidelity=true to get untruncated messages.
   * For other agents, uses the already-full messages.
   */
  private storeFullTranscript(session: ParsedSession): void {
    try {
      // Check if transcript table exists and transcript not already stored
      const hasTable = this.db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_transcripts'"
      ).get();
      if (!hasTable) return;

      const existing = this.db.prepare(
        "SELECT 1 FROM session_transcripts WHERE content_hash = ?"
      ).get(session.contentHash);
      if (existing) return;

      // For Claude sessions, re-parse with archiveFidelity to get full messages
      let fullMessages = session.messages;
      if (session.agent === "claude" && session.nativeFilePath && !session.nativeFilePath.startsWith("thread:")) {
        const fullSession = parseClaudeSession(session.nativeFilePath, { archiveFidelity: true });
        if (fullSession) {
          fullMessages = fullSession.messages;
        }
      }

      const messagesJson = JSON.stringify(fullMessages);
      let sourceMtimeMs: number | undefined;
      try {
        if (session.nativeFilePath && !session.nativeFilePath.startsWith("thread:")) {
          sourceMtimeMs = statSync(session.nativeFilePath).mtimeMs;
        }
      } catch { /* file might not exist for thread sessions */ }

      this.db.prepare(
        `INSERT INTO session_transcripts (
          content_hash, agent, session_id, messages_json, native_file_path,
          source_mtime_ms, model, project, started_at, ended_at,
          message_count, uncompressed_size
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(content_hash) DO NOTHING`
      ).run(
        session.contentHash,
        session.agent,
        session.sessionId,
        messagesJson,
        session.nativeFilePath ?? null,
        sourceMtimeMs ?? null,
        session.model ?? null,
        session.project ?? null,
        session.startedAt ?? null,
        session.endedAt ?? null,
        fullMessages.length,
        Buffer.byteLength(messagesJson, "utf-8")
      );

      logger.debug(
        { sessionId: session.sessionId, agent: session.agent, messages: fullMessages.length },
        "Stored full transcript in session_transcripts"
      );
    } catch (error) {
      logger.warn({ error, sessionId: session.sessionId }, "Failed to store full transcript");
    }
  }

  /**
   * Update thread import watermark after successful import
   */
  private updateThreadWatermark(threadId: string, lastMsgId: string, newCount: number): void {
    try {
      this.db.prepare(`
        INSERT INTO thread_import_watermark (thread_id, last_imported_message_id, last_imported_at, total_imported)
        VALUES (?, ?, datetime('now'), ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          last_imported_message_id = excluded.last_imported_message_id,
          last_imported_at = excluded.last_imported_at,
          total_imported = total_imported + excluded.total_imported
      `).run(threadId, lastMsgId, newCount);
    } catch (error) {
      logger.warn({ error, threadId }, "Failed to update thread watermark");
    }
  }

  /**
   * Get import statistics
   */
  getStats(): {
    totalImported: number;
    totalSubAgents: number;
    byAgent: Record<string, number>;
    recentImports: Array<{ agent: string; logDate: string; messageCount: number }>;
  } {
    const total = this.db
      .prepare("SELECT COUNT(*) as count FROM cli_session_index WHERE status = 'imported'")
      .get() as { count: number };

    const totalSub = this.db
      .prepare("SELECT COUNT(*) as count FROM cli_session_index WHERE is_sub_agent = 1")
      .get() as { count: number };

    const byAgent = this.db
      .prepare(
        "SELECT agent, COUNT(*) as count FROM cli_session_index WHERE status = 'imported' GROUP BY agent"
      )
      .all() as Array<{ agent: string; count: number }>;

    const recent = this.db
      .prepare(
        `SELECT agent, log_date as logDate, message_count as messageCount
         FROM cli_session_index
         WHERE status = 'imported'
         ORDER BY imported_at DESC
         LIMIT 10`
      )
      .all() as Array<{ agent: string; logDate: string; messageCount: number }>;

    const byAgentMap: Record<string, number> = {};
    for (const row of byAgent) {
      byAgentMap[row.agent] = row.count;
    }

    return {
      totalImported: total.count,
      totalSubAgents: totalSub.count,
      byAgent: byAgentMap,
      recentImports: recent,
    };
  }
}
