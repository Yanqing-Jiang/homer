import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { logger } from "../utils/logger.js";
import type { ParsedSession } from "./parsers.js";
import {
  parseCodexSession,
  parseKimiSession,
  parseClaudeSession,
  parseOpencodeSession,
  scanCodexSessions,
  scanKimiSessions,
  scanClaudeSessions,
  scanOpencodeSessions,
} from "./parsers.js";
import { summarizeSession, generateTitle, buildRawExcerpt, getLogDate } from "./summarizer.js";

export type AgentType = "codex" | "gemini" | "kimi" | "claude" | "opencode" | "all";

interface ImportOptions {
  sinceDays?: number;
  agent?: AgentType;
  dryRun?: boolean;
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

  // 4. bypassPermissions mode (set by automated runs)
  // This is heuristic — parsed sessions don't carry permission metadata directly,
  // but OpenCode sessions from `opencode run` always have deny-all permissions
  // which manifests as very short sessions with structured prompts

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
    const { sinceDays = 7, agent = "all", dryRun = false } = options;

    const stats: ImportStats = {
      scanned: 0,
      imported: 0,
      skipped: 0,
      subAgents: 0,
      errors: 0,
    };

    logger.info({ sinceDays, agent, dryRun }, "Starting CLI session import");

    // Scan for session files
    const sessionFiles: Array<{ agent: string; path: string }> = [];

    if (agent === "all" || agent === "codex") {
      const codexFiles = scanCodexSessions(this.homeDir, sinceDays);
      sessionFiles.push(...codexFiles.map((path) => ({ agent: "codex", path })));
    }

    if (agent === "all" || agent === "kimi") {
      const kimiFiles = scanKimiSessions(this.homeDir, sinceDays);
      sessionFiles.push(...kimiFiles.map((path) => ({ agent: "kimi", path })));
    }

    if (agent === "all" || agent === "claude") {
      const claudeFiles = scanClaudeSessions(this.homeDir, sinceDays);
      sessionFiles.push(...claudeFiles.map((path) => ({ agent: "claude", path })));
    }

    if (agent === "all" || agent === "opencode") {
      const opencodeFiles = scanOpencodeSessions(this.homeDir, sinceDays);
      sessionFiles.push(...opencodeFiles.map((path) => ({ agent: "opencode", path })));
    }

    stats.scanned = sessionFiles.length;
    logger.info({ count: stats.scanned }, "Found session files to process");

    // Process each session file
    for (const { agent: sessionAgent, path } of sessionFiles) {
      try {
        // Parse session
        let session: ParsedSession | null = null;

        if (sessionAgent === "codex") {
          session = parseCodexSession(path);
        } else if (sessionAgent === "kimi") {
          session = parseKimiSession(path);
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
        await this.importSession(session);
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

    logger.info(stats, "CLI session import completed");
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
   * Import a single session: summarize → INSERT session_summaries → record in cli_session_index
   */
  private async importSession(session: ParsedSession): Promise<void> {
    const id = randomUUID();
    const logDate = getLogDate(session);
    const title = generateTitle(session);
    const rawExcerpt = buildRawExcerpt(session);

    // Smart summarization (template for small, Gemini for larger)
    const summary = await summarizeSession(session);

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
