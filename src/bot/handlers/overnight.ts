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
import { decodeCallbackData, type OvernightTaskType } from "../../overnight/types.js";
import type { ApproachLabel } from "../../overnight/types.js";

// ============================================
// STATE
// ============================================

let taskStore: OvernightTaskStore | null = null;
let morningPresenter: MorningPresenter | null = null;

// Pending clarifications (chatId -> partial task data)
interface PendingClarification {
  subject: string;
  constraints: string[];
  rawMessage: string;
  messageId: number;
  createdAt: number;
}

const pendingClarifications = new Map<number, PendingClarification>();

// Cleanup stale clarifications every 5 minutes
setInterval(() => {
  const staleThreshold = Date.now() - 3600000; // 1 hour
  for (const [chatId, pending] of pendingClarifications.entries()) {
    if (pending.createdAt < staleThreshold) {
      pendingClarifications.delete(chatId);
      logger.debug({ chatId }, "Cleaned up stale overnight clarification");
    }
  }
}, 300000);

// ============================================
// INITIALIZATION
// ============================================

export function initializeOvernightHandlers(stateManager: StateManager): void {
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

  // Full parsing
  const intent = parseOvernightIntent(message);

  if (!intent.isOvernight) {
    return false;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return false;

  logger.info(
    { chatId, subject: intent.subject, type: intent.taskType, confidence: intent.confidence },
    "Detected overnight work request"
  );

  // Check if clarification needed
  if (intent.clarificationNeeded) {
    await handleClarificationRequest(ctx, intent);
    return true;
  }

  // Queue the task
  await queueOvernightTask(ctx, intent.taskType!, intent.subject!, intent.constraints);
  return true;
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

  // Store pending clarification
  pendingClarifications.set(chatId, {
    subject: intent.subject || intent.rawMessage,
    constraints: intent.constraints,
    rawMessage: intent.rawMessage,
    messageId: ctx.message?.message_id || 0,
    createdAt: Date.now(),
  });

  await ctx.reply(clarification.question, {
    reply_markup: keyboard,
    reply_to_message_id: ctx.message?.message_id,
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
    const chatId = ctx.chat?.id;

    if (!chatId) {
      await ctx.answerCallbackQuery({ text: "Error: No chat context" });
      return;
    }

    const pending = pendingClarifications.get(chatId);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Clarification expired" });
      return;
    }

    pendingClarifications.delete(chatId);
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
      const intent = parseOvernightIntent(pending.rawMessage);
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
  if (!taskStore || !morningPresenter) {
    logger.error("Overnight system not initialized for morning presentation");
    return;
  }

  const task = taskStore.getTask(taskId);
  if (!task) {
    logger.error({ taskId }, "Task not found for morning presentation");
    return;
  }

  // Prepare choices
  const choice = await morningPresenter.prepareMorningChoices(task);
  if (!choice) {
    logger.warn({ taskId }, "No choices to present");
    return;
  }

  // Format message
  const message = morningPresenter.formatTelegramMessage(task, choice);

  // Build keyboard
  const keyboard = new InlineKeyboard();

  // Option buttons
  for (const opt of choice.options) {
    keyboard.text(`${opt.label}: ${opt.name}`, `overnight:select:${task.id}:${opt.label}`);
  }
  keyboard.row();

  // Action buttons
  keyboard.text("📊 Compare All", `overnight:compare:${task.id}:`);
  keyboard.text("⏭ Skip", `overnight:skip:${task.id}:`);

  // Send message
  try {
    const result = await bot.api.sendMessage(chatId, message, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });

    // Update choice with message ID
    taskStore.setMorningChoiceMessageId(choice.id, result.message_id);
    taskStore.updateTaskStatus(task.id, "presented");

    logger.info({ taskId, chatId, messageId: result.message_id }, "Morning choices presented");
  } catch (error) {
    logger.error({ taskId, chatId, error }, "Failed to present morning choices");
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
