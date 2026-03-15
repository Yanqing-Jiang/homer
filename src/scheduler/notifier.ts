import type Database from "better-sqlite3";
import type { Bot } from "grammy";
import { logger } from "../utils/logger.js";
import {
  formatScheduledTelegramHtml,
  routeTelegramNotification,
  sendChunkedTelegramMessage,
} from "../notifications/telegram-router.js";
import type { JobExecutionResult, RegisteredJob } from "./types.js";
import { escapeHtml } from "../utils/telegram-format.js";

/**
 * Escape HTML special characters
 */

/**
 * Send job execution result to Telegram
 * Uses HTML formatting for better compatibility
 */
export async function notifyJobResult(
  bot: Bot,
  chatId: number,
  db: Database.Database,
  result: JobExecutionResult,
  job: RegisteredJob,
  jobRunId?: number
): Promise<void> {
  const isSuccess = result.success;
  const shouldNotify = isSuccess
    ? job.config.notifyOnSuccess !== false
    : job.config.notifyOnFailure !== false;

  const intent = result.notificationIntent ?? (isSuccess ? "user_info" : "failure_alert");
  const rawMessage = isSuccess
    ? result.output
    : `❌ <b>${escapeHtml(job.config.name)}</b> failed\n\n${escapeHtml(result.error || "Unknown error")}`;
  const message = formatScheduledTelegramHtml(rawMessage);

  if (!shouldNotify) {
    logger.debug(
      { jobId: result.jobId, success: result.success },
      "Skipping notification per job config"
    );
    await routeTelegramNotification({
      db,
      sourceType: "scheduler_job",
      sourceId: result.jobId,
      jobRunId,
      intent,
      title: job.config.name,
      messageText: message,
      reason: isSuccess ? "success_notifications_disabled" : "failure_notifications_disabled",
    });
    return;
  }

  if (result.sideEffectDelivered) {
    await routeTelegramNotification({
      db,
      sourceType: "scheduler_job",
      sourceId: result.jobId,
      jobRunId,
      intent,
      title: job.config.name,
      messageText: message,
      reason: "handled_by_direct_side_effect",
    });
    return;
  }

  await routeTelegramNotification({
    db,
    sourceType: "scheduler_job",
    sourceId: result.jobId,
    jobRunId,
    intent,
    title: job.config.name,
    messageText: message,
    deliver: async () => sendChunkedTelegramMessage({
      bot,
      chatId,
      message,
      parseMode: "HTML",
      enableLinkPreview: isSuccess,
    }),
  });
}

/**
 * Send a simple notification message
 */
export async function sendNotification(
  bot: Bot,
  chatId: number,
  message: string
): Promise<void> {
  await sendChunkedTelegramMessage({
    bot,
    chatId,
    message,
    parseMode: "HTML",
    enableLinkPreview: false,
  });
}
