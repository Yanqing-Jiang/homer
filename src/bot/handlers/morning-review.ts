/**
 * Morning Review Orchestrator — Consolidated approval workflow.
 *
 * Aggregates all overnight changes requiring review into one Telegram session:
 * - Memory candidates (facts, decisions, preferences)
 * - Cleanup proposals (weekly file rewrites)
 * - Skill promotions (draft → active)
 * - Harness improvement proposals
 *
 * Sends a summary message at 7 AM with category counts + drilldown buttons.
 * Each category dispatches to existing renderers (sendMemoryMoments, etc.)
 *
 * Callback namespace: mr:* (morning review)
 */

import { Bot, InlineKeyboard } from "grammy";
import { logger } from "../../utils/logger.js";
import type { StateManager } from "../../state/manager.js";
import {
  getPendingCandidates,
  getStaleClaims,
  type KnowledgeClaim,
} from "../../memory/claims.js";
import { sendMemoryMoments, sendLintFindings } from "./memory-review.js";
// escapeHtml available if needed for future enrichment

// ── Types ──────────────────────────────────────────────────

interface MorningReviewSummary {
  memoryCandidates: KnowledgeClaim[];
  cleanupProposals: KnowledgeClaim[];
  skillCandidates: KnowledgeClaim[];
  staleClaims: KnowledgeClaim[];
  totalItems: number;
}

// ── Core Functions ─────────────────────────────────────────

/**
 * Gather all pending review items from the database.
 */
export function gatherPendingItems(sm: StateManager): MorningReviewSummary {
  const db = sm.getDb();

  // All pending candidates
  const allCandidates = getPendingCandidates(db, 20);

  // Split by claim type
  const memoryCandidates = allCandidates.filter(
    c => !["cleanup", "skill"].includes(c.claimType)
  );
  const cleanupProposals = allCandidates.filter(c => c.claimType === "cleanup");
  const skillCandidates = allCandidates.filter(c => c.claimType === "skill");

  // Stale claims from lint
  const staleClaims = getStaleClaims(db, 5);

  const totalItems = memoryCandidates.length + cleanupProposals.length +
    skillCandidates.length + staleClaims.length;

  return { memoryCandidates, cleanupProposals, skillCandidates, staleClaims, totalItems };
}

/**
 * Send the morning review summary to Telegram.
 * Shows category counts with drilldown buttons.
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

  // Build summary message
  const lines: string[] = [
    "🌅 <b>Morning Review</b>",
    "━━━━━━━━━━━━",
    "",
  ];

  // Category counts
  const categories: Array<{ emoji: string; label: string; count: number; key: string }> = [
    { emoji: "🧠", label: "Memory", count: summary.memoryCandidates.length, key: "memory" },
    { emoji: "🧹", label: "Cleanup", count: summary.cleanupProposals.length, key: "cleanup" },
    { emoji: "🧩", label: "Skills", count: summary.skillCandidates.length, key: "skills" },
    { emoji: "🔍", label: "Health", count: summary.staleClaims.length, key: "health" },
  ];

  for (const cat of categories) {
    if (cat.count > 0) {
      lines.push(`${cat.emoji} <b>${cat.label}:</b> ${cat.count} item${cat.count > 1 ? "s" : ""}`);
    }
  }

  lines.push("");
  lines.push(`<b>${summary.totalItems}</b> total items need your attention`);

  // Build keyboard with drilldown buttons
  const keyboard = new InlineKeyboard();
  const activeCats = categories.filter(c => c.count > 0);

  // Two buttons per row
  for (let i = 0; i < activeCats.length; i += 2) {
    const cat1 = activeCats[i]!;
    keyboard.text(`${cat1.emoji} ${cat1.label} (${cat1.count})`, `mr:${cat1.key}`);
    const cat2 = activeCats[i + 1];
    if (cat2) {
      keyboard.text(`${cat2.emoji} ${cat2.label} (${cat2.count})`, `mr:${cat2.key}`);
    }
    keyboard.row();
  }

  keyboard.text("⏭ Review Later", "mr:skip");

  try {
    await bot.api.sendMessage(chatId, lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    logger.info({ total: summary.totalItems }, "Sent morning review summary");
  } catch (err) {
    logger.error({ error: err }, "Failed to send morning review");
  }
}

/**
 * Register morning review callback handlers on the bot.
 */
export function registerMorningReviewCallbacks(
  bot: Bot,
  chatId: number,
  sm: StateManager,
): void {
  bot.callbackQuery(/^mr:(.+)$/, async (ctx) => {
    const action = ctx.match![1];
    const db = sm.getDb();

    try {
      switch (action) {
        case "memory": {
          const candidates = getPendingCandidates(db, 10).filter(
            c => !["cleanup", "skill"].includes(c.claimType)
          );
          if (candidates.length > 0) {
            await sendMemoryMoments(bot, chatId, candidates);
          } else {
            await ctx.answerCallbackQuery({ text: "No memory items pending" });
          }
          break;
        }

        case "cleanup": {
          const cleanups = getPendingCandidates(db, 10).filter(c => c.claimType === "cleanup");
          if (cleanups.length > 0) {
            // Render cleanup proposals using memory moments format
            // (reuses existing approve/reject buttons via claims pipeline)
            await sendMemoryMoments(bot, chatId, cleanups);
          } else {
            await ctx.answerCallbackQuery({ text: "No cleanup proposals pending" });
          }
          break;
        }

        case "skills": {
          const skills = getPendingCandidates(db, 10).filter(c => c.claimType === "skill");
          if (skills.length > 0) {
            await sendMemoryMoments(bot, chatId, skills);
          } else {
            await ctx.answerCallbackQuery({ text: "No skill candidates pending" });
          }
          break;
        }

        case "health": {
          const stale = getStaleClaims(db, 5);
          if (stale.length > 0) {
            await sendLintFindings(bot, chatId, stale);
          } else {
            await ctx.answerCallbackQuery({ text: "No health findings" });
          }
          break;
        }

        case "skip": {
          await ctx.answerCallbackQuery({ text: "Review postponed" });
          break;
        }
      }

      // Answer the callback to remove loading indicator (unless already answered)
      try { await ctx.answerCallbackQuery(); } catch { /* already answered */ }

    } catch (err) {
      logger.error({ error: err, action }, "Morning review callback failed");
      try { await ctx.answerCallbackQuery({ text: "Error — check logs" }); } catch { /* ignore */ }
    }
  });

  logger.info("Morning review callbacks registered");
}
