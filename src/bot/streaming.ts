import type { Context, Api } from "grammy";
import { logger } from "../utils/logger.js";
import { balanceHtmlTags, mdToTelegramHtml, chunkForTelegram } from "../utils/telegram-format.js";

const THINKING_INDICATOR = "🤔 Thinking...";

/**
 * Maintains the "typing" status in Telegram during long generations.
 * Telegram typing indicators expire after 5 seconds.
 */
export class TelegramTypingLoop {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private chatId: number;
  private bot: Api;

  constructor(chatId: number, bot: Api) {
    this.chatId = chatId;
    this.bot = bot;
  }

  start(): void {
    if (this.stopped) return;
    this.send();
  }

  private send(): void {
    if (this.stopped) return;
    
    // Fire and forget chat action
    this.bot.sendChatAction(this.chatId, "typing").catch((err) => {
      logger.debug({ err, chatId: this.chatId }, "Failed to send typing chat action");
    });

    this.timer = setTimeout(() => {
      this.send();
    }, 4000); // Repeat every 4 seconds
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
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
  private lastDisplayedLength = 0;
  private pendingText = "";
  private throttleMs: number;
  private minCharDelta: number;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private inflight: Promise<void> | null = null;

  constructor(chatId: number, bot: Api, initialMessageId?: number, throttleMs = 800) {
    this.chatId = chatId;
    this.bot = bot;
    this.messageId = initialMessageId;
    this.throttleMs = throttleMs;
    this.minCharDelta = 20; // Only edit if at least 20 chars added
  }

  /** Replace displayed text with cumulative content from stream */
  update(text: string): void {
    if (this.stopped) return;
    this.pendingText = text;
    this.scheduleEdit();
  }

  private scheduleEdit(): void {
    if (this.stopped || this.timer) return;

    const charDelta = this.pendingText.length - this.lastDisplayedLength;
    const elapsed = Date.now() - this.lastEditTime;

    // Buffer edits: either enough characters accumulated OR enough time passed
    // AND always throttle by throttleMs to avoid 429s
    if (charDelta < this.minCharDelta && elapsed < 2000) {
      // Not enough delta yet, and it hasn't been that long (2s)
      // We'll wait for more tokens or the next update call
      return;
    }

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
    const raw = this.pendingText.length > 3900
      ? this.pendingText.slice(0, 3900)
      : this.pendingText;

    // Convert to HTML and balance unclosed tags so parse_mode works mid-stream
    const asHtml = mdToTelegramHtml(raw);
    const display = balanceHtmlTags(asHtml) + " ▌";

    try {
      if (!this.messageId) {
        const msg = await this.bot.sendMessage(this.chatId, display, { parse_mode: "HTML" });
        this.messageId = msg.message_id;
      } else {
        await this.bot.editMessageText(this.chatId, this.messageId, display, { parse_mode: "HTML" });
      }
      this.lastEditTime = Date.now();
      this.lastDisplayedLength = this.pendingText.length;
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
  const html = mdToTelegramHtml(response);
  const chunks = chunkForTelegram(html);

  try {
    // Edit the thinking message with first chunk
    await ctx.api.editMessageText(
      streamingMsg.chatId,
      streamingMsg.messageId,
      chunks[0] + (chunks.length > 1 ? "\n\n<i>(continued...)</i>" : ""),
      { parse_mode: "HTML" }
    );

    // Send remaining chunks as new messages
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      await sleep(100);
      await ctx.reply(chunk, { parse_mode: "HTML" }).catch(() =>
        ctx.reply(chunk) // fallback: no formatting
      );
    }
  } catch (error) {
    logger.error({ error }, "Failed to edit message with HTML response");
    // Fallback: plain text, no formatting
    try {
      await ctx.reply(response.slice(0, 4096));
    } catch (finalErr) {
      logger.error({ error: finalErr }, "All attempts to send response failed");
    }
  }
}

/**
 * Send the final response as fresh message(s), with Markdown formatting.
 * Used as fallback when no streaming message exists to edit.
 */
export async function sendFinalResponse(ctx: Context, response: string): Promise<void> {
  const html = mdToTelegramHtml(response);
  const chunks = chunkForTelegram(html);

  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } catch {
      await ctx.reply(chunk); // fallback: no formatting
    }
    if (chunks.length > 1) await sleep(100);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
