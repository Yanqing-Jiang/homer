import type { Bot } from "grammy";
import { logger } from "../utils/logger.js";
import { chunkMessage } from "../utils/chunker.js";
import type { JobExecutionResult, RegisteredJob } from "./types.js";

const MAX_OUTPUT_LENGTH = 3500; // Leave room for formatting

/**
 * Send job execution result to Telegram
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

  const message = formatJobResult(result);
  await sendMessage(bot, chatId, message);
}

/**
 * Format job result for Telegram
 */
function formatJobResult(result: JobExecutionResult): string {
  const icon = result.success ? "✅" : "❌";
  const status = result.success ? "completed" : "failed";
  const duration = formatDuration(result.duration);

  let message = `${icon} *${escapeMarkdown(result.jobName)}* ${status}\n`;
  message += `_Duration: ${duration}_\n\n`;

  if (result.success) {
    // Truncate output if too long
    let output = result.output;
    if (output.length > MAX_OUTPUT_LENGTH) {
      output = output.slice(0, MAX_OUTPUT_LENGTH) + "\n\n... (truncated)";
    }
    message += output;
  } else {
    message += `*Error:* ${escapeMarkdown(result.error || "Unknown error")}`;
    if (result.output && result.output !== "(No output)") {
      let output = result.output;
      if (output.length > MAX_OUTPUT_LENGTH / 2) {
        output = output.slice(0, MAX_OUTPUT_LENGTH / 2) + "\n\n... (truncated)";
      }
      message += `\n\n*Output:*\n${output}`;
    }
  }

  return message;
}

/**
 * Format duration in human-readable format
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Escape Markdown special characters
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}

/**
 * Send a message to Telegram, handling chunking and errors
 */
async function sendMessage(bot: Bot, chatId: number, message: string): Promise<void> {
  const chunks = chunkMessage(message);

  for (const chunk of chunks) {
    try {
      await bot.api.sendMessage(chatId, chunk, {
        parse_mode: "Markdown",
      });
    } catch (error) {
      // Retry without markdown if parsing fails
      logger.debug({ error }, "Markdown parsing failed, retrying plain text");
      try {
        await bot.api.sendMessage(chatId, chunk.replace(/[_*`[\]]/g, ""));
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
  await sendMessage(bot, chatId, message);
}
