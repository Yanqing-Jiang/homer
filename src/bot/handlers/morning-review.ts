/**
 * Morning Review Orchestrator — Inline chunked review with real health signals.
 *
 * Renders every memory candidate, skill draft, and health signal with FULL content
 * visible inline. User only taps buttons to act (approve/reject/reply), never to
 * expand content. Chunked at ~3500 chars to respect Telegram's 4096-char limit,
 * with global item numbering preserved across chunks.
 *
 * Health signals are read-only alerts aggregated from scheduler and queue state.
 *
 * Callback namespace: mr:skip (Review Later). Per-item actions reuse m:* callbacks
 * from memory-review.ts.
 */

import { Bot } from "grammy";
import { logger } from "../../utils/logger.js";
import type { StateManager } from "../../state/manager.js";
import {
  getPendingCandidates,
  getClaimMetrics,
  type KnowledgeClaim,
} from "../../memory/claims.js";
// Memory/skill candidate review moved to the web Review tab (homer-web).
// sendMemoryMoments is intentionally no longer called from here; its button
// handlers stay registered in bot/index.ts so historical Telegram cards still work.

// ── Types ──────────────────────────────────────────────────

export interface MorningHealthSignal {
  id: string;
  kind: "scheduler" | "queue" | "daemon";
  severity: "info" | "warn" | "error";
  title: string;
  content: string;
  detectedAt: string;
}

export interface MorningReviewSummary {
  dateLabel: string;
  memoryCandidates: KnowledgeClaim[];
  skillCandidates: KnowledgeClaim[];
  healthSignals: MorningHealthSignal[];
  totalItems: number;
}

// ── Health Signal Collection ───────────────────────────────

/**
 * Aggregate real health signals from scheduler state + claim queue metrics.
 * Conservative thresholds to avoid alarm spam.
 */
export function getMorningHealthSignals(sm: StateManager): MorningHealthSignal[] {
  const db = sm.getDb();
  const signals: MorningHealthSignal[] = [];
  const now = new Date().toISOString();

  // 1. Scheduler job failures (consecutive_failures >= 2)
  try {
    const failingJobs = db.prepare(`
      SELECT job_id, consecutive_failures, last_run_at, last_success_at
      FROM scheduled_job_state
      WHERE enabled = 1 AND consecutive_failures >= 2
      ORDER BY consecutive_failures DESC, last_run_at DESC
      LIMIT 5
    `).all() as Array<{ job_id: string; consecutive_failures: number; last_run_at: string | null; last_success_at: string | null }>;

    for (const job of failingJobs) {
      signals.push({
        id: `sched:${job.job_id}`,
        kind: "scheduler",
        severity: job.consecutive_failures >= 5 ? "error" : "warn",
        title: `Job failing: ${job.job_id}`,
        content: `${job.consecutive_failures} consecutive failures. Last run: ${job.last_run_at ?? "never"}. Last success: ${job.last_success_at ?? "never"}.`,
        detectedAt: now,
      });
    }
  } catch (err) {
    logger.debug({ err }, "Health: scheduler query failed");
  }

  // 2. Claim queue pressure
  try {
    const metrics = getClaimMetrics(db);
    const oldestDays = metrics.medianQueueAgeDays;

    if (metrics.candidate > 15) {
      signals.push({
        id: "queue:backlog",
        kind: "queue",
        severity: metrics.candidate > 30 ? "error" : "warn",
        title: "Memory review queue backlog",
        content: `${metrics.candidate} pending candidates. Median age: ${oldestDays ?? "?"}d. Threshold: 15 pending.`,
        detectedAt: now,
      });
    } else if (oldestDays !== null && oldestDays > 2) {
      signals.push({
        id: "queue:stale",
        kind: "queue",
        severity: "warn",
        title: "Stale review items",
        content: `${metrics.candidate} pending, median age ${oldestDays}d. Threshold: 48h oldest.`,
        detectedAt: now,
      });
    }
  } catch (err) {
    logger.debug({ err }, "Health: queue metrics failed");
  }

  // 3. Recent job run failures (last 24h) with no *later* success.
  // Anti-joins against scheduled_job_runs to ignore jobs that failed twice
  // and then recovered — only surface jobs whose latest run in-window was
  // a failure (or had no success after the most recent failure).
  try {
    // started_at is stored as ISO ("2026-04-12T21:41:00.002Z") but
    // datetime('now','-1 day') returns SQLite's space-separated format, so
    // direct lexical `>` is fuzzy on the boundary date. Normalize by stripping
    // the 'T' + trailing ms/Z and running both sides through datetime().
    const recentFailed = db.prepare(`
      SELECT f.job_id, COUNT(*) as fails, MAX(f.started_at) as last_fail_at
      FROM scheduled_job_runs f
      WHERE f.success = 0
        AND datetime(replace(substr(f.started_at, 1, 19), 'T', ' ')) > datetime('now', '-1 day')
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_job_runs s
          WHERE s.job_id = f.job_id
            AND s.success = 1
            AND s.started_at > f.started_at
        )
      GROUP BY f.job_id
      HAVING fails >= 2
      ORDER BY fails DESC
      LIMIT 3
    `).all() as Array<{ job_id: string; fails: number; last_fail_at: string }>;

    for (const row of recentFailed) {
      // Skip if already covered by scheduled_job_state scan
      if (signals.some(s => s.id === `sched:${row.job_id}`)) continue;
      signals.push({
        id: `recent:${row.job_id}`,
        kind: "scheduler",
        severity: "warn",
        title: `Recent failures: ${row.job_id}`,
        content: `${row.fails} failures in the last 24h (no recovery). Last fail: ${row.last_fail_at}.`,
        detectedAt: now,
      });
    }
  } catch (err) {
    logger.debug({ err }, "Health: recent runs query failed");
  }

  return signals;
}

// ── Summary Assembly ───────────────────────────────────────

/**
 * Gather all pending review items from the database.
 */
export function gatherPendingItems(sm: StateManager): MorningReviewSummary {
  const db = sm.getDb();

  // All pending candidates (capped for morning review)
  const allCandidates = getPendingCandidates(db, 30);

  // Memory candidates = everything except cleanup + skill. Cleanup is rarely pending
  // and renders poorly inline (it's a whole-file rewrite), so keep it out of the
  // morning inline feed — user reviews cleanup proposals via dedicated flow.
  const memoryCandidates = allCandidates.filter(
    c => !["cleanup", "skill"].includes(c.claimType)
  );
  const skillCandidates = allCandidates.filter(c => c.claimType === "skill");

  const healthSignals = getMorningHealthSignals(sm);

  const dateLabel = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const totalItems = memoryCandidates.length + skillCandidates.length + healthSignals.length;

  return { dateLabel, memoryCandidates, skillCandidates, healthSignals, totalItems };
}

// ── Telegram Rendering ─────────────────────────────────────

const SEVERITY_EMOJI: Record<MorningHealthSignal["severity"], string> = {
  info: "ℹ️",
  warn: "⚠️",
  error: "🚨",
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderHealthSignalsBlock(signals: MorningHealthSignal[], startOrdinal: number): string {
  if (signals.length === 0) return "";
  const lines: string[] = ["", "━━━━━━━━━━━━", "<b>Health signals</b>", ""];
  for (let i = 0; i < signals.length; i++) {
    const s = signals[i]!;
    const ordinal = startOrdinal + i;
    lines.push(`<b>${ordinal}.</b> ${SEVERITY_EMOJI[s.severity]} <b>${escapeHtml(s.title)}</b>`);
    lines.push(`<i>${escapeHtml(s.content)}</i>`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Send the morning brief: a daily digest + read-only health signals. Memory and
 * skill candidate review now lives on the web Review tab (homer-web), so they are
 * surfaced here only as a count + pointer — not as interactive Telegram cards.
 */
export async function sendMorningReview(
  bot: Bot,
  chatId: number,
  sm: StateManager,
): Promise<void> {
  const summary = gatherPendingItems(sm);

  if (summary.totalItems === 0) {
    logger.debug("Morning review: nothing pending");
    return;
  }

  const headerSuffix = `— ${summary.dateLabel}`;
  const counts: string[] = [];
  if (summary.memoryCandidates.length > 0) counts.push(`${summary.memoryCandidates.length} memory`);
  if (summary.skillCandidates.length > 0) counts.push(`${summary.skillCandidates.length} skill`);
  if (summary.healthSignals.length > 0) counts.push(`${summary.healthSignals.length} health`);
  const countLine = counts.join(" • ");

  const lines: string[] = [
    `🌅 <b>Morning Review</b> ${escapeHtml(headerSuffix)}`,
    `<i>${escapeHtml(countLine)}</i>`,
  ];

  // Memory + skill candidates: pointer to the web Review tab (no inline cards).
  const reviewCount = summary.memoryCandidates.length + summary.skillCandidates.length;
  if (reviewCount > 0) {
    lines.push("", `📥 <b>${reviewCount}</b> item${reviewCount === 1 ? "" : "s"} to review → web Review tab`);
  }

  // Health signals: informational (read-only alerts).
  if (summary.healthSignals.length > 0) {
    lines.push(renderHealthSignalsBlock(summary.healthSignals, 1));
  }

  try {
    await bot.api.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" });
  } catch (err) {
    logger.error({ error: err }, "Morning review: send failed");
  }

  logger.info({
    memory: summary.memoryCandidates.length,
    skills: summary.skillCandidates.length,
    health: summary.healthSignals.length,
    total: summary.totalItems,
  }, "Sent morning brief (memory review on web)");
}

/**
 * Register morning review callbacks. Only mr:skip (Review Later) remains —
 * per-item actions route through m:* callbacks registered by memory-review.ts.
 */
export function registerMorningReviewCallbacks(
  bot: Bot,
  _chatId: number,
  _sm: StateManager,
): void {
  bot.callbackQuery(/^mr:skip$/, async (ctx) => {
    try {
      await ctx.answerCallbackQuery({ text: "⏰ Review postponed" });
    } catch { /* already answered */ }
  });

  // Legacy drilldown callbacks — answer silently so old messages don't show spinners forever
  bot.callbackQuery(/^mr:(memory|cleanup|skills|health)$/, async (ctx) => {
    try {
      await ctx.answerCallbackQuery({ text: "Inline view — scroll up to review" });
    } catch { /* ignore */ }
  });

  logger.info("Morning review callbacks registered (inline mode)");
}
