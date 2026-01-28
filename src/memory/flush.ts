import { logger } from "../utils/logger.js";
import { appendDailyLog, createDailyEntry } from "./daily.js";
import type { StateManager } from "../state/manager.js";

/**
 * Session data for flush scoring
 */
export interface SessionFlushData {
  sessionId: string;
  context: string;
  subcontext?: string;
  messageCount: number;
  createdAt: number;
  lastActivityAt: number;
  lastFlushAt?: number;
  remindersCreated: number;
  jobsTriggered: number;
}

/**
 * Flush decision result
 */
export interface FlushDecision {
  shouldFlush: boolean;
  score: number;
  reasons: string[];
}

/**
 * Importance thresholds for flush scoring
 */
const THRESHOLDS = {
  // Message count thresholds
  MIN_MESSAGES_SMALL: 6,
  MIN_MESSAGES_LARGE: 12,

  // Session duration thresholds (ms)
  MIN_DURATION_MS: 30 * 60 * 1000, // 30 minutes

  // Recent memory update threshold (ms)
  RECENT_UPDATE_MS: 15 * 60 * 1000, // 15 minutes

  // Minimum score to trigger flush
  MIN_FLUSH_SCORE: 2,
};

/**
 * Calculate flush importance score
 *
 * Scoring heuristics:
 * - message_count >= 6: +1
 * - message_count >= 12: +2 (replaces +1)
 * - session duration >= 30 min: +1
 * - reminders/jobs created: +1
 * - recent memory updates (< 15 min): -1
 */
export function calculateFlushScore(data: SessionFlushData): FlushDecision {
  let score = 0;
  const reasons: string[] = [];

  // Message count scoring
  if (data.messageCount >= THRESHOLDS.MIN_MESSAGES_LARGE) {
    score += 2;
    reasons.push(`${data.messageCount} messages (>=${THRESHOLDS.MIN_MESSAGES_LARGE})`);
  } else if (data.messageCount >= THRESHOLDS.MIN_MESSAGES_SMALL) {
    score += 1;
    reasons.push(`${data.messageCount} messages (>=${THRESHOLDS.MIN_MESSAGES_SMALL})`);
  }

  // Session duration scoring
  const duration = data.lastActivityAt - data.createdAt;
  if (duration >= THRESHOLDS.MIN_DURATION_MS) {
    score += 1;
    const minutes = Math.round(duration / 60000);
    reasons.push(`${minutes} min session duration`);
  }

  // Activity scoring (reminders, jobs)
  if (data.remindersCreated > 0 || data.jobsTriggered > 0) {
    score += 1;
    const activities: string[] = [];
    if (data.remindersCreated > 0) activities.push(`${data.remindersCreated} reminders`);
    if (data.jobsTriggered > 0) activities.push(`${data.jobsTriggered} jobs`);
    reasons.push(`activity: ${activities.join(", ")}`);
  }

  // Recent flush penalty
  if (data.lastFlushAt) {
    const timeSinceFlush = Date.now() - data.lastFlushAt;
    if (timeSinceFlush < THRESHOLDS.RECENT_UPDATE_MS) {
      score -= 1;
      const minutes = Math.round(timeSinceFlush / 60000);
      reasons.push(`recent flush ${minutes} min ago (-1)`);
    }
  }

  const shouldFlush = score >= THRESHOLDS.MIN_FLUSH_SCORE;

  logger.debug(
    {
      sessionId: data.sessionId.slice(0, 8),
      score,
      shouldFlush,
      reasons,
    },
    "Calculated flush score"
  );

  return {
    shouldFlush,
    score,
    reasons,
  };
}

/**
 * Generate flush content from session context
 */
export function generateFlushContent(
  data: SessionFlushData,
  summary?: string
): string {
  const lines: string[] = [];

  // Session info
  const duration = Math.round((data.lastActivityAt - data.createdAt) / 60000);
  lines.push(`Session ending: ${data.context}${data.subcontext ? `/${data.subcontext}` : ""}`);
  lines.push(`- Duration: ${duration} minutes, ${data.messageCount} messages`);

  // Activity summary
  if (data.remindersCreated > 0) {
    lines.push(`- Created ${data.remindersCreated} reminder(s)`);
  }
  if (data.jobsTriggered > 0) {
    lines.push(`- Triggered ${data.jobsTriggered} job(s)`);
  }

  // Optional summary
  if (summary) {
    lines.push("");
    lines.push(`Summary: ${summary}`);
  }

  return lines.join("\n");
}

/**
 * Execute a pre-timeout flush for a session
 */
export async function executeFlush(
  data: SessionFlushData,
  summary?: string
): Promise<boolean> {
  const decision = calculateFlushScore(data);

  if (!decision.shouldFlush) {
    logger.debug(
      { sessionId: data.sessionId.slice(0, 8), score: decision.score },
      "Skipping flush - score too low"
    );
    return false;
  }

  try {
    const content = generateFlushContent(data, summary);
    const context = data.context === "default" ? "general" : data.context as "work" | "life" | "general";

    const entry = createDailyEntry(content, context, "flush");
    await appendDailyLog(entry);

    logger.info(
      {
        sessionId: data.sessionId.slice(0, 8),
        context: data.context,
        score: decision.score,
        reasons: decision.reasons,
      },
      "Session flush completed"
    );

    return true;
  } catch (error) {
    logger.error(
      { error, sessionId: data.sessionId.slice(0, 8) },
      "Failed to execute flush"
    );
    return false;
  }
}

/**
 * Check and flush sessions that are about to expire
 * Called hourly from main cron
 */
export async function checkAndFlushExpiringSessions(
  stateManager: StateManager,
  ttlMs: number
): Promise<number> {
  const sessions = stateManager.getActiveSessions();
  const now = Date.now();

  // Sessions that will expire within the next hour
  const expirationWindow = 60 * 60 * 1000; // 1 hour
  const expirationThreshold = now - ttlMs + expirationWindow;

  let flushedCount = 0;

  for (const session of sessions) {
    // Skip sessions that aren't close to expiring
    if (session.lastActivityAt > expirationThreshold) {
      continue;
    }

    // Build flush data
    // Note: remindersCreated and jobsTriggered would need tracking in StateManager
    // For now, we'll use 0 as placeholders
    const flushData: SessionFlushData = {
      sessionId: session.id,
      context: session.lane,
      messageCount: session.messageCount,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      remindersCreated: 0, // TODO: track in state manager
      jobsTriggered: 0, // TODO: track in state manager
    };

    const flushed = await executeFlush(flushData);
    if (flushed) {
      flushedCount++;
    }
  }

  if (flushedCount > 0) {
    logger.info({ flushedCount }, "Flushed expiring sessions");
  }

  return flushedCount;
}
