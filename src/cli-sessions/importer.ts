// @ts-ignore
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
  stripSessionScaffolding,
} from "./parsers.js";
import { statSync } from "fs";
import { createHash } from "crypto";
import { basename } from "path";
import { summarizeSession, generateTitle, buildRawExcerpt, getLogDate } from "./summarizer.js";

export type AgentType = "codex" | "gemini" | "claude" | "opencode" | "telegram" | "web" | "all";

interface ImportOptions {
  sinceDays?: number;
  agent?: AgentType;
  dryRun?: boolean;
  scanStartMs?: number;
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
  parseErrors: number;
  errors: number;
  aborted: boolean;
}

// Prompt patterns that indicate a sub-agent session.
// "Context:\n" was removed 2026-07-08: it false-positived on real plan-mode
// sessions ("Implement the following plan: ... Context:") — silent data loss.
const SUB_AGENT_PATTERNS = [
  "OUTPUT INSTRUCTIONS",
  "RESEARCH_ONLY_PREFIX",
  "Write full analysis/results to:",
  "Return ONLY a brief summary",
];

export const ACTIVE_SESSION_WINDOW_MS = 30 * 60 * 1000;

const SCHEDULER_HEURISTIC_EXCLUDED_JOB_IDS = new Set([
  "reminder-check",
  "reminder_check",
  "session-maintenance",
  "session_maintenance",
  "daemon-cleanup",
  "daemon_cleanup",
]);

function hasTempProject(session: ParsedSession): boolean {
  if (!session.project) {
    return false;
  }
  const p = session.project.toLowerCase();
  return p === "/tmp" || p.startsWith("/tmp/") || p === "/private/tmp" || p.startsWith("/private/tmp/");
}

function hasSubAgentPrompt(session: ParsedSession): boolean {
  // Codex prepends scaffolding "user" messages (<permissions instructions>,
  // AGENTS.md) before the real prompt — match against the first substantive one.
  const firstUser = session.messages.find(
    (m) => m.role === "user" && stripSessionScaffolding(m.content)
  );
  if (!firstUser) {
    return false;
  }
  return SUB_AGENT_PATTERNS.some((pattern) => firstUser.content.includes(pattern));
}

function isBotOnlyThread(session: ParsedSession): boolean {
  if (session.agent !== "telegram" && session.agent !== "web") {
    return false;
  }
  return !session.messages.some((m) => m.role === "user");
}

function findNearbySchedulerJob(session: ParsedSession, db: Database.Database): string | null {
  if (!session.startedAt) {
    return null;
  }

  try {
    const sessionStart = new Date(session.startedAt).toISOString();
    const rows = db.prepare(`
      SELECT job_id as jobId
      FROM scheduled_job_runs
      WHERE datetime(started_at) BETWEEN datetime(?, '-60 seconds') AND datetime(?, '+60 seconds')
      ORDER BY ABS(strftime('%s', started_at) - strftime('%s', ?)) ASC
      LIMIT 5
    `).all(sessionStart, sessionStart, sessionStart) as Array<{ jobId: string }>;

    const row = rows.find((candidate) => !SCHEDULER_HEURISTIC_EXCLUDED_JOB_IDS.has(candidate.jobId));
    return row?.jobId ?? null;
  } catch {
    // Table might not exist in edge cases.
    return null;
  }
}

/**
 * Detect if a session is a sub-agent (spawned by scheduler/swarm, not interactive)
 */
function isSubAgent(session: ParsedSession, db: Database.Database): boolean {
  // Structural signal: `codex exec` one-shot runs (rollout session_meta
  // source="exec") are always daemon/sub-agent dispatches on this machine —
  // interactive codex (TUI/desktop) reports a different source.
  if (session.agent === "codex" && session.sourceHint === "exec") {
    return true;
  }

  // Strong signals: temp project, known sub-agent prompt wrapper, or bot-only thread.
  if (hasTempProject(session) || hasSubAgentPrompt(session) || isBotOnlyThread(session)) {
    return true;
  }

  // Weak signal only: a nearby scheduled job is not enough to skip a session.
  // Minute-cadence internal jobs make the old +/-60s heuristic classify almost
  // every human CLI session as a sub-agent.
  const nearbySchedulerJob = findNearbySchedulerJob(session, db);
  if (nearbySchedulerJob) {
    logger.debug(
      { sessionId: session.sessionId, agent: session.agent, nearbySchedulerJob },
      "Ignoring scheduler-only sub-agent signal"
    );
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
    const scanStartMs = options.scanStartMs ?? Date.now();

    const stats: ImportStats = {
      scanned: 0,
      imported: 0,
      skipped: 0,
      subAgents: 0,
      parseErrors: 0,
      errors: 0,
      aborted: false,
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
        stats.aborted = true;
        logger.info("Session import aborted by signal (file loop)");
        break;
      }
      try {
        const statsForFile = statSync(path);
        if (statsForFile.mtimeMs >= scanStartMs - ACTIVE_SESSION_WINDOW_MS) {
          stats.skipped++;
          logger.debug({ path, mtimeMs: statsForFile.mtimeMs }, "Skipping still-active session file");
          continue;
        }

        // Parse session
        let session: ParsedSession | null = null;

        if (sessionAgent === "codex") {
          session = parseCodexSession(path);
        } else if (sessionAgent === "claude") {
          session = parseClaudeSession(path, { archiveFidelity: true });
        } else if (sessionAgent === "opencode") {
          session = parseOpencodeSession(path);
        }

        if (!session) {
          stats.parseErrors++;
          if (!dryRun) {
            this.recordParseError(sessionAgent, path);
          }
          logger.warn({ path }, "Failed to parse session; quarantined as parse-error");
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
        const imported = await this.importSession(session, signal);
        if (imported) {
          stats.imported++;
        } else {
          stats.skipped++;
          logger.debug({ sessionId: session.sessionId }, "Session skipped during import");
          continue;
        }

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
        stats.aborted = true;
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
        const imported = await this.importSession(session, signal);
        if (imported) {
          stats.imported++;
        } else {
          stats.skipped++;
          continue;
        }

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
      .prepare("SELECT 1 FROM cli_session_index WHERE content_hash = ? AND status IN ('imported', 'processed')")
      .get(contentHash);
    if (inIndex) return true;

    const inSummaries = this.db
      .prepare("SELECT 1 FROM session_summaries WHERE content_hash = ?")
      .get(contentHash);
    return inSummaries !== undefined;
  }

  /**
   * Record an unparsable session file without treating it as imported.
   * Parse-error quarantine lets the harvester watermark advance while keeping
   * the bad source visible for later inspection/backfill.
   */
  private recordParseError(agent: string, filePath: string): void {
    try {
      let size = 0;
      let mtimeMs = Date.now();
      try {
        const stats = statSync(filePath);
        size = stats.size;
        mtimeMs = stats.mtimeMs;
      } catch { /* source file may have disappeared between scan and parse */ }

      const id = randomUUID();
      const contentHash = createHash("sha256")
        .update(`parse-error:${agent}:${filePath}:${size}:${mtimeMs}`)
        .digest("hex");
      const logDate = new Date(mtimeMs).toISOString().slice(0, 10);

      this.db
        .prepare(
          `INSERT OR IGNORE INTO cli_session_index (
            id, agent, native_session_id, native_file_path,
            started_at, ended_at, imported_at,
            content_hash, log_date, message_count, token_estimate,
            status, is_sub_agent, project, title, model, error
          ) VALUES (?, ?, ?, ?, NULL, NULL, datetime('now'), ?, ?, 0, NULL, 'parse-error', 0, '', ?, NULL, ?)`
        )
        .run(
          id,
          agent,
          `parse-error:${contentHash.slice(0, 16)}`,
          filePath,
          contentHash,
          logDate,
          `Parse error: ${basename(filePath)}`,
          "Failed to parse session file"
        );
    } catch (error) {
      logger.warn({ error, agent, path: filePath }, "Failed to record parse-error session");
    }
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
  private async importSession(session: ParsedSession, signal?: AbortSignal): Promise<boolean> {
    const id = randomUUID();
    const logDate = getLogDate(session);
    const title = generateTitle(session);
    const rawExcerpt = buildRawExcerpt(session);
    const isFileSession = !session.nativeFilePath.startsWith("thread:");
    const existing = isFileSession
      ? this.db
        .prepare(
          `SELECT id, message_count as messageCount
           FROM session_summaries
           WHERE agent = ? AND native_session_id = ?
           LIMIT 1`
        )
        .get(session.agent, session.sessionId) as { id: string; messageCount: number | null } | undefined
      : undefined;

    if (existing && session.messageCount <= (existing.messageCount ?? 0)) {
      return false;
    }

    // Smart summarization (template for small, Gemini for larger)
    const summary = await summarizeSession(session, signal);

    if (existing) {
      this.db
        .prepare(
          `UPDATE session_summaries
           SET ended_at = ?,
               model = ?,
               project = ?,
               title = ?,
               message_count = ?,
               summary = ?,
               raw_excerpt = ?,
               content_hash = ?,
               processed_for_promotion = 0
           WHERE id = ?`
        )
        .run(
          session.endedAt || null,
          session.model || null,
          session.project || null,
          title,
          session.messageCount,
          summary,
          rawExcerpt,
          session.contentHash,
          existing.id
        );
    } else {
      // INSERT into session_summaries (FTS5 auto-syncs via trigger)
      this.db
        .prepare(
          `INSERT INTO session_summaries (
            id, agent, native_session_id, started_at, ended_at,
            model, project, title, message_count, summary,
            raw_excerpt, is_sub_agent, content_hash, origin_device
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'mac-mini')`
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
    }

    // Record in cli_session_index for dedup tracking
    this.db
      .prepare(
        `INSERT INTO cli_session_index (
          id, agent, native_session_id, native_file_path,
          started_at, ended_at, imported_at,
          content_hash, log_date, message_count, token_estimate,
          status, is_sub_agent, project, title, model
        ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, 'imported', 0, ?, ?, ?)
        ON CONFLICT(content_hash) DO UPDATE SET
          agent = excluded.agent,
          native_session_id = excluded.native_session_id,
          native_file_path = excluded.native_file_path,
          started_at = excluded.started_at,
          ended_at = excluded.ended_at,
          imported_at = excluded.imported_at,
          log_date = excluded.log_date,
          message_count = excluded.message_count,
          token_estimate = excluded.token_estimate,
          status = 'imported',
          error = NULL,
          is_sub_agent = 0,
          project = excluded.project,
          title = excluded.title,
          model = excluded.model
        WHERE cli_session_index.status NOT IN ('imported', 'processed')`
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
    return true;
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

      // Re-parse archive-fidelity variants where summary parse intentionally
      // omits or truncates content that should remain in the transcript archive.
      let fullMessages = session.messages;
      if (session.agent === "claude" && session.nativeFilePath && !session.nativeFilePath.startsWith("thread:")) {
        const fullSession = parseClaudeSession(session.nativeFilePath, { archiveFidelity: true });
        if (fullSession) {
          fullMessages = fullSession.messages;
        }
      } else if (session.agent === "opencode" && session.nativeFilePath && !session.nativeFilePath.startsWith("thread:")) {
        const fullSession = parseOpencodeSession(session.nativeFilePath, { archiveFidelity: true });
        if (fullSession) {
          fullMessages = fullSession.messages;
        }
      }

      const messagesJson = JSON.stringify(fullMessages);
      // transcript_hash = byte-exact content address of the stored transcript body.
      // Distinct from content_hash (the truncated summary fingerprint) — this is the
      // identity used as the Cosmos document id for conflict-free cross-device sync.
      const transcriptHash = createHash("sha256").update(messagesJson).digest("hex");
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
          message_count, uncompressed_size, transcript_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        Buffer.byteLength(messagesJson, "utf-8"),
        transcriptHash
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
