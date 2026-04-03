/**
 * Telegram Phone Call Handler
 *
 * Detects "call XXX" patterns in messages and triggers
 * ElevenLabs outbound calls via their API.
 */

import type { Context } from "grammy";
import { logger } from "../../utils/logger.js";
import { config } from "../../config/index.js";
import { HOMER_AGENT_ID } from "../../telephony/constants.js";

// ElevenLabs agent config
const HOMER_PHONE_NUMBER_ID = "phnum_2201kj0h93swfpyafb3jdssn9pw5";
const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

// Pattern: "call +1XXXXXXXXXX", "call 2709789240", "call (270) 978-9240"
// Also matches: "call xxx and introduce yourself", "call xxx and tell them about..."
const CALL_PATTERN = /^call\s+(\+?1?\s*[-.()\s]*\d[\d\s\-().]*\d)/i;
const PHONE_DIGITS = /\d/g;

/**
 * Check if a message is a phone call request.
 * Returns the cleaned phone number or null.
 */
export function parseCallRequest(text: string): string | null {
  const match = text.match(CALL_PATTERN);
  if (!match) return null;

  const raw = match[1] ?? "";
  const digits = raw.match(PHONE_DIGITS)?.join("") ?? "";

  // Must be 10 or 11 digits
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return null;
}

/**
 * Extract optional instructions from the call request.
 * e.g., "call 2709789240 and introduce yourself" → "introduce yourself"
 */
export function parseCallInstructions(text: string): string | null {
  // Remove the "call <number>" part, look for "and ..." or remaining text
  const withoutCall = text.replace(CALL_PATTERN, "").trim();
  if (!withoutCall) return null;

  // Strip leading "and" or ","
  const instructions = withoutCall.replace(/^(and|,)\s*/i, "").trim();
  return instructions || null;
}

interface OutboundCallResult {
  success: boolean;
  conversationId?: string;
  callSid?: string;
  error?: string;
}

/**
 * Initiate an outbound call via ElevenLabs API.
 */
async function makeOutboundCall(toNumber: string): Promise<OutboundCallResult> {
  const apiKey = config.voice.elevenLabsApiKey;
  if (!apiKey) {
    return { success: false, error: "ElevenLabs API key not configured" };
  }

  try {
    const response = await fetch(
      `${ELEVENLABS_API_BASE}/convai/twilio/outbound-call`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agent_id: HOMER_AGENT_ID,
          agent_phone_number_id: HOMER_PHONE_NUMBER_ID,
          to_number: toNumber,
          first_message: "Hey! This is Homer, Yanqing's AI assistant. He asked me to give you a call. How's it going?",
        }),
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error({ status: response.status, body: errorBody }, "ElevenLabs outbound call failed");
      return { success: false, error: `API error ${response.status}: ${errorBody}` };
    }

    const data = await response.json() as Record<string, unknown>;
    return {
      success: true,
      conversationId: data.conversation_id as string,
      callSid: data.call_sid as string,
    };
  } catch (error) {
    logger.error({ error }, "Failed to initiate outbound call");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Handle a phone call request from Telegram.
 * Returns true if the message was handled as a call request.
 */
export async function handleCallRequest(ctx: Context, text: string): Promise<boolean> {
  const phoneNumber = parseCallRequest(text);
  if (!phoneNumber) return false;

  const instructions = parseCallInstructions(text);

  logger.info({ phoneNumber, instructions }, "Phone call requested via Telegram");

  await ctx.replyWithChatAction("typing");
  await ctx.reply(`Calling ${phoneNumber}...${instructions ? `\n_${instructions}_` : ""}`, {
    parse_mode: "Markdown",
  });

  const result = await makeOutboundCall(phoneNumber);

  if (result.success) {
    await ctx.reply(
      `Call connected.\n` +
      `Conversation: \`${result.conversationId}\``,
      { parse_mode: "Markdown" }
    );
  } else {
    await ctx.reply(`Call failed: ${result.error}`);
  }

  return true;
}
