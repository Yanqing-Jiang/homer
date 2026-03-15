import { sendSmsNotification } from "../bot/handlers/sms.js";
import { YANQING_PHONE } from "./constants.js";
import { logger } from "../utils/logger.js";
import type { Bot } from "grammy";
import { escapeHtml } from "../utils/telegram-format.js";

export interface InboundSms {
  from: string;
  body: string;
  messageSid: string;
  numMedia: number;
  mediaUrls: string[];
}

// In-memory store for SMS context (used by reply handler)
const pendingSmsContext = new Map<string, InboundSms>();
const SMS_CONTEXT_TTL_MS = 60 * 60 * 1000; // 1 hour

export function getSmsContext(messageSid: string): InboundSms | undefined {
  return pendingSmsContext.get(messageSid);
}

export function clearSmsContext(messageSid: string): void {
  pendingSmsContext.delete(messageSid);
}

/**
 * Handle an inbound SMS received via Twilio webhook.
 */
export async function handleInboundSms(
  sms: InboundSms,
  bot: Bot | null,
  chatId: number
): Promise<void> {
  logger.info(
    { from: sms.from, bodyLength: sms.body.length, numMedia: sms.numMedia },
    "Processing inbound SMS"
  );

  if (sms.from === YANQING_PHONE) {
    await handleYanqingCommand(sms);
  } else {
    await handleExternalSms(sms, bot, chatId);
  }
}

/**
 * Handle SMS from Yanqing — echo back for now.
 * Full LLM command processing can be added later.
 */
async function handleYanqingCommand(sms: InboundSms): Promise<void> {
  logger.info({ body: sms.body.slice(0, 50) }, "SMS command from Yanqing");

  try {
    await sendSmsNotification(YANQING_PHONE, `Received: ${sms.body.slice(0, 250)}`);
  } catch (error) {
    logger.error({ error }, "Failed to send SMS echo response");
  }
}

/**
 * Handle SMS from external numbers — forward to Telegram with reply buttons.
 */
async function handleExternalSms(
  sms: InboundSms,
  bot: Bot | null,
  chatId: number
): Promise<void> {
  if (!bot) {
    logger.warn("No bot available for external SMS forwarding");
    return;
  }

  // Store context for reply handler
  pendingSmsContext.set(sms.messageSid, sms);
  setTimeout(() => pendingSmsContext.delete(sms.messageSid), SMS_CONTEXT_TTL_MS);

  const mediaNote = sms.numMedia > 0 ? `\n(${sms.numMedia} attachment${sms.numMedia > 1 ? "s" : ""})` : "";
  // Truncate SID for callback data (Telegram 64-byte limit)
  const shortSid = sms.messageSid.slice(0, 20);

  try {
    const { InlineKeyboard } = await import("grammy");
    const keyboard = new InlineKeyboard()
      .text("Reply", `a:sms:${shortSid}:reply`)
      .text("Ignore", `a:sms:${shortSid}:ignore`);

    await bot.api.sendMessage(
      chatId,
      `<b>SMS from ${escapeHtml(sms.from)}</b>\n\n${escapeHtml(sms.body)}${mediaNote}`,
      { parse_mode: "HTML", reply_markup: keyboard }
    );
  } catch (error) {
    logger.error({ error, from: sms.from }, "Failed to forward SMS to Telegram");
  }
}

