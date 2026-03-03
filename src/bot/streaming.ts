import type { Context, Api } from "grammy";
import { chunkMessage } from "../utils/chunker.js";
import { logger } from "../utils/logger.js";

/**
 * Streams partial content to Telegram using the sendMessageDraft API (Bot API 9.3+).
 * Draft messages appear as animated typing bubbles — no "sent" message that keeps mutating.
 * Falls back gracefully: if the first sendMessageDraft call fails, disables itself
 * and the caller just sends a normal final message.
 */
export class TelegramDraftStream {
  private chatId: number;
  private draftId: number;
  private bot: Api;
  private lastSendTime = 0;
  private pendingText = "";
  private throttleMs: number;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private inflight: Promise<void> | null = null;
  private disabled = false;

  constructor(chatId: number, draftId: number, bot: Api, throttleMs = 500) {
    this.chatId = chatId;
    this.draftId = draftId;
    this.bot = bot;
    this.throttleMs = throttleMs;
  }

  /** Replace displayed draft text with cumulative content from stream */
  update(text: string): void {
    if (this.stopped || this.disabled) return;
    this.pendingText = text;
    this.scheduleSend();
  }

  private scheduleSend(): void {
    if (this.stopped || this.disabled || this.timer) return;
    const elapsed = Date.now() - this.lastSendTime;
    const delay = Math.max(0, this.throttleMs - elapsed);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inflight = this.doSend();
      this.inflight.finally(() => { this.inflight = null; });
    }, delay);
  }

  private async doSend(): Promise<void> {
    if (this.stopped || this.disabled || !this.pendingText) return;

    // Truncate to Telegram limit, append cursor indicator
    const display = this.pendingText.length > 4000
      ? this.pendingText.slice(0, 4000) + "\n\n▍"
      : this.pendingText + "\n\n▍";

    try {
      await this.bot.sendMessageDraft(this.chatId, this.draftId, display);
      this.lastSendTime = Date.now();
    } catch (error) {
      // First failure → disable gracefully. The final message will still be sent normally.
      logger.warn({ error }, "sendMessageDraft failed, disabling draft streaming");
      this.disabled = true;
    }
  }

  /** Stop and await any in-flight send. Call before sending the final message. */
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
}

/**
 * Send the final response as fresh message(s), with Markdown formatting.
 * Handles chunking for responses exceeding Telegram's 4096-char limit.
 */
export async function sendFinalResponse(ctx: Context, response: string): Promise<void> {
  const chunks = chunkMessage(response);
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, { parse_mode: "Markdown" });
    } catch {
      // Fallback: send without markdown (unclosed formatting, etc.)
      await ctx.reply(chunk);
    }
  }
}
