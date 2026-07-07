/**
 * Morning Review Orchestrator — "things awaiting your decision".
 *
 * Surfaces pending memory candidates and skill drafts (with a pointer to the web
 * Review tab). Health/system signals are intentionally NOT shown here — they live
 * in morning-brief (6:00) and the hourly health-check.
 *
 * Callback namespace: mr:skip (Review Later). Per-item actions reuse m:* callbacks
 * from memory-review.ts.
 */

import { Bot } from "grammy";
import { logger } from "../../utils/logger.js";
import type { StateManager } from "../../state/manager.js";
import {
  getPendingCandidates,
  type KnowledgeClaim,
} from "../../memory/claims.js";
// Memory/skill candidate review moved to the web Review tab (homer-web).
// sendMemoryMoments is intentionally no longer called from here; its button
// handlers stay registered in bot/index.ts so historical Telegram cards still work.

// ── Types ──────────────────────────────────────────────────

export interface MorningReviewSummary {
  dateLabel: string;
  memoryCandidates: KnowledgeClaim[];
  skillCandidates: KnowledgeClaim[];
  totalItems: number;
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

  const dateLabel = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const totalItems = memoryCandidates.length + skillCandidates.length;

  return { dateLabel, memoryCandidates, skillCandidates, totalItems };
}

// ── Telegram Rendering ─────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Send the morning review: pending memory + skill candidates awaiting a decision.
 * Review itself now lives on the web Review tab (homer-web), so items are surfaced
 * here only as a count + pointer — not as interactive Telegram cards.
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

  try {
    await bot.api.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" });
  } catch (err) {
    logger.error({ error: err }, "Morning review: send failed");
    throw err;
  }

  logger.info({
    memory: summary.memoryCandidates.length,
    skills: summary.skillCandidates.length,
    total: summary.totalItems,
  }, "Sent morning review (memory review on web)");
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
