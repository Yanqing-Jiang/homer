import type { Bot } from "grammy";
import { logger } from "../utils/logger.js";
import { chunkMessage } from "../utils/chunker.js";
import type { JobExecutionResult, RegisteredJob } from "./types.js";

const MAX_OUTPUT_LENGTH = 4000; // Telegram limit is 4096

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Send job execution result to Telegram
 * Uses HTML formatting for better compatibility
 */
export async function notifyJobResult(
  bot: Bot,
  chatId: number,
  result: JobExecutionResult,
  job: RegisteredJob
): Promise<void> {
  const shouldNotify = result.success
    ? job.config.notifyOnSuccess !== false
    : job.config.notifyOnFailure !== false;

  if (!shouldNotify) {
    logger.debug(
      { jobId: result.jobId, success: result.success },
      "Skipping notification per job config"
    );
    return;
  }

  // For successful jobs, send output directly (already formatted by Claude)
  // For failed jobs, add error context
  if (result.success) {
    await sendMessage(bot, chatId, result.output, true);
  } else {
    const errorMsg = `❌ <b>${escapeHtml(job.config.name)}</b> failed\n\n${escapeHtml(result.error || "Unknown error")}`;
    await sendMessage(bot, chatId, errorMsg, false);
  }
}

/**
 * Send a message to Telegram with HTML formatting
 */
async function sendMessage(
  bot: Bot,
  chatId: number,
  message: string,
  enableLinkPreview: boolean
): Promise<void> {
  // Truncate if needed
  let text = message;
  if (text.length > MAX_OUTPUT_LENGTH) {
    text = text.slice(0, MAX_OUTPUT_LENGTH - 20) + "\n\n<i>(truncated)</i>";
  }

  const chunks = chunkMessage(text);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i] ?? "";
    if (!chunk) continue;

    // Only enable link preview for last chunk
    const showPreview = enableLinkPreview && i === chunks.length - 1;

    try {
      await bot.api.sendMessage(chatId, chunk, {
        parse_mode: "HTML",
        link_preview_options: showPreview
          ? { is_disabled: false, prefer_large_media: true }
          : { is_disabled: true },
      });
    } catch (error) {
      // Retry without HTML if parsing fails
      logger.debug({ error }, "HTML failed, trying plain");
      try {
        await bot.api.sendMessage(chatId, chunk.replace(/<[^>]*>/g, ""), {
          link_preview_options: { is_disabled: true },
        });
      } catch (plainError) {
        logger.error({ error: plainError }, "Failed to send notification");
      }
    }
  }
}

/**
 * Send a simple notification message
 */
export async function sendNotification(
  bot: Bot,
  chatId: number,
  message: string
): Promise<void> {
  await sendMessage(bot, chatId, message, false);
}
