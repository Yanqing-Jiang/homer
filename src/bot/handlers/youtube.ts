/**
 * Telegram YouTube URL Handler
 *
 * Auto-detects bare YouTube URLs in messages, deduplicates,
 * and queues them as overnight youtube_summary tasks.
 */

import type { Context } from "grammy";
import { logger } from "../../utils/logger.js";
import { OvernightTaskStore } from "../../overnight/task-store.js";
import { summaryExists } from "../../youtube/summarizer.js";
import { extractVideoId as extractVideoIdFromUrl } from "../../youtube/utils.js";
import type { StateManager } from "../../state/manager.js";
import type { YouTubeSummaryMetadata } from "../../overnight/types.js";
// @ts-ignore
import type Database from "better-sqlite3";

// ============================================
// STATE
// ============================================

let taskStore: OvernightTaskStore | null = null;
let youtubeDb: Database.Database | null = null;

// ============================================
// INITIALIZATION
// ============================================

export function initializeYouTubeHandler(stateManager: StateManager): void {
  taskStore = new OvernightTaskStore(stateManager.db);
  youtubeDb = stateManager.db;
  logger.info("YouTube URL handler initialized");
}

// ============================================
// URL DETECTION
// ============================================

/** Regex to validate that the entire message is a bare YouTube URL (no surrounding text). */
const BARE_YOUTUBE_URL_REGEX =
  /^(?:https?:\/\/)?(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{11})(?:\S*)$/;

function extractVideoId(text: string): string | null {
  const trimmed = text.trim();
  if (!BARE_YOUTUBE_URL_REGEX.test(trimmed)) return null;
  return extractVideoIdFromUrl(trimmed);
}

function normalizeUrl(videoId: string): string {
  return `https://youtube.com/watch?v=${videoId}`;
}

// ============================================
// MAIN HANDLER
// ============================================

/**
 * Check if a message is a bare YouTube URL and queue it.
 * Returns true if handled, false otherwise.
 */
export async function handleYouTubeUrl(
  ctx: Context,
  text: string
): Promise<boolean> {
  const videoId = extractVideoId(text);
  if (!videoId) return false;

  if (!taskStore) {
    logger.warn("YouTube handler not initialized");
    return false;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return false;

  const videoUrl = normalizeUrl(videoId);

  // Dedup: existing task, DB, or summary file
  const existingTask = taskStore.findTaskByVideoId(videoId);
  if (existingTask) {
    await ctx.reply(`Already queued (${existingTask.status})`);
    return true;
  }
  if (summaryExists(videoId, youtubeDb ?? undefined)) {
    await ctx.reply("Already summarized");
    return true;
  }

  // Queue for nightly processing — capture provenance
  const now = new Date();
  const metadata: YouTubeSummaryMetadata = {
    videoUrl,
    videoId,
    queuedAt: now.toISOString(),
    queueSource: "telegram_bare_url",
    queueLocalHour: now.getHours(),
    queueLocalDow: now.getDay(),
  };
  taskStore.createTask({
    type: "youtube_summary",
    subject: `YouTube: ${videoUrl}`,
    constraints: [],
    iterations: 1,
    chatId,
    messageId: ctx.message?.message_id,
    metadata: JSON.stringify(metadata),
  });

  await ctx.reply("Queued for tonight");
  logger.info({ videoId, videoUrl }, "YouTube video queued");
  return true;
}
