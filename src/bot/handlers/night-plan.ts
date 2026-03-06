/**
 * Telegram Night Plan Review Handler
 *
 * Handles approval/rejection of night supervisor plans via inline keyboard.
 * Buttons: [Execute All] [Edit Plan] [Skip Tonight]
 */

import { Bot, InlineKeyboard } from "grammy";
import type { StateManager } from "../../state/manager.js";
import { executeApprovedPlan } from "../../night/plan-runner.js";
import { logger } from "../../utils/logger.js";

interface NightPlanRow {
  id: string;
  session_id: string;
  plan_json: string;
  status: string;
  created_at: string;
  reviewed_at: string | null;
  executed_at: string | null;
  telegram_message_id: number | null;
  user_notes: string | null;
}

export function registerNightPlanCallbacks(bot: Bot, stateManager: StateManager): void {
  const db = stateManager.getDb();

  // Execute All
  bot.callbackQuery(/^night_plan:execute:(.+)$/, async (ctx) => {
    const planId = ctx.match?.[1];
    if (!planId) {
      await ctx.answerCallbackQuery({ text: "Invalid plan ID" });
      return;
    }

    const plan = db.prepare("SELECT * FROM night_plans WHERE id = ?").get(planId) as NightPlanRow | undefined;
    if (!plan) {
      await ctx.answerCallbackQuery({ text: "Plan not found" });
      return;
    }

    if (plan.status !== "pending") {
      await ctx.answerCallbackQuery({ text: `Plan already ${plan.status}` });
      return;
    }

    // Mark as approved
    db.prepare(
      "UPDATE night_plans SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(planId);

    await ctx.answerCallbackQuery({ text: "Plan approved — executing..." });

    // Update message to show approval
    try {
      const original = ctx.callbackQuery.message?.text || "";
      await ctx.editMessageText(original + "\n\n✅ Approved — executing...", {
        parse_mode: "HTML",
      });
    } catch {
      // Message might be too old to edit
    }

    // Execute in background
    const chatId = ctx.chat?.id ?? 0;
    executeApprovedPlan(planId, db, bot, chatId).catch((err) => {
      logger.error({ planId, error: String(err) }, "Plan execution failed");
      bot.api.sendMessage(chatId, `Night plan execution failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    });
  });

  // Edit Plan — ask for revision notes
  bot.callbackQuery(/^night_plan:edit:(.+)$/, async (ctx) => {
    const planId = ctx.match?.[1];
    if (!planId) {
      await ctx.answerCallbackQuery({ text: "Invalid plan ID" });
      return;
    }

    const plan = db.prepare("SELECT * FROM night_plans WHERE id = ?").get(planId) as NightPlanRow | undefined;
    if (!plan || plan.status !== "pending") {
      await ctx.answerCallbackQuery({ text: plan ? `Plan already ${plan.status}` : "Plan not found" });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Reply with your revision notes" });

    try {
      await ctx.editMessageText(
        (ctx.callbackQuery.message?.text || "") + "\n\n✏️ Reply to this message with your revision notes.",
        { parse_mode: "HTML" },
      );
    } catch {
      // Message might be too old
    }

    // Store pending edit state — user's next reply to this message triggers re-generation
    db.prepare(
      "UPDATE night_plans SET status = 'editing', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(planId);
  });

  // Skip Tonight
  bot.callbackQuery(/^night_plan:skip:(.+)$/, async (ctx) => {
    const planId = ctx.match?.[1];
    if (!planId) {
      await ctx.answerCallbackQuery({ text: "Invalid plan ID" });
      return;
    }

    const plan = db.prepare("SELECT * FROM night_plans WHERE id = ?").get(planId) as NightPlanRow | undefined;
    if (!plan) {
      await ctx.answerCallbackQuery({ text: "Plan not found" });
      return;
    }

    db.prepare(
      "UPDATE night_plans SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP, user_notes = 'Skipped by user' WHERE id = ?"
    ).run(planId);

    await ctx.answerCallbackQuery({ text: "Plan skipped" });

    try {
      const original = ctx.callbackQuery.message?.text || "";
      await ctx.editMessageText(original + "\n\n⏭️ Skipped", { parse_mode: "HTML" });
    } catch {
      // Best effort
    }
  });
}

/**
 * Check for unreviewed night plans older than 12 hours and send a reminder.
 * Called from morning reminder cron job.
 */
export async function sendPendingPlanReminder(bot: Bot, db: ReturnType<StateManager["getDb"]>, chatId: number): Promise<number> {
  try {
    const stale = db.prepare(`
      SELECT id, plan_json, created_at FROM night_plans
      WHERE status = 'pending'
        AND datetime(created_at) < datetime('now', '-12 hours')
    `).all() as NightPlanRow[];

    for (const plan of stale) {
      let parsed: { summary?: string };
      try {
        parsed = JSON.parse(plan.plan_json);
      } catch {
        parsed = {};
      }

      const keyboard = new InlineKeyboard()
        .text("Execute All", `night_plan:execute:${plan.id}`)
        .text("Skip", `night_plan:skip:${plan.id}`);

      await bot.api.sendMessage(
        chatId,
        `⏰ You have an unreviewed night plan from ${plan.created_at}.\n\n${parsed.summary || "No summary"}\n\n[Review Now]`,
        { reply_markup: keyboard },
      );
    }

    return stale.length;
  } catch (err) {
    logger.warn({ error: String(err) }, "Failed to check pending night plans");
    return 0;
  }
}
