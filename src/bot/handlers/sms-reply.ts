/**
 * SMS reply Telegram callback handler.
 * Callback format: a:sms:<messageSid>:<action>
 * Actions: reply, ignore
 */

import type { Bot } from "grammy";
import { logger } from "../../utils/logger.js";
import { sendSmsNotification } from "./sms.js";
import { getSmsContext, clearSmsContext } from "../../telephony/sms-inbound.js";

// Track pending reply conversations: chatId → { targetPhone, originalSid }
const pendingReplies = new Map<number, { targetPhone: string; originalSid: string }>();

/**
 * Register SMS reply inline button handlers.
 */
export function registerSmsReplyHandlers(bot: Bot): void {
  // Handle inline button presses
  bot.callbackQuery(/^a:sms:([^:]+):(reply|ignore)$/, async (ctx) => {
    const shortSid = ctx.match![1]!;
    const action = ctx.match![2]! as "reply" | "ignore";

    try {
      if (action === "ignore") {
        const original = ctx.callbackQuery.message?.text || "";
        await ctx.editMessageText(original + "\n\n(Ignored)", {
          parse_mode: "HTML",
        });
        await ctx.answerCallbackQuery({ text: "Ignored" });
        clearSmsContext(shortSid);
        return;
      }

      // action === "reply"
      const smsContext = getSmsContext(shortSid);
      if (!smsContext) {
        await ctx.answerCallbackQuery({ text: "SMS context expired (1hr TTL)" });
        return;
      }

      // Store pending reply state
      const chatId = ctx.callbackQuery.message?.chat.id;
      if (chatId) {
        pendingReplies.set(chatId, {
          targetPhone: smsContext.from,
          originalSid: shortSid,
        });

        // Auto-expire after 5 minutes
        setTimeout(() => pendingReplies.delete(chatId), 5 * 60 * 1000);
      }

      await ctx.answerCallbackQuery({ text: "Type your reply" });
      await ctx.reply(
        `Reply to ${smsContext.from}:\n_Type your message (next message will be sent as SMS)_`,
        { parse_mode: "Markdown" }
      );
    } catch (error) {
      logger.error({ error, shortSid, action }, "Failed to process SMS callback");
      await ctx.answerCallbackQuery({ text: "Error processing" });
    }
  });

  // Handle text replies after "Reply" button press
  bot.on("message:text", async (ctx, next) => {
    const chatId = ctx.chat.id;
    const pending = pendingReplies.get(chatId);

    if (!pending) {
      // Not in reply mode, pass to next handler
      await next();
      return;
    }

    // This message is the SMS reply
    const replyText = ctx.message.text;
    pendingReplies.delete(chatId);

    try {
      const result = await sendSmsNotification(pending.targetPhone, replyText);
      if (result.success) {
        await ctx.reply(`SMS sent to ${pending.targetPhone}`);
      } else {
        await ctx.reply(`SMS failed: ${result.error}`);
      }
      clearSmsContext(pending.originalSid);
    } catch (error) {
      logger.error({ error }, "Failed to send SMS reply");
      await ctx.reply("Failed to send SMS reply.");
    }
  });
}
