import { readFileSync, existsSync } from "fs";
import { logger } from "../utils/logger.js";

const HISTORY_FILE = `${process.env.HOME ?? "/Users/yj"}/.claude/history.jsonl`;

export interface ClaudeHistoryEntry {
  display: string;
  timestamp: number;
  project: string;
  sessionId: string;
  pastedContents?: Record<string, unknown>;
}

export interface ClaudeSession {
  sessionId: string;
  project: string;
  prompts: ClaudeHistoryEntry[];
  startTime: number;
  endTime: number;
  promptCount: number;
}

/**
 * Parse the Claude Code history.jsonl file
 */
export function parseHistoryFile(path: string = HISTORY_FILE): ClaudeHistoryEntry[] {
  if (!existsSync(path)) {
    logger.debug({ path }, "Claude history file not found");
    return [];
  }

  try {
    const content = readFileSync(path, "utf-8");
    const lines = content.trim().split("\n").filter(line => line.trim());
    const entries: ClaudeHistoryEntry[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as ClaudeHistoryEntry;
        entries.push(entry);
      } catch {
        // Skip invalid lines
      }
    }

    return entries;
  } catch (error) {
    logger.error({ error, path }, "Failed to parse Claude history file");
    return [];
  }
}

/**
 * Group history entries by session ID
 */
export function groupBySession(entries: ClaudeHistoryEntry[]): Map<string, ClaudeSession> {
  const sessions = new Map<string, ClaudeSession>();

  for (const entry of entries) {
    const existing = sessions.get(entry.sessionId);

    if (existing) {
      existing.prompts.push(entry);
      existing.endTime = Math.max(existing.endTime, entry.timestamp);
      existing.startTime = Math.min(existing.startTime, entry.timestamp);
      existing.promptCount = existing.prompts.length;
    } else {
      sessions.set(entry.sessionId, {
        sessionId: entry.sessionId,
        project: entry.project,
        prompts: [entry],
        startTime: entry.timestamp,
        endTime: entry.timestamp,
        promptCount: 1,
      });
    }
  }

  return sessions;
}

/**
 * Get all sessions sorted by most recent
 */
export function getSessions(limit?: number): ClaudeSession[] {
  const entries = parseHistoryFile();
  const sessionsMap = groupBySession(entries);
  const sessions = Array.from(sessionsMap.values());

  // Sort by most recent activity
  sessions.sort((a, b) => b.endTime - a.endTime);

  if (limit) {
    return sessions.slice(0, limit);
  }

  return sessions;
}

/**
 * Get a single session with all its prompts
 */
export function getSession(sessionId: string): ClaudeSession | null {
  const entries = parseHistoryFile();
  const sessionsMap = groupBySession(entries);
  return sessionsMap.get(sessionId) || null;
}

/**
 * Get session count
 */
export function getSessionCount(): number {
  const entries = parseHistoryFile();
  const sessionsMap = groupBySession(entries);
  return sessionsMap.size;
}
