import { Bot, type Context } from "grammy";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { authMiddleware } from "./middleware/auth.js";
import { parseRoute, getSubagentPrefix } from "../router/prefix-router.js";
import { executeClaudeCommand } from "../executors/claude.js";
import { chunkMessage } from "../utils/chunker.js";
import { StateManager } from "../state/manager.js";
import { sendThinkingIndicator, editWithResponse } from "./streaming.js";
import { loadBootstrapFiles } from "../memory/loader.js";
import { processMemoryUpdates } from "../memory/writer.js";
import type { Scheduler } from "../scheduler/index.js";
import {
  ReminderManager,
  parseReminder,
  formatRelativeTime as reminderRelativeTime,
  formatDateTime,
} from "../reminders/index.js";

// Enable hybrid streaming mode (thinking indicator -> edit with response)
const ENABLE_STREAMING = true;

// Scheduler reference (set after bot creation)
let schedulerRef: Scheduler | null = null;
let reminderManagerRef: ReminderManager | null = null;

export function setScheduler(scheduler: Scheduler): void {
  schedulerRef = scheduler;
}

export function setReminderManager(reminderManager: ReminderManager): void {
  reminderManagerRef = reminderManager;
}

export function createBot(stateManager: StateManager): Bot {
  const bot = new Bot(config.telegram.botToken);

  // Create reminder manager
  const reminderManager = new ReminderManager(stateManager);
  reminderManagerRef = reminderManager;

  // Auth middleware - must be first
  bot.use(authMiddleware);

  // Handle /start command
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "H.O.M.E.R ready.\n\n" +
        "Commands:\n" +
        "/work [project] - Work context\n" +
        "/life [area] - Life context\n" +
        "/new - Start fresh session\n" +
        "/g - Use Gemini subagent\n" +
        "/x - Use Codex subagent\n" +
        "/status - Show active sessions\n" +
        "/jobs - List scheduled jobs\n" +
        "/trigger <id> - Run a job manually\n" +
        "/remind <time> <msg> - Set reminder\n" +
        "/reminders - List pending reminders\n" +
        "/cancel <id> - Cancel reminder\n\n" +
        "Or just type to continue last session."
    );
  });

  // Handle /status command
  bot.command("status", async (ctx) => {
    const sessions = stateManager.getActiveSessions();
    const jobStats = stateManager.getJobStats();

    let statusText = "";

    if (sessions.length === 0) {
      statusText += "No active sessions.\n";
    } else {
      statusText += "Active sessions:\n";
      for (const s of sessions) {
        const age = Math.round((Date.now() - s.lastActivityAt) / 1000 / 60);
        const claudeSessionId = stateManager.getClaudeSessionId(s.lane);
        const sessionInfo = claudeSessionId ? ` [${claudeSessionId.slice(0, 8)}...]` : "";
        statusText += `  ${s.lane}: ${age}m ago (${s.messageCount} msgs)${sessionInfo}\n`;
      }
    }

    statusText += `\nJobs: ${jobStats.pending} pending, ${jobStats.running} running`;

    await ctx.reply(statusText);
  });

  // Handle /jobs command - list scheduled jobs
  bot.command("jobs", async (ctx) => {
    if (!schedulerRef) {
      await ctx.reply("Scheduler not initialized.");
      return;
    }

    const jobs = schedulerRef.getJobs();
    if (jobs.length === 0) {
      await ctx.reply("No scheduled jobs configured.");
      return;
    }

    let response = "*Scheduled Jobs*\n\n";
    for (const job of jobs) {
      const status = job.config.enabled ? "✅" : "⏸️";
      const lastRun = job.lastRun
        ? formatRelativeTime(job.lastRun)
        : "never";
      const failures = job.consecutiveFailures > 0
        ? ` (${job.consecutiveFailures} failures)`
        : "";

      response += `${status} *${job.config.id}*\n`;
      response += `  └ ${job.config.name}\n`;
      response += `  └ \`${job.config.cron}\` | ${job.config.lane}\n`;
      response += `  └ Last: ${lastRun}${failures}\n\n`;
    }

    response += "_Use /trigger <id> to run a job manually_";

    try {
      await ctx.reply(response, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(response.replace(/[*_`]/g, ""));
    }
  });

  // Handle /trigger command - manually trigger a job
  bot.command("trigger", async (ctx) => {
    if (!schedulerRef) {
      await ctx.reply("Scheduler not initialized.");
      return;
    }

    const jobId = ctx.match?.trim();
    if (!jobId) {
      await ctx.reply("Usage: /trigger <job-id>\n\nUse /jobs to see available jobs.");
      return;
    }

    const job = schedulerRef.getJob(jobId);
    if (!job) {
      await ctx.reply(`Job not found: ${jobId}\n\nUse /jobs to see available jobs.`);
      return;
    }

    const triggered = schedulerRef.triggerJob(jobId);
    if (triggered) {
      await ctx.reply(`⏳ Triggered: *${job.config.name}*`, { parse_mode: "Markdown" });
    } else {
      await ctx.reply(`Failed to trigger job: ${jobId}`);
    }
  });

  // Handle /remind command - create a reminder
  bot.command("remind", async (ctx) => {
    const input = ctx.match?.trim() || "";

    if (!input) {
      await ctx.reply(
        "Usage: /remind <time> <message>\n\n" +
          "Examples:\n" +
          "  /remind in 30 minutes check the oven\n" +
          "  /remind tomorrow at 9am call dentist\n" +
          "  /remind at 5pm review PR"
      );
      return;
    }

    const parsed = parseReminder(input);

    if (!parsed.time) {
      await ctx.reply(
        "Could not parse a time from your input.\n\n" +
          "Try: /remind in 30 minutes <message>\n" +
          "Or: /remind tomorrow at 9am <message>"
      );
      return;
    }

    // Check if time is in the past
    if (parsed.time.getTime() <= Date.now()) {
      await ctx.reply("The reminder time must be in the future.");
      return;
    }

    const id = reminderManager.create({
      chatId: ctx.chat.id,
      message: parsed.message,
      dueAt: parsed.time,
      context: "default",
    });

    const relativeTime = reminderRelativeTime(parsed.time);
    const absoluteTime = formatDateTime(parsed.time);

    await ctx.reply(
      `⏰ Reminder set for ${absoluteTime} (${relativeTime})\n\n` +
        `"${parsed.message}"\n\n` +
        `ID: \`${id.slice(0, 8)}\``,
      { parse_mode: "Markdown" }
    );
  });

  // Handle /reminders command - list pending reminders
  bot.command("reminders", async (ctx) => {
    const pending = reminderManager.getPendingByChat(ctx.chat.id);

    if (pending.length === 0) {
      await ctx.reply("No pending reminders.");
      return;
    }

    let response = "*Pending Reminders*\n\n";
    for (const r of pending) {
      const relativeTime = reminderRelativeTime(r.dueAt);
      const absoluteTime = formatDateTime(r.dueAt);
      const preview = r.message.length > 40
        ? r.message.slice(0, 40) + "..."
        : r.message;

      response += `⏰ *${relativeTime}* (${absoluteTime})\n`;
      response += `   ${preview}\n`;
      response += `   ID: \`${r.id.slice(0, 8)}\`\n\n`;
    }

    response += "_Use /cancel <id> to cancel a reminder_";

    try {
      await ctx.reply(response, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(response.replace(/[*_`]/g, ""));
    }
  });

  // Handle /cancel command - cancel a reminder
  bot.command("cancel", async (ctx) => {
    const idPrefix = ctx.match?.trim();

    if (!idPrefix) {
      await ctx.reply("Usage: /cancel <reminder-id>\n\nUse /reminders to see pending reminders.");
      return;
    }

    // Find reminder by ID prefix
    const pending = reminderManager.getPendingByChat(ctx.chat.id);
    const match = pending.find((r) => r.id.startsWith(idPrefix));

    if (!match) {
      await ctx.reply(`Reminder not found: ${idPrefix}\n\nUse /reminders to see pending reminders.`);
      return;
    }

    const cancelled = reminderManager.cancel(match.id);
    if (cancelled) {
      await ctx.reply(`✅ Cancelled reminder: "${match.message.slice(0, 50)}..."`);
    } else {
      await ctx.reply(`Failed to cancel reminder: ${idPrefix}`);
    }
  });

  // Handle all text messages
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;

    // Parse the route
    const route = parseRoute(text);

    if (!route) {
      // No prefix - try to continue in the most recent session
      const recentSession = stateManager.getMostRecentSession();
      if (recentSession) {
        // Get the cwd for this context
        const cwd = getContextCwd(recentSession.lane);
        await handleExecution(ctx, recentSession.lane, cwd, text, stateManager, {
          newSession: false,
        });
      } else {
        await ctx.reply(
          "No active session. Start with:\n/work, /life, or /new"
        );
      }
      return;
    }

    // Empty query after prefix - just switch context
    if (!route.query) {
      await ctx.reply(`Switched to ${route.context}${route.subcontext ? `/${route.subcontext}` : ""}. Send your query.`);
      // Create/touch session for this context
      stateManager.getOrCreateSession(route.context);
      return;
    }

    await handleExecution(ctx, route.context, route.cwd, route.query, stateManager, {
      newSession: route.newSession,
      subagent: route.subagent,
      subcontext: route.subcontext,
    });
  });

  return bot;
}

function getContextCwd(context: string): string {
  const paths: Record<string, string> = {
    work: "/Users/yj/work",
    life: "/Users/yj/life",
    default: "/Users/yj",
  };
  return paths[context] ?? "/Users/yj";
}

interface ExecutionOptions {
  newSession: boolean;
  subagent?: "gemini" | "codex";
  subcontext?: string;
}

async function handleExecution(
  ctx: Context,
  context: string,
  cwd: string,
  query: string,
  stateManager: StateManager,
  options: ExecutionOptions
): Promise<void> {
  const { newSession, subagent, subcontext } = options;

  // Get or create session for this context
  const session = stateManager.getOrCreateSession(context);

  // Get Claude session ID (unless starting fresh)
  // Uses composite key (context:subcontext) for project isolation
  let claudeSessionId: string | undefined;
  if (!newSession) {
    claudeSessionId = stateManager.getClaudeSessionId(context, subcontext) ?? undefined;
  }

  logger.info(
    {
      context,
      subcontext,
      cwd,
      sessionId: session.id,
      claudeSessionId: claudeSessionId?.slice(0, 8),
      newSession,
      subagent,
      queryPreview: query.slice(0, 50),
    },
    "Executing command"
  );

  // Send thinking indicator or typing action
  let streamingMsg = null;
  if (ENABLE_STREAMING) {
    streamingMsg = await sendThinkingIndicator(ctx);
  } else {
    await ctx.replyWithChatAction("typing");
  }

  try {
    // Load memory context for new sessions (including project CLAUDE.md)
    let memoryContext = "";
    if (newSession || !claudeSessionId) {
      const bootstrap = await loadBootstrapFiles(context, cwd);
      if (bootstrap) {
        memoryContext = `<context>\n${bootstrap}\n</context>\n\n`;
        logger.debug({ context, cwd, length: bootstrap.length }, "Loaded memory context");
      }
    }

    // Add subagent prefix if needed
    const subagentPrefix = getSubagentPrefix(subagent);
    const finalQuery = memoryContext + subagentPrefix + query;

    const result = await executeClaudeCommand(finalQuery, {
      cwd,
      claudeSessionId,
      subagent,
    });

    // Store new Claude session ID if captured (with subcontext for project isolation)
    if (result.claudeSessionId) {
      stateManager.setClaudeSessionId(context, result.claudeSessionId, subcontext);
    } else if (claudeSessionId) {
      // Update activity on existing session
      stateManager.updateClaudeSessionActivity(context, subcontext);
    }

    // Update session activity
    stateManager.updateSessionActivity(session.id);

    // Process memory updates from response
    const { cleanedResponse, updatesWritten, targets } = await processMemoryUpdates(
      result.output,
      context
    );
    if (updatesWritten > 0) {
      logger.info({ context, updatesWritten, targets }, "Memory updated from response");
    }

    // Send response (with memory tags stripped)
    if (ENABLE_STREAMING && streamingMsg) {
      await editWithResponse(ctx, streamingMsg, cleanedResponse);
    } else {
      // Chunk and send response (with memory tags stripped)
      const chunks = chunkMessage(cleanedResponse);
      for (const chunk of chunks) {
        try {
          await ctx.reply(chunk, { parse_mode: "Markdown" });
        } catch {
          // Fallback without markdown
          await ctx.reply(chunk);
        }
      }
    }
  } catch (error) {
    logger.error({ error, context, query }, "Execution failed");
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    if (ENABLE_STREAMING && streamingMsg) {
      await editWithResponse(ctx, streamingMsg, `Error: ${errorMessage}`);
    } else {
      await ctx.reply(`Error: ${errorMessage}`);
    }
  }
}

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

export async function startBot(bot: Bot): Promise<void> {
  logger.info("Starting H.O.M.E.R bot...");

  bot.catch((err) => {
    logger.error({ error: err }, "Bot error");
  });

  await bot.start({
    onStart: (botInfo) => {
      logger.info({ username: botInfo.username }, "Bot started");
    },
  });
}

export function getReminderManager(): ReminderManager | null {
  return reminderManagerRef;
}
