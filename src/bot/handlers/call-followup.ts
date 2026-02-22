/**
 * Call follow-up Telegram callback handler.
 * Callback format: a:cf:<conversationId>:<action>
 * Actions: calendar, todo, idea, dismiss
 */

import { InlineKeyboard, type Bot } from "grammy";
import { logger } from "../../utils/logger.js";
import { writeFileSync } from "fs";
import { join } from "path";

const IDEAS_DIR = "/Users/yj/memory/ideas";

/**
 * Send call summary with action buttons.
 */
export async function sendCallSummaryWithButtons(
  bot: Bot,
  chatId: number,
  message: string,
  conversationId: string
): Promise<void> {
  // Truncate conversationId for callback data (Telegram 64-byte limit)
  const shortId = conversationId.slice(0, 20);

  const keyboard = new InlineKeyboard()
    .text("Schedule", `a:cf:${shortId}:calendar`)
    .text("Add Todo", `a:cf:${shortId}:todo`)
    .row()
    .text("Add Idea", `a:cf:${shortId}:idea`)
    .text("Dismiss", `a:cf:${shortId}:dismiss`);

  await bot.api.sendMessage(chatId, message, {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

/**
 * Register call follow-up inline button handlers.
 */
export function registerCallFollowupHandlers(bot: Bot): void {
  bot.callbackQuery(/^a:cf:([^:]+):(calendar|todo|idea|dismiss)$/, async (ctx) => {
    const conversationId = ctx.match![1]!;
    const action = ctx.match![2]! as "calendar" | "todo" | "idea" | "dismiss";

    try {
      switch (action) {
        case "dismiss": {
          const original = ctx.callbackQuery.message?.text || "";
          await ctx.editMessageText(original + "\n\n(Dismissed)", {
            parse_mode: "HTML",
          });
          await ctx.answerCallbackQuery({ text: "Dismissed" });
          break;
        }

        case "calendar": {
          await ctx.answerCallbackQuery({ text: "Reply with date/time to schedule" });
          await ctx.reply(
            `Reply with the date and time to schedule a follow-up:\n` +
            `e.g., "tomorrow at 2pm" or "next Monday 10am"\n\n` +
            `Use /remind <time> <message> to set it.`,
          );
          break;
        }

        case "todo": {
          await ctx.answerCallbackQuery({ text: "Reply with todo text" });
          await ctx.reply(
            `Reply with the todo item from this call:\n` +
            `Conv: \`${conversationId}\``,
            { parse_mode: "Markdown" }
          );
          break;
        }

        case "idea": {
          // Create an idea file from the call
          const timestamp = new Date().toISOString().slice(0, 10);
          const filename = `call-${conversationId.slice(0, 8)}-${timestamp}.md`;
          const filepath = join(IDEAS_DIR, filename);

          const content = `---
title: "Follow-up from call ${conversationId.slice(0, 8)}"
status: draft
source: phone-call
created: ${new Date().toISOString()}
---

From call conversation ${conversationId}.

TODO: Add details from call summary.
`;
          writeFileSync(filepath, content, "utf-8");

          await ctx.answerCallbackQuery({ text: "Idea created" });
          const original = ctx.callbackQuery.message?.text || "";
          await ctx.editMessageText(
            original + `\n\n<b>Idea created:</b> ${filename}`,
            { parse_mode: "HTML" }
          );
          break;
        }
      }
    } catch (error) {
      logger.error({ error, conversationId, action }, "Failed to process call follow-up");
      await ctx.answerCallbackQuery({ text: "Error processing action" });
    }
  });
}
