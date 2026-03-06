import type { Context, Api } from "grammy";
import { logger } from "../utils/logger.js";

const THINKING_INDICATOR = "🤔 Thinking...";

/** Escape characters that break Telegram Markdown v1 parsing */
function escapeMarkdown(text: string): string {
  // Only escape characters that Telegram treats as Markdown control chars
  return text.replace(/([_*`\[])/g, "\\$1");
}

/**
 * Progressive Telegram message updater — replaces "Thinking..." with
 * incremental content as CLI executor streams tokens.
 * Throttles editMessageText calls to avoid Telegram 429 rate limits.
 */
export class TelegramDraftStream {
  private messageId: number | undefined;
  private chatId: number;
  private bot: Api;
  private lastEditTime = 0;
  private pendingText = "";
  private throttleMs: number;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private inflight: Promise<void> | null = null;

  constructor(chatId: number, bot: Api, initialMessageId?: number, throttleMs = 1000) {
    this.chatId = chatId;
    this.bot = bot;
    this.messageId = initialMessageId;
    this.throttleMs = throttleMs;
  }

  /** Replace displayed text with cumulative content from stream */
  update(text: string): void {
    if (this.stopped) return;
    this.pendingText = text;
    this.scheduleEdit();
  }

  private scheduleEdit(): void {
    if (this.stopped || this.timer) return;
    const elapsed = Date.now() - this.lastEditTime;
    const delay = Math.max(0, this.throttleMs - elapsed);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inflight = this.doEdit();
      this.inflight.finally(() => { this.inflight = null; });
    }, delay);
  }

  private async doEdit(): Promise<void> {
    if (this.stopped || !this.pendingText) return;

    // Truncate to Telegram limit, append cursor indicator
    const display = this.pendingText.length > 4000
      ? this.pendingText.slice(0, 4000) + "\n\n▍"
      : this.pendingText + "\n\n▍";

    try {
      if (!this.messageId) {
        const msg = await this.bot.sendMessage(this.chatId, display);
        this.messageId = msg.message_id;
      } else {
        // No parse_mode — partial content may have unclosed markdown
        await this.bot.editMessageText(this.chatId, this.messageId, display);
      }
      this.lastEditTime = Date.now();
    } catch (error) {
      const msg = error instanceof Error ? error.message : "";
      if (!msg.includes("not modified")) {
        logger.debug({ error }, "Draft stream edit failed");
      }
    }
  }

  /** Stop and await any in-flight edit. Call before final editWithResponse(). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inflight) {
      await this.inflight;
    }
  }

  getMessageId(): number | undefined {
    return this.messageId;
  }
}

export interface StreamingMessage {
  chatId: number;
  messageId: number;
  sentAt: number;
}

/**
 * Send a "thinking" indicator message that will be edited with the final response
 */
export async function sendThinkingIndicator(ctx: Context): Promise<StreamingMessage | null> {
  try {
    const message = await ctx.reply(THINKING_INDICATOR);
    return {
      chatId: message.chat.id,
      messageId: message.message_id,
      sentAt: Date.now(),
    };
  } catch (error) {
    logger.error({ error }, "Failed to send thinking indicator");
    return null;
  }
}

/**
 * Edit a message with the final response, handling Telegram's character limit
 */
export async function editWithResponse(
  ctx: Context,
  streamingMsg: StreamingMessage,
  response: string
): Promise<void> {
  const MAX_MESSAGE_LENGTH = 4096;

  try {
    if (response.length <= MAX_MESSAGE_LENGTH) {
      await ctx.api.editMessageText(
        streamingMsg.chatId,
        streamingMsg.messageId,
        response,
        { parse_mode: "Markdown" }
      );
    } else {
      // For long responses, edit with first chunk then send remaining as new messages
      const firstChunk = truncateAtSafePoint(response, MAX_MESSAGE_LENGTH - 20);
      const remaining = response.slice(firstChunk.length).trim();

      await ctx.api.editMessageText(
        streamingMsg.chatId,
        streamingMsg.messageId,
        firstChunk + "\n\n_(continued...)_",
        { parse_mode: "Markdown" }
      );

      // Send remaining chunks as new messages
      await sendChunkedMessages(ctx, remaining);
    }
  } catch (error) {
    logger.error({ error }, "Failed to edit message with response");
    // Fallback: escape Markdown and retry, then plain text as last resort
    try {
      await ctx.reply(escapeMarkdown(response).slice(0, MAX_MESSAGE_LENGTH), { parse_mode: "Markdown" });
    } catch {
      try {
        await ctx.reply(response.slice(0, MAX_MESSAGE_LENGTH));
      } catch (finalErr) {
        logger.error({ error: finalErr }, "All attempts to send response failed");
      }
    }
  }
}

/**
 * Send the final response as fresh message(s), with Markdown formatting.
 * Used as fallback when no streaming message exists to edit.
 */
export async function sendFinalResponse(ctx: Context, response: string): Promise<void> {
  const MAX_MESSAGE_LENGTH = 4096;
  if (response.length <= MAX_MESSAGE_LENGTH) {
    try {
      await ctx.reply(response, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(response);
    }
  } else {
    await sendChunkedMessages(ctx, response);
  }
}

/**
 * Send chunked messages for long responses
 */
async function sendChunkedMessages(ctx: Context, text: string): Promise<void> {
  const MAX_MESSAGE_LENGTH = 4096;
  let remaining = text;

  while (remaining.length > 0) {
    const chunk = truncateAtSafePoint(remaining, MAX_MESSAGE_LENGTH);
    remaining = remaining.slice(chunk.length).trim();

    try {
      await ctx.reply(chunk, { parse_mode: "Markdown" });
    } catch {
      // Fallback without markdown
      await ctx.reply(chunk);
    }

    // Small delay to avoid rate limiting
    if (remaining.length > 0) {
      await sleep(100);
    }
  }
}

/**
 * Truncate text at a safe point (paragraph, line, sentence, word boundary)
 */
function truncateAtSafePoint(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  const chunk = text.slice(0, maxLength);

  // Try to find a good break point
  const breakPoints = [
    chunk.lastIndexOf("\n\n"), // Paragraph
    chunk.lastIndexOf("\n"),   // Line
    chunk.lastIndexOf(". "),   // Sentence
    chunk.lastIndexOf("! "),
    chunk.lastIndexOf("? "),
    chunk.lastIndexOf(" "),    // Word
  ];

  for (const bp of breakPoints) {
    if (bp > maxLength * 0.5) {
      return text.slice(0, bp + 1);
    }
  }

  // No good break point, hard cut
  return chunk;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
