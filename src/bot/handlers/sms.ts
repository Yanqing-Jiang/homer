/**
 * Telegram SMS/MMS Handler
 *
 * Detects "text XXX message" or "sms XXX message" patterns in messages
 * and sends SMS/MMS via Twilio REST API.
 */

import type { Context } from "grammy";
import { logger } from "../../utils/logger.js";
import { config } from "../../config/index.js";

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

// Pattern: "text +1XXXXXXXXXX hey what's up" or "sms 2709789240 meeting at 3"
// Captures: (phone number) (message body)
const SMS_PATTERN =
  /^(?:text|sms)\s+(\+?1?\s*[-.()\s]*\d[\d\s\-().]*\d)\s+([\s\S]+)/i;
const PHONE_DIGITS = /\d/g;

/**
 * Parse an SMS request from text.
 * Returns { phoneNumber, body } or null if not an SMS request.
 */
export function parseSmsRequest(
  text: string
): { phoneNumber: string; body: string } | null {
  const match = text.match(SMS_PATTERN);
  if (!match) return null;

  const rawNumber = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  if (!body) return null;

  const digits = rawNumber.match(PHONE_DIGITS)?.join("") ?? "";

  let phoneNumber: string | null = null;
  if (digits.length === 10) phoneNumber = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1"))
    phoneNumber = `+${digits}`;

  if (!phoneNumber) return null;

  return { phoneNumber, body };
}

interface SmsResult {
  success: boolean;
  sid?: string;
  error?: string;
}

/**
 * Send an SMS via Twilio REST API.
 */
async function sendSms(to: string, body: string): Promise<SmsResult> {
  const { accountSid, authToken, phoneNumber: from } = config.twilio;

  if (!accountSid || !authToken || !from) {
    return { success: false, error: "Twilio credentials not configured" };
  }

  try {
    const url = `${TWILIO_API_BASE}/Accounts/${accountSid}/Messages.json`;
    const params = new URLSearchParams({ To: to, From: from, Body: body });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const data = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      const errMsg =
        (data.message as string) ?? `API error ${response.status}`;
      logger.error(
        { status: response.status, code: data.code, message: errMsg },
        "Twilio SMS send failed"
      );
      return { success: false, error: errMsg };
    }

    return { success: true, sid: data.sid as string };
  } catch (error) {
    logger.error({ error }, "Failed to send SMS");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Send an MMS (SMS with media) via Twilio REST API.
 */
export async function sendMms(
  to: string,
  body: string,
  mediaUrl: string
): Promise<SmsResult> {
  const { accountSid, authToken, phoneNumber: from } = config.twilio;

  if (!accountSid || !authToken || !from) {
    return { success: false, error: "Twilio credentials not configured" };
  }

  try {
    const url = `${TWILIO_API_BASE}/Accounts/${accountSid}/Messages.json`;
    const params = new URLSearchParams({
      To: to,
      From: from,
      Body: body,
      MediaUrl: mediaUrl,
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const data = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      const errMsg =
        (data.message as string) ?? `API error ${response.status}`;
      logger.error(
        { status: response.status, code: data.code, message: errMsg },
        "Twilio MMS send failed"
      );
      return { success: false, error: errMsg };
    }

    return { success: true, sid: data.sid as string };
  } catch (error) {
    logger.error({ error }, "Failed to send MMS");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Programmatic SMS send (for use by scheduler jobs, notifications, etc.)
 */
export async function sendSmsNotification(
  to: string,
  body: string
): Promise<SmsResult> {
  return sendSms(to, body);
}

/**
 * Handle an SMS request from Telegram.
 * Returns true if the message was handled as an SMS request.
 */
export async function handleSmsRequest(
  ctx: Context,
  text: string
): Promise<boolean> {
  const parsed = parseSmsRequest(text);
  if (!parsed) return false;

  const { phoneNumber, body } = parsed;

  logger.info(
    { phoneNumber, bodyLength: body.length },
    "SMS requested via Telegram"
  );

  await ctx.replyWithChatAction("typing");

  // Twilio SMS limit is 1600 chars per segment (concatenated SMS)
  if (body.length > 1600) {
    await ctx.reply(
      `Message too long (${body.length} chars). Twilio limit is 1600 characters.`
    );
    return true;
  }

  const result = await sendSms(phoneNumber, body);

  if (result.success) {
    await ctx.reply(`SMS sent to ${phoneNumber}\nSID: \`${result.sid}\``, {
      parse_mode: "Markdown",
    });
  } else {
    await ctx.reply(`SMS failed: ${result.error}`);
  }

  return true;
}
