/**
 * Outcome check Telegram callback handler.
 * Callback format: a:oc:<checkId>:<action>
 * Actions: yes, no, partial, skip
 */

import type { Bot } from "grammy";
import { logger } from "../../utils/logger.js";
import { StateManager } from "../../state/manager.js";
import { appendFile } from "fs/promises";

const FEEDBACK_FILE = "/Users/yj/memory/feedback.md";

export function registerOutcomeHandlers(bot: Bot): void {
  bot.callbackQuery(/^a:oc:([^:]+):(yes|no|partial|skip)$/, async (ctx) => {
    const checkId = ctx.match![1]!;
    const action = ctx.match![2]! as "yes" | "no" | "partial" | "skip";

    const sm = new StateManager("/Users/yj/homer/data/homer.db");
    try {
      if (action === "skip") {
        sm.getDb().prepare(`
          UPDATE outcome_checks SET status = 'skipped', checked_at = datetime('now')
          WHERE id = ?
        `).run(checkId);

        await ctx.answerCallbackQuery({ text: "Skipped" });
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        return;
      }

      // Get check details for feedback log
      const check = sm.getDb().prepare(`
        SELECT source_type, source_id, source_title FROM outcome_checks WHERE id = ?
      `).get(checkId) as { source_type: string; source_id: string; source_title: string } | undefined;

      // Update outcome
      sm.getDb().prepare(`
        UPDATE outcome_checks
        SET status = 'checked', outcome = ?, checked_at = datetime('now')
        WHERE id = ?
      `).run(action, checkId);

      // Log to feedback.md
      if (check) {
        const now = new Date().toISOString().slice(0, 16).replace("T", " ");
        const entry = `\n### [${now}] Outcome — ${check.source_title}\n` +
          `Type: ${check.source_type}\nOutcome: ${action}\nSource ID: ${check.source_id}\n`;
        try {
          await appendFile(FEEDBACK_FILE, entry, "utf-8");
        } catch { /* best effort */ }
      }

      const label = action === "yes" ? "Positive outcome" : action === "no" ? "No outcome" : "Partial outcome";
      await ctx.answerCallbackQuery({ text: label });

      // Update message to show result
      const original = ctx.callbackQuery.message?.text || "";
      await ctx.editMessageText(
        original + `\n\n<b>Result: ${label}</b>`,
        { parse_mode: "HTML" }
      );
    } catch (err) {
      logger.error({ error: err, checkId }, "Failed to process outcome callback");
      await ctx.answerCallbackQuery({ text: "Error processing" });
    } finally {
      sm.close();
    }
  });
}
