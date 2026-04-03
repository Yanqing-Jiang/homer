/**
 * Call follow-up Telegram callback handler.
 * Callback format: a:cf:<conversationId>:<action>
 * Actions: promote, dismiss
 */

import { InlineKeyboard, type Bot } from "grammy";
import { logger } from "../../utils/logger.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { PATHS } from "../../config/paths.js";

const CALLS_DIR = join(PATHS.memory, "calls");

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
    .text("Promote to Memory", `a:cf:${shortId}:promote`)
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
  bot.callbackQuery(/^a:cf:([^:]+):(promote|dismiss)$/, async (ctx) => {
    const conversationId = ctx.match![1]!;
    const action = ctx.match![2]! as "promote" | "dismiss";

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

        case "promote": {
          const messageText = ctx.callbackQuery.message?.text || "";
          const date = new Date().toISOString().slice(0, 10);
          const filename = `call-${conversationId.slice(0, 12)}-${date}.md`;

          if (!existsSync(CALLS_DIR)) mkdirSync(CALLS_DIR, { recursive: true });

          const content = `---\nconversation_id: ${conversationId}\ndate: ${date}\nsource: phone-call\n---\n\n${messageText}\n`;
          writeFileSync(join(CALLS_DIR, filename), content, "utf-8");

          await ctx.answerCallbackQuery({ text: "Promoted to memory" });
          const original = ctx.callbackQuery.message?.text || "";
          await ctx.editMessageText(
            original + "\n\n(Promoted to memory)",
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
