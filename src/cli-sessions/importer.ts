import Database from "better-sqlite3";
import { appendFile } from "fs/promises";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { logger } from "../utils/logger.js";
import type { ParsedSession } from "./parsers.js";
import {
  parseCodexSession,
  parseGeminiSession,
  parseKimiSession,
  parseOpencodeSession,
  scanCodexSessions,
  scanGeminiSessions,
  scanKimiSessions,
  scanOpencodeSessions,
} from "./parsers.js";
import { formatSessionForDailyLog, getLogDate } from "./summarizer.js";
import { getMemoryIndexer } from "../memory/indexer.js";

interface ImportOptions {
  sinceDays?: number;
  agent?: "codex" | "gemini" | "kimi" | "opencode" | "all";
  dryRun?: boolean;
}

interface ImportStats {
  scanned: number;
  imported: number;
  skipped: number;
  errors: number;
}

/**
 * Import CLI sessions into daily logs
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
      errors: 0,
    };

    logger.info({ sinceDays, agent, dryRun }, "Starting CLI session import");

    // Scan for session files
    const sessionFiles: Array<{ agent: string; path: string }> = [];

    if (agent === "all" || agent === "codex") {
      const codexFiles = scanCodexSessions(this.homeDir, sinceDays);
      sessionFiles.push(...codexFiles.map((path) => ({ agent: "codex", path })));
    }

    if (agent === "all" || agent === "gemini") {
      const geminiFiles = scanGeminiSessions(this.homeDir, sinceDays);
      sessionFiles.push(...geminiFiles.map((path) => ({ agent: "gemini", path })));
    }

    if (agent === "all" || agent === "kimi") {
      const kimiFiles = scanKimiSessions(this.homeDir, sinceDays);
      sessionFiles.push(...kimiFiles.map((path) => ({ agent: "kimi", path })));
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
        } else if (sessionAgent === "gemini") {
          session = parseGeminiSession(path);
        } else if (sessionAgent === "kimi") {
          session = parseKimiSession(path);
        } else if (sessionAgent === "opencode") {
          session = parseOpencodeSession(path);
        }

        if (!session) {
          stats.errors++;
          logger.warn({ path }, "Failed to parse session");
          continue;
        }

        // Check if already imported (dedup)
        if (this.isAlreadyImported(session.contentHash)) {
          stats.skipped++;
          logger.debug({ sessionId: session.sessionId }, "Session already imported (duplicate)");
          continue;
        }

        // Dry run - just count, don't import
        if (dryRun) {
          stats.imported++;
          logger.info({ sessionId: session.sessionId, agent: session.agent }, "Would import session");
          continue;
        }

        // Import session
        await this.importSession(session);
        stats.imported++;

        logger.info(
          {
            sessionId: session.sessionId,
            agent: session.agent,
            messages: session.messageCount,
          },
          "Imported session"
        );
      } catch (error) {
        stats.errors++;
        logger.error({ error, path }, "Error processing session");
      }
    }

    // Reindex affected daily logs if not dry run
    if (!dryRun && stats.imported > 0) {
      logger.info("Reindexing updated daily logs");
      const indexer = getMemoryIndexer();
      await indexer.indexAllMemoryFiles();
    }

    logger.info(stats, "CLI session import completed");
    return stats;
  }

  /**
   * Check if session already imported using content hash
   */
  private isAlreadyImported(contentHash: string): boolean {
    const result = this.db
      .prepare("SELECT 1 FROM cli_session_index WHERE content_hash = ?")
      .get(contentHash);
    return result !== undefined;
  }

  /**
   * Import a single session
   */
  private async importSession(session: ParsedSession): Promise<void> {
    const id = randomUUID();
    const logDate = getLogDate(session);
    const dailyLogPath = `/Users/yj/memory/daily/${logDate}.md`;

    // Format session for daily log (with full detail preservation)
    const sessionBlock = formatSessionForDailyLog(session);

    // Append to daily log
    if (!existsSync(dailyLogPath)) {
      // Create new daily log file
      await appendFile(dailyLogPath, `# ${logDate}\n\n`);
    }

    await appendFile(dailyLogPath, sessionBlock);

    // Record in database
    this.db
      .prepare(
        `INSERT INTO cli_session_index (
          id, agent, native_session_id, native_file_path,
          started_at, ended_at, imported_at,
          content_hash, log_date, message_count, token_estimate, status
        ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, 'imported')`
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
        session.tokenEstimate || null
      );
  }

  /**
   * Get import statistics
   */
  getStats(): {
    totalImported: number;
    byAgent: Record<string, number>;
    recentImports: Array<{ agent: string; logDate: string; messageCount: number }>;
  } {
    const total = this.db
      .prepare("SELECT COUNT(*) as count FROM cli_session_index WHERE status = 'imported'")
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
      byAgent: byAgentMap,
      recentImports: recent,
    };
  }
}
