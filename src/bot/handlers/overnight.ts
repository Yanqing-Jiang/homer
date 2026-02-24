/**
 * Telegram Overnight Work Handlers
 *
 * Handles overnight work requests via Telegram:
 * - Pattern detection for overnight triggers
 * - Clarification flow with inline buttons
 * - Callback handlers for morning choices
 * - Milestone notifications
 */

import { Bot, InlineKeyboard, type Context } from "grammy";
import { logger } from "../../utils/logger.js";
import type { StateManager } from "../../state/manager.js";
import {
  parseOvernightIntent,
  mightBeOvernightRequest,
  getTaskTypeDisplay,
} from "../../overnight/intent-parser.js";
import { OvernightTaskStore } from "../../overnight/task-store.js";
import { MorningPresenter } from "../../overnight/morning-presenter.js";
import { decodeCallbackData, type OvernightTaskType, type YouTubeSummaryMetadata } from "../../overnight/types.js";
import type { ApproachLabel } from "../../overnight/types.js";
import { markSummaryReviewedV2, summaryFileExists, getYouTubeVideoFromDb } from "../../youtube/summarizer.js";
import { saveIdeaFile, type ParsedIdea } from "../../ideas/parser.js";
import * as dao from "../../ideas/dao.js";
import { readFileSync } from "fs";
import {
  recordFeedback,
  createReviewSession,
  completeReviewSession,
  recordImpression,
} from "../../feedback/events.js";
import { updatePreferences, type PreferenceSignal } from "../../preferences/engine.js";

// ============================================
// STATE
// ============================================

let taskStore: OvernightTaskStore | null = null;
let morningPresenter: MorningPresenter | null = null;
let overnightStateManager: StateManager | null = null;

// Pending clarifications (chatId -> partial task data)
interface PendingClarification {
  chatId: number;
  subject: string;
  constraints: string[];
  rawMessage: string;
  messageId: number;
  createdAt: number;
}

// pending clarification messageId -> data
const pendingClarifications = new Map<number, PendingClarification>();

// Track impressions for feedback event linking (taskId -> impression data)
interface ImpressionRecord {
  impressionId: number;
  displayedAt: number;
}
const pendingImpressions = new Map<string, ImpressionRecord>();

// Cleanup stale clarifications every 5 minutes
setInterval(() => {
  const staleThreshold = Date.now() - 3600000; // 1 hour
  for (const [msgId, pending] of pendingClarifications.entries()) {
    if (pending.createdAt < staleThreshold) {
      pendingClarifications.delete(msgId);
      logger.debug({ chatId: pending.chatId }, "Cleaned up stale overnight clarification");
    }
  }
  // Expire impression records older than 24 hours
  const impressionStaleThreshold = Date.now() - 86400000;
  for (const [taskId, record] of pendingImpressions.entries()) {
    if (record.displayedAt < impressionStaleThreshold) {
      pendingImpressions.delete(taskId);
    }
  }
}, 300000);

// ============================================
// TASK SPLITTING
// ============================================

function splitOvernightTasks(message: string): string[] {
  const trimmed = message.trim();
  if (!trimmed) return [];

  const lines = trimmed.split("\n");
  const bulletLines = lines
    .map((l) => l.trim())
    .filter((l) => l.match(/^[-*•]\s+/) || l.match(/^\d+\.\s+/))
    .map((l) => l.replace(/^[-*•]\s+/, "").replace(/^\d+\.\s+/, "").trim())
    .filter(Boolean);

  if (bulletLines.length >= 2) {
    return bulletLines;
  }

  if (trimmed.includes(";")) {
    return trimmed.split(";").map((s) => s.trim()).filter(Boolean);
  }

  // Split on " and " when it looks like two actions
  if (/\b(and)\b/i.test(trimmed) && /(work on|research|investigate|build|implement)/i.test(trimmed)) {
    const parts = trimmed.split(/\band\b/i).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) return parts;
  }

  return [trimmed];
}

// ============================================
// INITIALIZATION
// ============================================

export function initializeOvernightHandlers(stateManager: StateManager): void {
  overnightStateManager = stateManager;
  taskStore = new OvernightTaskStore(stateManager.db);
  morningPresenter = new MorningPresenter(taskStore);
  logger.info("Overnight handlers initialized");
}

// ============================================
// MESSAGE HANDLER
// ============================================

/**
 * Check if a message is an overnight request and handle it.
 * Returns true if the message was handled, false otherwise.
 */
export async function handleOvernightMessage(
  ctx: Context,
  message: string
): Promise<boolean> {
  // Quick check first
  if (!mightBeOvernightRequest(message)) {
    return false;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return false;

  const tasks = splitOvernightTasks(message);
  if (tasks.length === 0) return false;

  let handled = false;

  for (const taskMessage of tasks) {
    const intent = parseOvernightIntent(taskMessage, true);
    if (!intent.isOvernight) {
      continue;
    }

    logger.info(
      { chatId, subject: intent.subject, type: intent.taskType, confidence: intent.confidence },
      "Detected overnight work request"
    );

    if (intent.clarificationNeeded) {
      await handleClarificationRequest(ctx, intent);
      handled = true;
      continue;
    }

    if (intent.taskType && intent.subject) {
      await queueOvernightTask(ctx, intent.taskType, intent.subject, intent.constraints);
      handled = true;
    }
  }

  return handled;
}

// ============================================
// CLARIFICATION HANDLING
// ============================================

async function handleClarificationRequest(
  ctx: Context,
  intent: ReturnType<typeof parseOvernightIntent>
): Promise<void> {
  const clarification = intent.clarificationNeeded!;
  const chatId = ctx.chat!.id;

  // Build inline keyboard
  const keyboard = new InlineKeyboard();
  for (const option of clarification.options) {
    keyboard.text(option.label, `overnight_clarify:${option.value}`).row();
  }

  const sent = await ctx.reply(clarification.question, {
    reply_markup: keyboard,
    reply_to_message_id: ctx.message?.message_id,
  });

  // Store pending clarification by clarification message ID
  pendingClarifications.set(sent.message_id, {
    chatId,
    subject: intent.subject || intent.rawMessage,
    constraints: intent.constraints,
    rawMessage: intent.rawMessage,
    messageId: sent.message_id,
    createdAt: Date.now(),
  });
}

// ============================================
// TASK QUEUEING
// ============================================

async function queueOvernightTask(
  ctx: Context,
  type: OvernightTaskType,
  subject: string,
  constraints: string[]
): Promise<void> {
  if (!taskStore) {
    await ctx.reply("❌ Overnight system not initialized.");
    return;
  }

  const chatId = ctx.chat!.id;
  const messageId = ctx.message?.message_id;

  // Create task
  const task = taskStore.createTask({
    type,
    subject,
    constraints,
    chatId,
    messageId,
  });

  // Build confirmation message
  const typeDisplay = getTaskTypeDisplay(type);
  let confirmMessage = `🔨 *Overnight Task Queued*\n\n`;
  confirmMessage += `*Type:* ${typeDisplay}\n`;
  confirmMessage += `*Subject:* ${subject}\n`;

  if (type === "prototype_work") {
    confirmMessage += `*Approaches:* 3 (Conservative, Innovative, Pragmatic)\n`;
  } else {
    confirmMessage += `*Method:* Query expansion + parallel harvest + synthesis\n`;
  }

  if (constraints.length > 0) {
    confirmMessage += `*Constraints:* ${constraints.join(", ")}\n`;
  }

  confirmMessage += `\nI'll work on this tonight and have options ready by 7 AM.\n\n`;
  confirmMessage += `Task ID: \`${task.id}\``;

  await ctx.reply(confirmMessage, { parse_mode: "Markdown" });

  logger.info({ taskId: task.id, type, subject }, "Overnight task queued");
}

// ============================================
// CALLBACK HANDLERS
// ============================================

export function registerOvernightCallbacks(bot: Bot): void {
  // Clarification responses
  bot.callbackQuery(/^overnight_clarify:/, async (ctx) => {
    const value = ctx.callbackQuery.data.replace("overnight_clarify:", "");
    const msgId = ctx.callbackQuery.message?.message_id;
    if (!msgId) {
      await ctx.answerCallbackQuery({ text: "Clarification expired" });
      return;
    }

    const pending = pendingClarifications.get(msgId);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Clarification expired" });
      return;
    }

    pendingClarifications.delete(msgId);
    await ctx.answerCallbackQuery();

    // Handle different clarification values
    if (value === "cancel") {
      await ctx.editMessageText("✗ Overnight task cancelled.");
      return;
    }

    if (value === "prototype_work" || value === "research_dive") {
      // User selected task type
      await ctx.editMessageText("✓ Got it!");
      await queueOvernightTask(
        ctx,
        value as OvernightTaskType,
        pending.subject,
        pending.constraints
      );
      return;
    }

    if (value === "confirm") {
      // User confirmed current interpretation
      // Need to detect type again
      const intent = parseOvernightIntent(pending.rawMessage, true);
      if (intent.taskType) {
        await ctx.editMessageText("✓ Confirmed!");
        await queueOvernightTask(ctx, intent.taskType, pending.subject, pending.constraints);
      } else {
        await ctx.editMessageText("❓ Please specify the task type.");
      }
      return;
    }

    if (value === "modify" || value === "describe") {
      await ctx.editMessageText("Please describe what you'd like me to work on tonight.");
      return;
    }
  });

  // Morning choice selection
  bot.callbackQuery(/^overnight:select:/, async (ctx) => {
    const data = decodeCallbackData(ctx.callbackQuery.data);
    if (!data) {
      await ctx.answerCallbackQuery({ text: "Invalid selection" });
      return;
    }

    await handleSelection(ctx, data.taskId, data.option as ApproachLabel);
  });

  // Compare all options
  bot.callbackQuery(/^overnight:compare:/, async (ctx) => {
    const data = decodeCallbackData(ctx.callbackQuery.data);
    if (!data) {
      await ctx.answerCallbackQuery({ text: "Invalid request" });
      return;
    }

    await handleCompare(ctx, data.taskId);
  });

  // Skip selection
  bot.callbackQuery(/^overnight:skip:/, async (ctx) => {
    const data = decodeCallbackData(ctx.callbackQuery.data);
    if (!data) {
      await ctx.answerCallbackQuery({ text: "Invalid request" });
      return;
    }

    await handleSkip(ctx, data.taskId);
  });

  // Approve summary
  bot.callbackQuery(/^overnight:approve:/, async (ctx) => {
    const data = decodeCallbackData(ctx.callbackQuery.data);
    if (!data) {
      await ctx.answerCallbackQuery({ text: "Invalid request" });
      return;
    }
    await handleApprove(ctx, data.taskId);
  });

  // Archive summary
  bot.callbackQuery(/^overnight:archive:/, async (ctx) => {
    const data = decodeCallbackData(ctx.callbackQuery.data);
    if (!data) {
      await ctx.answerCallbackQuery({ text: "Invalid request" });
      return;
    }
    await handleArchive(ctx, data.taskId);
  });

  // Talk summary
  bot.callbackQuery(/^overnight:talk:/, async (ctx) => {
    const data = decodeCallbackData(ctx.callbackQuery.data);
    if (!data) {
      await ctx.answerCallbackQuery({ text: "Invalid request" });
      return;
    }
    await handleTalk(ctx, data.taskId);
  });

  // YouTube: Save to Ideas
  bot.callbackQuery(/^yt:save:/, async (ctx) => {
    const taskId = ctx.callbackQuery.data.replace("yt:save:", "");
    await handleYouTubeSave(ctx, taskId);
  });

  // YouTube: Dismiss
  bot.callbackQuery(/^yt:dismiss:/, async (ctx) => {
    const taskId = ctx.callbackQuery.data.replace("yt:dismiss:", "");
    await handleYouTubeDismiss(ctx, taskId);
  });

  logger.debug("Overnight callback handlers registered");
}

// ============================================
// SELECTION HANDLERS
// ============================================

async function handleSelection(
  ctx: Context,
  taskId: string,
  option: ApproachLabel
): Promise<void> {
  if (!taskStore || !morningPresenter) {
    await ctx.answerCallbackQuery({ text: "System not initialized" });
    return;
  }

  await ctx.answerCallbackQuery({ text: `Applying option ${option}...` });

  const task = taskStore.getTask(taskId);
  if (!task) {
    await ctx.editMessageText("❌ Task not found.");
    return;
  }

  const choice = taskStore.getMorningChoiceByTask(taskId);
  if (!choice) {
    await ctx.editMessageText("❌ Choices not found.");
    return;
  }

  const result = await morningPresenter.handleSelection(task, choice, option);

  if (result.success) {
    let message = `✅ Selected: Option ${option}\n\n`;
    if (result.prUrl) {
      message += `Created PR: ${result.prUrl}`;
    } else {
      message += `Selection recorded.`;
    }
    await ctx.editMessageText(message);
  } else {
    await ctx.editMessageText(`❌ Failed: ${result.error}`);
  }
}

async function handleCompare(ctx: Context, taskId: string): Promise<void> {
  if (!taskStore || !morningPresenter) {
    await ctx.answerCallbackQuery({ text: "System not initialized" });
    return;
  }

  await ctx.answerCallbackQuery();

  const choice = taskStore.getMorningChoiceByTask(taskId);
  if (!choice) {
    await ctx.reply("❌ Choices not found.");
    return;
  }

  const comparison = morningPresenter.formatDetailedComparison(choice);

  // Send as new message (too long for edit usually)
  await ctx.reply(comparison, { parse_mode: "Markdown" });
}

async function handleSkip(ctx: Context, taskId: string): Promise<void> {
  if (!taskStore || !morningPresenter) {
    await ctx.answerCallbackQuery({ text: "System not initialized" });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Skipping..." });

  const task = taskStore.getTask(taskId);
  if (!task) {
    await ctx.editMessageText("❌ Task not found.");
    return;
  }

  const choice = taskStore.getMorningChoiceByTask(taskId);
  if (!choice) {
    await ctx.editMessageText("❌ Choices not found.");
    return;
  }

  morningPresenter.handleSkip(task, choice);

  await ctx.editMessageText("⏭ Skipped. Workspaces will be cleaned up.");
}

async function handleApprove(ctx: Context, taskId: string): Promise<void> {
  if (!taskStore) {
    await ctx.answerCallbackQuery({ text: "System not initialized" });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Approved" });
  const task = taskStore.getTask(taskId);
  if (!task) {
    await ctx.editMessageText("❌ Task not found.");
    return;
  }

  taskStore.updateTaskStatus(taskId, "selected");
  await ctx.editMessageText("✅ Approved. Moving to planning.");

  const db = overnightStateManager?.getDb();
  if (db) {
    try {
      recordFeedback(db, {
        contentType: "overnight",
        contentId: taskId,
        action: "approve",
        source: "telegram",
        impressionId: pendingImpressions.get(taskId)?.impressionId,
        delta: 0.15,
        responseTimeMs: pendingImpressions.has(taskId)
          ? Date.now() - pendingImpressions.get(taskId)!.displayedAt
          : undefined,
      });
    } catch { /* best-effort */ }
  }
}

async function handleArchive(ctx: Context, taskId: string): Promise<void> {
  if (!taskStore) {
    await ctx.answerCallbackQuery({ text: "System not initialized" });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Archived" });
  const task = taskStore.getTask(taskId);
  if (!task) {
    await ctx.editMessageText("❌ Task not found.");
    return;
  }

  taskStore.updateTaskStatus(taskId, "skipped");
  await ctx.editMessageText("🗂 Archived.");

  const db = overnightStateManager?.getDb();
  if (db) {
    try {
      recordFeedback(db, {
        contentType: "overnight",
        contentId: taskId,
        action: "archive",
        source: "telegram",
        impressionId: pendingImpressions.get(taskId)?.impressionId,
        delta: -0.1,
        responseTimeMs: pendingImpressions.has(taskId)
          ? Date.now() - pendingImpressions.get(taskId)!.displayedAt
          : undefined,
      });
    } catch { /* best-effort */ }
  }
}

async function handleTalk(ctx: Context, taskId: string): Promise<void> {
  if (!taskStore) {
    await ctx.answerCallbackQuery({ text: "System not initialized" });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Let's talk" });
  const task = taskStore.getTask(taskId);
  if (!task) {
    await ctx.editMessageText("❌ Task not found.");
    return;
  }

  taskStore.updateTaskStatus(taskId, "selected");
  await ctx.editMessageText("💬 Talk requested.");
  await ctx.reply(
    `💬 *Overnight Task Discussion*\n\n` +
    `Subject: ${task.subject}\n\n` +
    `1) What outcome do you want?\n` +
    `2) How urgent is this?\n` +
    `3) Any constraints or dependencies?`,
    { parse_mode: "Markdown" }
  );

  const db = overnightStateManager?.getDb();
  if (db) {
    try {
      recordFeedback(db, {
        contentType: "overnight",
        contentId: taskId,
        action: "talk",
        source: "telegram",
        impressionId: pendingImpressions.get(taskId)?.impressionId,
        delta: 0.15,
        responseTimeMs: pendingImpressions.has(taskId)
          ? Date.now() - pendingImpressions.get(taskId)!.displayedAt
          : undefined,
      });
    } catch { /* best-effort */ }
  }
}

// ============================================
// MILESTONE NOTIFICATIONS
// ============================================

export async function sendMilestoneNotification(
  bot: Bot,
  chatId: number,
  milestone: string,
  message: string
): Promise<number | undefined> {
  try {
    const result = await bot.api.sendMessage(chatId, message, {
      parse_mode: "Markdown",
    });
    return result.message_id;
  } catch (error) {
    logger.error({ chatId, milestone, error }, "Failed to send milestone notification");
    return undefined;
  }
}

// ============================================
// MORNING PRESENTATION
// ============================================

export async function presentMorningChoices(
  bot: Bot,
  chatId: number,
  taskId: string
): Promise<void> {
  if (!taskStore) {
    logger.error("Overnight system not initialized for morning presentation");
    return;
  }

  const task = taskStore.getTask(taskId);
  if (!task) {
    logger.error({ taskId }, "Task not found for morning presentation");
    return;
  }

  // YouTube tasks get a simplified presentation
  if (task.type === "youtube_summary") {
    await presentYouTubeSummary(bot, chatId, task);
    return;
  }

  const iteration = getLatestIteration(taskId);
  const message = formatTaskSummary(task.subject, task.type, iteration?.output, task.id);

  const keyboard = new InlineKeyboard();
  keyboard.text("✅ Approve", `overnight:approve:${task.id}`);
  keyboard.text("🗂 Archive", `overnight:archive:${task.id}`);
  keyboard.text("💬 Talk", `overnight:talk:${task.id}`);

  try {
    const result = await bot.api.sendMessage(chatId, message, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });

    taskStore.updateTaskStatus(task.id, "presented");
    logger.info({ taskId, chatId, messageId: result.message_id }, "Overnight summary presented");

    // Record review session + impression for feedback linking
    const db = overnightStateManager?.getDb();
    if (db) {
      try {
        const sessionId = createReviewSession(db, "overnight_review", 1);
        const impressionId = recordImpression(db, {
          sessionId,
          contentType: "overnight",
          contentId: task.id,
          position: 0,
          metadata: { subject: task.subject, type: task.type },
        });
        completeReviewSession(db, sessionId);
        pendingImpressions.set(task.id, {
          impressionId,
          displayedAt: Date.now(),
        });
      } catch (err) {
        logger.warn({ error: err, taskId }, "Failed to record overnight impression");
      }
    }
  } catch (error) {
    logger.error({ taskId, chatId, error }, "Failed to present overnight summary");
  }
}

export async function presentOvernightSummaries(
  bot: Bot,
  stateManager: StateManager,
  chatId: number
): Promise<number> {
  if (!taskStore) {
    initializeOvernightHandlers(stateManager);
  }
  if (!taskStore) return 0;

  const readyTasks = taskStore.getTasksByStatus("ready");
  let sent = 0;
  for (const task of readyTasks) {
    await presentMorningChoices(bot, chatId, task.id);
    sent++;
  }
  return sent;
}

// ============================================
// YOUTUBE SUMMARY PRESENTATION
// ============================================

async function presentYouTubeSummary(
  bot: Bot,
  chatId: number,
  task: ReturnType<OvernightTaskStore["getTask"]> & {}
): Promise<void> {
  if (!taskStore) return;

  let metadata: YouTubeSummaryMetadata | null = null;
  try {
    metadata = task.metadata ? JSON.parse(task.metadata) as YouTubeSummaryMetadata : null;
  } catch {
    // metadata parse failed
  }

  const videoId = metadata?.videoId ?? "";

  let summary = "";
  let careerRelevance = "";
  let suggestions: string[] = [];
  let relevanceScore = 0;
  let videoTitle = metadata?.videoTitle ?? "Unknown";

  // Try DB first
  const db = overnightStateManager?.getDb();
  const dbVideo = db ? getYouTubeVideoFromDb(db, videoId) : null;

  if (dbVideo) {
    videoTitle = dbVideo.title || videoTitle;
    relevanceScore = dbVideo.relevanceScore;

    // Parse sections from summary markdown
    const summaryContent = dbVideo.summary ?? "";
    const summaryMatch = summaryContent.match(/## Summary\n([\s\S]*?)(?=\n## )/);
    if (summaryMatch) summary = summaryMatch[1]!.trim();

    const careerMatch = summaryContent.match(/## Career (?:& Life )?Relevance\n([\s\S]*?)(?=\n## )/);
    if (careerMatch) careerRelevance = careerMatch[1]!.trim();

    const suggestionsMatch = summaryContent.match(/## Actionable Suggestions\n([\s\S]*?)(?=\n## )/);
    if (suggestionsMatch) {
      suggestions = suggestionsMatch[1]!
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("- "))
        .slice(0, 2)
        .map((l) => l.slice(2));
    }

    // Also try metadata JSON for actionable suggestions
    if (suggestions.length === 0) {
      try {
        const meta = JSON.parse(dbVideo.metadata);
        if (Array.isArray(meta.actionableSuggestions)) {
          suggestions = meta.actionableSuggestions.slice(0, 2).map(String);
        }
      } catch { /* ignore */ }
    }
  } else {
    // File fallback
    const summaryPath = summaryFileExists(videoId);
    if (summaryPath) {
      try {
        const content = readFileSync(summaryPath, "utf-8");

        const titleMatch = content.match(/videoTitle:\s*"([^"]+)"/);
        if (titleMatch) videoTitle = titleMatch[1]!;

        const scoreMatch = content.match(/relevanceScore:\s*(\d+)/);
        if (scoreMatch) relevanceScore = parseInt(scoreMatch[1]!, 10);

        const summaryMatch = content.match(/## Summary\n([\s\S]*?)(?=\n## )/);
        if (summaryMatch) summary = summaryMatch[1]!.trim();

        const careerMatch = content.match(/## Career (?:& Life )?Relevance\n([\s\S]*?)(?=\n## )/);
        if (careerMatch) careerRelevance = careerMatch[1]!.trim();

        const suggestionsMatch = content.match(/## Actionable Suggestions\n([\s\S]*?)(?=\n## )/);
        if (suggestionsMatch) {
          suggestions = suggestionsMatch[1]!
            .trim()
            .split("\n")
            .filter((l) => l.startsWith("- "))
            .slice(0, 2)
            .map((l) => l.slice(2));
        }
      } catch (error) {
        logger.warn({ videoId, error }, "Failed to read summary file for presentation");
      }
    }
  }

  // Build message (keep under Telegram's 4096 char limit)
  const scoreEmoji = relevanceScore >= 7 ? "🔥" : relevanceScore >= 4 ? "📊" : "📎";
  let message = `${scoreEmoji} <b>YouTube Summary</b>\n\n`;
  message += `<b>${escapeHtml(videoTitle)}</b>\n`;
  message += `Relevance: ${relevanceScore}/10\n\n`;

  if (summary) {
    message += `<b>Summary:</b>\n${escapeHtml(summary.slice(0, 600))}\n\n`;
  }

  if (careerRelevance) {
    message += `<b>Career Relevance:</b>\n${escapeHtml(careerRelevance.slice(0, 400))}\n\n`;
  }

  if (suggestions.length > 0) {
    message += `<b>Actions:</b>\n`;
    for (const s of suggestions) {
      message += `• ${escapeHtml(s.slice(0, 200))}\n`;
    }
  }

  // Truncate if too long
  if (message.length > 3800) {
    message = message.slice(0, 3800) + "...";
  }

  const keyboard = new InlineKeyboard();
  keyboard.text("💡 Save to Ideas", `yt:save:${task.id}`);
  keyboard.text("🗑 Dismiss", `yt:dismiss:${task.id}`);

  try {
    const result = await bot.api.sendMessage(chatId, message, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });

    taskStore.updateTaskStatus(task.id, "presented");
    logger.info({ taskId: task.id, chatId, videoId, messageId: result.message_id }, "YouTube summary presented");

    // Record review session + impression for feedback linking
    const db = overnightStateManager?.getDb();
    if (db) {
      try {
        const sessionId = createReviewSession(db, "youtube_review", 1);
        const impressionId = recordImpression(db, {
          sessionId,
          contentType: "youtube",
          contentId: videoId || task.id,
          position: 0,
          scoreAtDisplay: relevanceScore,
          metadata: { videoTitle, videoId },
        });
        completeReviewSession(db, sessionId);
        pendingImpressions.set(task.id, {
          impressionId,
          displayedAt: Date.now(),
        });
      } catch (err) {
        logger.warn({ error: err, taskId: task.id }, "Failed to record YouTube impression");
      }
    }
  } catch (error) {
    logger.error({ taskId: task.id, chatId, error }, "Failed to present YouTube summary");
  }
}

async function handleYouTubeSave(ctx: Context, taskId: string): Promise<void> {
  if (!taskStore) {
    await ctx.answerCallbackQuery({ text: "System not initialized" });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Saving to ideas..." });

  const task = taskStore.getTask(taskId);
  if (!task) {
    await ctx.editMessageText("❌ Task not found.");
    return;
  }

  let metadata: YouTubeSummaryMetadata | null = null;
  try {
    metadata = task.metadata ? JSON.parse(task.metadata) as YouTubeSummaryMetadata : null;
  } catch {
    // ignore
  }

  const videoId = metadata?.videoId ?? "";
  const videoUrl = metadata?.videoUrl ?? "";
  const videoTitle = metadata?.videoTitle ?? "YouTube Video";

  // Read summary — DB first, file fallback
  const saveDb = overnightStateManager?.getDb();
  const dbVid = saveDb ? getYouTubeVideoFromDb(saveDb, videoId) : null;
  let summaryContent = "";
  if (dbVid?.summary) {
    summaryContent = dbVid.summary;
  } else {
    const summaryPath = summaryFileExists(videoId);
    if (summaryPath) {
      try {
        const raw = readFileSync(summaryPath, "utf-8");
        // Strip YAML frontmatter
        const bodyMatch = raw.match(/---[\s\S]*?---\n([\s\S]*)/);
        summaryContent = bodyMatch ? bodyMatch[1]!.trim() : raw;
      } catch {
        // ignore
      }
    }
  }

  // Create idea file
  const now = new Date();
  const timestamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;

  const idea: ParsedIdea = {
    id: `yt_${videoId.slice(0, 11)}`,
    title: `YouTube: ${videoTitle}`,
    status: "draft",
    source: "youtube-telegram",
    content: summaryContent || `Video: ${videoUrl}`,
    link: videoUrl,
    tags: ["youtube", "overnight-summary"],
    timestamp,
  };

  try {
    const db = overnightStateManager?.getDb();
    if (db) {
      dao.createIdea(db, idea);
    } else {
      logger.warn({ ideaId: idea.id }, "handleYouTubeSave: DB unavailable, file-only save (invisible to DB)");
      saveIdeaFile(idea);
    }
    markSummaryReviewedV2(videoId, db ?? undefined);
    taskStore.updateTaskStatus(taskId, "selected");
    await ctx.editMessageText(`💡 Saved to ideas: ${videoTitle}`);
    logger.info({ taskId, videoId, ideaId: idea.id }, "YouTube summary saved to ideas");

    // Record feedback event + YouTube preference signals
    if (db) {
      try {
        recordFeedback(db, {
          contentType: "youtube",
          contentId: videoId || taskId,
          action: "save",
          source: "telegram",
          impressionId: pendingImpressions.get(taskId)?.impressionId,
          delta: 0.2,
          responseTimeMs: pendingImpressions.has(taskId)
            ? Date.now() - pendingImpressions.get(taskId)!.displayedAt
            : undefined,
          metadata: { videoTitle, videoId },
        });
        // YouTube preference signals (new: feeds preference model)
        const signals: PreferenceSignal[] = [
          { dimension: "source:youtube", delta: 0.1 },
        ];
        updatePreferences(db, signals);
      } catch { /* best-effort */ }
    }
  } catch (error) {
    logger.error({ taskId, error }, "Failed to save YouTube summary to ideas");
    await ctx.editMessageText("❌ Failed to save to ideas.");
  }
}

async function handleYouTubeDismiss(ctx: Context, taskId: string): Promise<void> {
  if (!taskStore) {
    await ctx.answerCallbackQuery({ text: "System not initialized" });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Dismissed" });

  const task = taskStore.getTask(taskId);
  if (!task) {
    await ctx.editMessageText("❌ Task not found.");
    return;
  }

  let metadata: YouTubeSummaryMetadata | null = null;
  try {
    metadata = task.metadata ? JSON.parse(task.metadata) as YouTubeSummaryMetadata : null;
  } catch {
    // ignore
  }

  const videoId = metadata?.videoId ?? "";
  const db = overnightStateManager?.getDb();
  markSummaryReviewedV2(videoId, db ?? undefined);
  taskStore.updateTaskStatus(taskId, "skipped");
  await ctx.editMessageText("🗑 Dismissed.");

  // Record feedback event + YouTube preference signals
  if (db) {
    try {
      recordFeedback(db, {
        contentType: "youtube",
        contentId: videoId || taskId,
        action: "dismiss",
        source: "telegram",
        impressionId: pendingImpressions.get(taskId)?.impressionId,
        delta: -0.1,
        responseTimeMs: pendingImpressions.has(taskId)
          ? Date.now() - pendingImpressions.get(taskId)!.displayedAt
          : undefined,
      });
      // YouTube preference signals (new: feeds preference model)
      const signals: PreferenceSignal[] = [
        { dimension: "source:youtube", delta: -0.05 },
      ];
      updatePreferences(db, signals);
    } catch { /* best-effort */ }
  }
}

// ============================================
// COMMANDS
// ============================================

export function registerOvernightCommands(bot: Bot, stateManager: StateManager): void {
  // Initialize if not already done
  if (!taskStore) {
    initializeOvernightHandlers(stateManager);
  }

  // /overnight - Show queued overnight tasks
  bot.command("overnight", async (ctx) => {
    if (!taskStore) {
      await ctx.reply("❌ Overnight system not initialized.");
      return;
    }

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const tasks = taskStore.getTasksByChatId(chatId, 10);

    if (tasks.length === 0) {
      await ctx.reply(
        "No overnight tasks.\n\n" +
        "To queue work, say something like:\n" +
        '• "work on rate limiting tonight"\n' +
        '• "research authentication options for me tonight"'
      );
      return;
    }

    let message = "*Overnight Tasks*\n\n";
    for (const task of tasks) {
      const status = formatStatus(task.status);
      const age = formatAge(task.createdAt);
      message += `${status} *${task.subject}*\n`;
      message += `  └ ${task.type} • ${age}\n`;
      message += `  └ \`${task.id}\`\n\n`;
    }

    await ctx.reply(message, { parse_mode: "Markdown" });
  });

  // Register callback handlers
  registerOvernightCallbacks(bot);
}

// ============================================
// UTILITIES
// ============================================

function formatStatus(status: string): string {
  switch (status) {
    case "queued":
      return "⏳";
    case "clarifying":
      return "❓";
    case "planning":
    case "executing":
    case "synthesizing":
      return "🔄";
    case "ready":
    case "presented":
      return "✅";
    case "selected":
    case "applied":
      return "✔️";
    case "skipped":
      return "⏭";
    case "failed":
      return "❌";
    case "expired":
      return "⏰";
    default:
      return "•";
  }
}

function getLatestIteration(taskId: string): { output?: string } | undefined {
  if (!taskStore) return undefined;
  const iterations = taskStore.getIterationsByTask(taskId);
  if (iterations.length === 0) return undefined;
  return iterations[iterations.length - 1];
}

function formatTaskSummary(subject: string, type: string, output: string | undefined, taskId: string): string {
  const typeLabel = type === "prototype_work" ? "Coding" : type === "research_dive" ? "Research" : type;
  const header =
    `🌙 <b>Overnight Task Complete</b>\n\n` +
    `<b>Subject:</b> ${escapeHtml(subject)}\n` +
    `<b>Type:</b> ${escapeHtml(typeLabel)}\n` +
    `<b>Task ID:</b> <code>${escapeHtml(taskId)}</code>\n\n`;
  const body = output ? escapeHtml(output.slice(0, 1500)) : "No output recorded.";
  return header + body;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatAge(date: Date): string {
  const ms = Date.now() - date.getTime();
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
  if (hours > 0) {
    return `${hours}h ago`;
  }
  return `${minutes}m ago`;
}

// ============================================
// EXPORTS
// ============================================

export { taskStore, morningPresenter };
