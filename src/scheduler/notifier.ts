// @ts-ignore
// @ts-ignore
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
  bot: Bot | null,
  chatId: number,
  db: Database.Database,
  result: JobExecutionResult,
  job: RegisteredJob,
  jobRunId?: number
): Promise<void> {
  const isSuccess = result.success;
  const intent = result.notificationIntent ?? (isSuccess ? "user_info" : "failure_alert");

  // Intent-aware suppression: only operational pings honor notifyOnSuccess/Failure flags.
  // decision_request (HITL asks) and failure_alert must always be delivered.
  const isOperationalIntent = intent === "user_info" || intent === "operational_status";
  const shouldNotify = isOperationalIntent
    ? (isSuccess ? job.config.notifyOnSuccess !== false : job.config.notifyOnFailure !== false)
    : true;
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
      deliver: bot ? async () => sendChunkedTelegramMessage({
      bot,
      chatId,
      message,
      parseMode: "HTML",
      enableLinkPreview: isSuccess,
    }) : undefined,
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
