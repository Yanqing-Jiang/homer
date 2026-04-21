import type { Context } from "grammy";
import { logger } from "../../utils/logger.js";
import { callPerson } from "../../telephony/outbound-call.js";
import type { StateManager } from "../../state/manager.js";

const CALL_PATTERN = /^call\s+(?:([a-zA-Z][a-zA-Z\s'.-]{0,40}?)\s+at\s+)?(\+?1?\s*[-.()\s]*\d[\d\s\-().]*\d)(.*)$/i;
const PHONE_DIGITS = /\d/g;

export interface ParsedCallIntent {
  toNumber: string;
  recipientName?: string;
  callPurpose: string;
}

export function parseCallRequest(text: string): string | null {
  const match = text.match(CALL_PATTERN);
  if (!match) return null;
  const raw = match[2] ?? "";
  const digits = raw.match(PHONE_DIGITS)?.join("") ?? "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function parseCallIntent(text: string): ParsedCallIntent | null {
  const match = text.match(CALL_PATTERN);
  if (!match) return null;

  const raw = match[2] ?? "";
  const digits = raw.match(PHONE_DIGITS)?.join("") ?? "";
  let toNumber: string;
  if (digits.length === 10) toNumber = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) toNumber = `+${digits}`;
  else return null;

  const recipientName = match[1]?.trim() || undefined;

  let tail = (match[3] ?? "").trim();
  tail = tail.replace(/^[,.]+/, "").trim();
  tail = tail.replace(/^(and\s+)?(tell|say to|let)\s+(him|her|them|\w+)\s+(know\s+)?(that\s+)?/i, "");
  tail = tail.replace(/^(and\s+)?(tell|say|let\s+them\s+know|mention)\s+(that\s+)?/i, "");
  tail = tail.replace(/^(and\s+)?/i, "");
  tail = tail.replace(/^(that\s+)/i, "");
  tail = tail.trim();

  return {
    toNumber,
    recipientName,
    callPurpose: tail,
  };
}

export async function handleCallRequest(
  ctx: Context,
  text: string,
  stateManager: StateManager,
): Promise<boolean> {
  const intent = parseCallIntent(text);
  if (!intent) return false;

  if (!intent.callPurpose) {
    await ctx.reply(
      "I need a purpose for the call — what should I tell them?\n\n" +
        "Example: `call " +
        intent.toNumber.replace(/^\+1/, "") +
        " and tell him dinner is at 5:30 tonight`",
      { parse_mode: "Markdown" },
    );
    return true;
  }

  const messageId = ctx.message?.message_id;
  logger.info(
    {
      toNumber: intent.toNumber,
      recipientName: intent.recipientName,
      purposeLen: intent.callPurpose.length,
    },
    "Phone call requested via Telegram",
  );

  await ctx.replyWithChatAction("typing");
  await ctx.reply(
    `Calling ${intent.toNumber}${intent.recipientName ? ` (${intent.recipientName})` : ""}...\n_${intent.callPurpose}_`,
    { parse_mode: "Markdown" },
  );

  const result = await callPerson(
    {
      toNumber: intent.toNumber,
      callPurpose: intent.callPurpose,
      recipientName: intent.recipientName,
      source: "telegram",
      sourceRef: messageId ? String(messageId) : undefined,
    },
    stateManager,
  );

  if (result.status === "dialing") {
    await ctx.reply(
      `Call connected.\nConversation: \`${result.conversationId}\`\nIntent: \`${result.intentId}\``,
      { parse_mode: "Markdown" },
    );
  } else {
    await ctx.reply(`Call failed: ${result.error}`);
  }

  return true;
}
