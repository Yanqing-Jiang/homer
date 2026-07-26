/**
 * Morning Review Orchestrator — "things awaiting your decision".
 *
 * Phase 4 (2026-07-26) removed memory review from this surface entirely: extracted
 * claims now land in a trust tier automatically (active if Yanqing said it, passive
 * otherwise) and are never queued for a human. What remains is work that genuinely
 * cannot be auto-applied — file cleanup proposals and skill drafts. Code-push
 * approvals keep their own flow in code-push-approval.ts.
 *
 * Health/system signals live in morning-brief (6:00) and the hourly health-check.
 *
 * Callback namespace: mr:skip (Review Later).
 */

import { Bot } from "grammy";
import { logger } from "../../utils/logger.js";
import type { StateManager } from "../../state/manager.js";
import {
  getPendingCandidates,
  type KnowledgeClaim,
} from "../../memory/claims.js";

// ── Types ──────────────────────────────────────────────────

export interface MorningReviewSummary {
  dateLabel: string;
  cleanupProposals: KnowledgeClaim[];
  skillCandidates: KnowledgeClaim[];
  totalItems: number;
}

// ── Summary Assembly ───────────────────────────────────────

/**
 * Gather the items that still need a human: cleanup proposals (whole-file edits
 * staged by weekly consolidation) and skill drafts. Ordinary memory claims are
 * deliberately excluded — they are no longer reviewable.
 */
export function gatherPendingItems(sm: StateManager): MorningReviewSummary {
  const db = sm.getDb();

  // All pending candidates (capped for morning review)
  const allCandidates = getPendingCandidates(db, 30);

  // Cleanup proposals are replace/remove claims staged under section='cleanup'
  // by weekly-consolidation — a whole-file rewrite nobody should auto-apply.
  const cleanupProposals = allCandidates.filter(
    c => c.section === "cleanup" && ["replace", "remove"].includes(c.claimType)
  );
  const skillCandidates = allCandidates.filter(c => c.claimType === "skill");

  const dateLabel = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const totalItems = cleanupProposals.length + skillCandidates.length;

  return { dateLabel, cleanupProposals, skillCandidates, totalItems };
}

// ── Telegram Rendering ─────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Send the morning review: cleanup proposals + skill drafts awaiting a decision.
 * Listed inline with their claim IDs — there is no review UI left to link to, so
 * the message has to carry enough for Yanqing to act on it in chat.
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
  if (summary.cleanupProposals.length > 0) counts.push(`${summary.cleanupProposals.length} cleanup`);
  if (summary.skillCandidates.length > 0) counts.push(`${summary.skillCandidates.length} skill`);
  const countLine = counts.join(" • ");

  const lines: string[] = [
    `🌅 <b>Morning Review</b> ${escapeHtml(headerSuffix)}`,
    `<i>${escapeHtml(countLine)}</i>`,
  ];

  const firstLine = (c: KnowledgeClaim): string =>
    escapeHtml(c.content.split("\n").find(l => l.trim().length > 0)?.trim().slice(0, 90) ?? "(empty)");

  if (summary.cleanupProposals.length > 0) {
    lines.push("", "🧹 <b>Cleanup proposals</b>");
    for (const c of summary.cleanupProposals.slice(0, 5)) {
      lines.push(`• ${firstLine(c)} <code>${escapeHtml(c.id)}</code>`);
    }
    if (summary.cleanupProposals.length > 5) lines.push(`<i>…and ${summary.cleanupProposals.length - 5} more</i>`);
  }

  if (summary.skillCandidates.length > 0) {
    lines.push("", "🛠 <b>Skill drafts</b>");
    for (const c of summary.skillCandidates.slice(0, 5)) {
      lines.push(`• ${firstLine(c)} <code>${escapeHtml(c.id)}</code>`);
    }
    if (summary.skillCandidates.length > 5) lines.push(`<i>…and ${summary.skillCandidates.length - 5} more</i>`);
  }

  try {
    await bot.api.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" });
  } catch (err) {
    logger.error({ error: err }, "Morning review: send failed");
    throw err;
  }

  logger.info({
    cleanup: summary.cleanupProposals.length,
    skills: summary.skillCandidates.length,
    total: summary.totalItems,
  }, "Sent morning review (cleanup + skills only)");
}

/**
 * Register morning review callbacks. Only mr:skip (Review Later) remains.
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
