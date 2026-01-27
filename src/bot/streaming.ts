import type { Context } from "grammy";
import { logger } from "../utils/logger.js";

const THINKING_INDICATOR = "🤔 Thinking...";

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
    // Fallback: try to send as a new message
    try {
      await ctx.reply(response.slice(0, MAX_MESSAGE_LENGTH), { parse_mode: "Markdown" });
    } catch {
      // Last resort: send without markdown
      await ctx.reply(response.slice(0, MAX_MESSAGE_LENGTH));
    }
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
