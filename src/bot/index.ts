import { Bot, type Context } from "grammy";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { authMiddleware } from "./middleware/auth.js";
import {
  parseCommand,
  isPureExecutorSwitch,
  isExecutorSwitchWithQuery,
  getExecutorModel,
  type ParsedCommand,
} from "../commands/index.js";
import { registerApprovalHandlers, registerPlanApprovalHandlers, registerPlanApprovalCallbacks } from "./handlers/approval.js";
import { registerQuickCommands, registerProposalCallbacks } from "./handlers/proposal-approval.js";
import { registerOvernightCommands, handleOvernightMessage } from "./handlers/overnight.js";
import { chunkMessage } from "../utils/chunker.js";
import { StateManager } from "../state/manager.js";
import { sendThinkingIndicator, editWithResponse } from "./streaming.js";
import { loadBootstrapFiles } from "../memory/loader.js";
import { searchMemory, formatSearchResults } from "../memory/search.js";
import { hybridSearch, formatHybridResults } from "../search/index.js";
import type { SearchConfig } from "../search/types.js";
import { transcribeAudio, synthesizeSpeech, truncateForTTS } from "../voice/index.js";
import type { VoiceConfig, SynthesisOptions } from "../voice/types.js";
import { InputFile } from "grammy";
import type { Scheduler } from "../scheduler/index.js";
import {
  ReminderManager,
  parseReminder,
  formatRelativeTime as reminderRelativeTime,
  formatDateTime,
} from "../reminders/index.js";
import { MeetingManager, formatDuration } from "../meetings/index.js";
import { CLIRunManager } from "../executors/cli-runner.js";
import { telegramLane } from "../utils/lanes.js";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join, extname } from "path";

const ENABLE_STREAMING = true;
// Telegram now uses per-chat lanes (tg:<chatId>)

let schedulerRef: Scheduler | null = null;
let reminderManagerRef: ReminderManager | null = null;
let meetingManagerRef: MeetingManager | null = null;
let voiceOutputEnabled = false; // Toggle for voice output responses
const pendingAttachments: Map<string, string[]> = new Map();

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

async function saveTelegramFile(
  ctx: Context,
  fileId: string,
  filename: string,
  chatId: number
): Promise<string> {
  const file = await ctx.api.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
  const response = await fetch(fileUrl);
  const buffer = Buffer.from(await response.arrayBuffer());

  const baseDir = join(config.paths.uploadLanding, "tg", String(chatId));
  ensureDir(baseDir);

  const ext = extname(filename) || "";
  const safeName = filename.replace(/[^\w.\-]/g, "_");
  const targetPath = join(baseDir, safeName || `${fileId}${ext}`);
  writeFileSync(targetPath, buffer);

  return targetPath;
}

function addPendingAttachment(lane: string, path: string): void {
  const existing = pendingAttachments.get(lane) ?? [];
  existing.push(path);
  pendingAttachments.set(lane, existing);
}

function consumePendingAttachments(lane: string): string[] {
  const pending = pendingAttachments.get(lane) ?? [];
  if (pending.length > 0) {
    pendingAttachments.delete(lane);
  }
  return pending;
}

export function setScheduler(scheduler: Scheduler): void {
  schedulerRef = scheduler;
}

export function setReminderManager(reminderManager: ReminderManager): void {
  reminderManagerRef = reminderManager;
}

export function setMeetingManager(meetingManager: MeetingManager): void {
  meetingManagerRef = meetingManager;
}

export function createBot(stateManager: StateManager, runManager: CLIRunManager): Bot {
  const bot = new Bot(config.telegram.botToken);

  const reminderManager = new ReminderManager(stateManager);
  reminderManagerRef = reminderManager;

  bot.use(authMiddleware);

  // Register approval callback handlers for idea review buttons
  registerApprovalHandlers(bot, stateManager);

  // Register plan approval handlers (/approve, /reject, /plans)
  registerPlanApprovalHandlers(bot, stateManager);
  registerPlanApprovalCallbacks(bot, stateManager);

  // Register proposal quick commands (/a, /r, /s, /aa, /proposals) and inline button callbacks
  registerQuickCommands(bot, stateManager);
  registerProposalCallbacks(bot, stateManager);

  // Register overnight work commands (/overnight) and inline button callbacks
  registerOvernightCommands(bot, stateManager);

  // /start - help
  bot.command("start", async (ctx) => {
    // Get current executor state
    const lane = telegramLane(ctx.chat.id);
    const executorState = stateManager.getCurrentExecutor(lane);
    const currentExecutor = executorState?.executor || "claude";

    await ctx.reply(
      "H.O.M.E.R ready.\n\n" +
        `*Current executor:* ${currentExecutor}\n\n` +
        "*Executor Commands:* (persistent)\n" +
        "/claude - Switch to Claude (default)\n" +
        "/gemini - Switch to Gemini CLI\n" +
        "/codex - Switch to Codex (deep reasoning)\n\n" +
        "*Session:*\n" +
        "/new - Start fresh session (resets executor)\n" +
        "/status - Active session\n" +
        "/voice - Toggle voice output\n\n" +
        "*Jobs:*\n" +
        "/jobs - Scheduled jobs\n" +
        "/trigger <id> - Run job\n\n" +
        "*Meetings:*\n" +
        "/meeting <title> with <attendees>\n" +
        "/meetings - List recent\n\n" +
        "*Reminders:*\n" +
        "/remind <time> <msg>\n" +
        "/reminders - List\n" +
        "/cancel <id>\n\n" +
        "*Search:*\n" +
        "/search <query>\n\n" +
        "*Overnight Work:*\n" +
        "/overnight - View queued tasks\n" +
        '"work on xyz tonight" - Queue prototype\n' +
        '"research xyz for me tonight" - Queue research\n\n' +
        "Just type - I'll handle context.",
      { parse_mode: "Markdown" }
    );
  });

  // /voice - toggle voice output
  bot.command("voice", async (ctx) => {
    voiceOutputEnabled = !voiceOutputEnabled;
    const status = voiceOutputEnabled ? "ON" : "OFF";
    const icon = voiceOutputEnabled ? "🔊" : "🔇";
    await ctx.reply(`${icon} Voice output: *${status}*\n\nVoice input always works - just send a voice message.`, {
      parse_mode: "Markdown",
    });
    logger.info({ voiceOutputEnabled }, "Voice output toggled");
  });

  // /status
  bot.command("status", async (ctx) => {
    const sessions = stateManager.getActiveSessions();
    const jobStats = stateManager.getJobStats();
    const lane = telegramLane(ctx.chat.id);
    const executorState = stateManager.getCurrentExecutor(lane);

    let statusText = "*Status*\n\n";

    // Executor state
    if (executorState) {
      const age = Math.round((Date.now() - executorState.switchedAt) / 1000 / 60);
      statusText += `Executor: *${executorState.executor}*`;
      if (executorState.model) statusText += ` (${executorState.model})`;
      statusText += `\nSwitched: ${age}m ago (${executorState.messageCount} msgs)\n\n`;
    } else {
      statusText += "Executor: *claude* (default)\n\n";
    }

    // Session state
    if (sessions.length === 0) {
      statusText += "No active sessions.\n";
    } else {
      for (const s of sessions) {
        const age = Math.round((Date.now() - s.lastActivityAt) / 1000 / 60);
        statusText += `Session: ${age}m ago (${s.messageCount} msgs)\n`;
      }
    }
    statusText += `\nJobs: ${jobStats.pending} pending, ${jobStats.running} running`;

    try {
      await ctx.reply(statusText, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(statusText.replace(/[*_`]/g, ""));
    }
  });

  // /jobs
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
      const lastRun = job.lastRun ? formatRelativeTime(job.lastRun) : "never";
      const failures = job.consecutiveFailures > 0 ? ` (${job.consecutiveFailures} failures)` : "";
      response += `${status} *${job.config.id}*\n`;
      response += `  └ ${job.config.name}\n`;
      response += `  └ \`${job.config.cron}\`\n`;
      response += `  └ Last: ${lastRun}${failures}\n\n`;
    }
    response += "_Use /trigger <id> to run manually_";

    try {
      await ctx.reply(response, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(response.replace(/[*_`]/g, ""));
    }
  });

  // /trigger
  bot.command("trigger", async (ctx) => {
    if (!schedulerRef) {
      await ctx.reply("Scheduler not initialized.");
      return;
    }
    const jobId = ctx.match?.trim();
    if (!jobId) {
      await ctx.reply("Usage: /trigger <job-id>");
      return;
    }
    const job = schedulerRef.getJob(jobId);
    if (!job) {
      await ctx.reply(`Job not found: ${jobId}`);
      return;
    }
    const triggered = schedulerRef.triggerJob(jobId);
    if (triggered) {
      await ctx.reply(`⏳ Triggered: *${job.config.name}*`, { parse_mode: "Markdown" });
    } else {
      await ctx.reply(`Failed to trigger job: ${jobId}`);
    }
  });

  // /remind
  bot.command("remind", async (ctx) => {
    const input = ctx.match?.trim() || "";
    if (!input) {
      await ctx.reply("Usage: /remind <time> <message>\n\nExample: /remind in 30 minutes check oven");
      return;
    }
    const parsed = parseReminder(input);
    if (!parsed.time) {
      await ctx.reply("Could not parse time. Try: /remind in 30 minutes <message>");
      return;
    }
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
    await ctx.reply(
      `⏰ Reminder set for ${formatDateTime(parsed.time)} (${reminderRelativeTime(parsed.time)})\n\n"${parsed.message}"\n\nID: \`${id.slice(0, 8)}\``,
      { parse_mode: "Markdown" }
    );
  });

  // /reminders
  bot.command("reminders", async (ctx) => {
    const pending = reminderManager.getPendingByChat(ctx.chat.id);
    if (pending.length === 0) {
      await ctx.reply("No pending reminders.");
      return;
    }
    let response = "*Pending Reminders*\n\n";
    for (const r of pending) {
      const preview = r.message.length > 40 ? r.message.slice(0, 40) + "..." : r.message;
      response += `⏰ *${reminderRelativeTime(r.dueAt)}* (${formatDateTime(r.dueAt)})\n`;
      response += `   ${preview}\n`;
      response += `   ID: \`${r.id.slice(0, 8)}\`\n\n`;
    }
    response += "_Use /cancel <id> to cancel_";
    try {
      await ctx.reply(response, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(response.replace(/[*_`]/g, ""));
    }
  });

  // /cancel
  bot.command("cancel", async (ctx) => {
    const idPrefix = ctx.match?.trim();
    if (!idPrefix) {
      await ctx.reply("Usage: /cancel <reminder-id>");
      return;
    }
    const pending = reminderManager.getPendingByChat(ctx.chat.id);
    const match = pending.find((r) => r.id.startsWith(idPrefix));
    if (!match) {
      await ctx.reply(`Reminder not found: ${idPrefix}`);
      return;
    }
    const cancelled = reminderManager.cancel(match.id);
    if (cancelled) {
      await ctx.reply(`✅ Cancelled: "${match.message.slice(0, 50)}..."`);
    } else {
      await ctx.reply(`Failed to cancel: ${idPrefix}`);
    }
  });

  // /debug - system status for remote diagnosis
  bot.command("debug", async (ctx) => {
    try {
      const healthRes = await fetch("http://127.0.0.1:3000/health");
      const health = await healthRes.json() as {
        status: string;
        checks: Record<string, boolean>;
      };
      const uptime = Math.round(process.uptime() / 60);
      const mem = process.memoryUsage();
      const sessions = stateManager.getActiveSessions();
      const jobStats = stateManager.getJobStats();

      const checksStr = Object.entries(health.checks)
        .map(([k, v]) => `${k}: ${v ? "✓" : "✗"}`)
        .join("\n");

      const debugInfo = `*Homer Debug*
Uptime: ${uptime}m
Status: ${health.status}
Memory: ${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.heapTotal / 1024 / 1024)}MB
Sessions: ${sessions.length}
Jobs: ${jobStats.pending} pending, ${jobStats.running} running

*Checks:*
${checksStr}`;

      await ctx.reply(debugInfo, { parse_mode: "Markdown" });
    } catch (error) {
      await ctx.reply(`Debug failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  // /restart - trigger graceful restart (launchd will respawn)
  bot.command("restart", async (ctx) => {
    await ctx.reply("Initiating graceful restart...");
    logger.info("Manual restart requested via Telegram");
    setTimeout(() => process.exit(0), 1000);
  });

  // /meeting - process audio document
  bot.command("meeting", async (ctx) => {
    if (!meetingManagerRef) {
      await ctx.reply("Meeting system not initialized.");
      return;
    }

    const input = ctx.match?.trim() || "";

    // Parse: "title with attendee1, attendee2" or just "title"
    let title = "Meeting";
    let attendees: string[] = [];

    const withMatch = input.match(/^(.+?)\s+with\s+(.+)$/i);
    if (withMatch) {
      title = (withMatch[1] || "").trim();
      attendees = (withMatch[2] || "").split(/[,;]/).map((a) => a.trim()).filter(Boolean);
    } else if (input) {
      title = input;
    }

    // Check if there's a reply to a document
    const replyMsg = ctx.message?.reply_to_message;
    if (replyMsg && "document" in replyMsg && replyMsg.document) {
      const doc = replyMsg.document;
      const mimeType = doc.mime_type || "";

      // Check if it's an audio file
      if (!mimeType.startsWith("audio/") && !mimeType.includes("ogg") && !mimeType.includes("mpeg")) {
        await ctx.reply("Please reply to an audio file (MP3, M4A, OGG, WAV).");
        return;
      }

      // Check file size (20MB limit for bot API)
      if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
        await ctx.reply("Audio file too large. Maximum 20MB (~80 minutes of audio).");
        return;
      }

      try {
        const file = await ctx.api.getFile(doc.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
        const response = await fetch(fileUrl);
        const audioBuffer = Buffer.from(await response.arrayBuffer());

        const fileName = doc.file_name || "audio.m4a";

        // Start background processing
        const meetingId = await meetingManagerRef.startMeetingProcessing({
          title,
          audioBuffer,
          audioFileName: fileName,
          attendees,
          chatId: ctx.chat.id,
        });

        await ctx.reply(
          `*Processing Meeting*\n\n` +
            `Title: ${title}\n` +
            `Attendees: ${attendees.length > 0 ? attendees.join(", ") : "(none specified)"}\n` +
            `File: ${fileName}\n` +
            `Size: ${(audioBuffer.length / 1024 / 1024).toFixed(1)} MB\n\n` +
            `ID: \`${meetingId}\`\n\n` +
            `_Processing in background. You'll be notified when complete._`,
          { parse_mode: "Markdown" }
        );

        logger.info({ meetingId, title, attendees }, "Meeting processing started");
      } catch (error) {
        logger.error({ error }, "Failed to process meeting document");
        await ctx.reply(`Error: ${error instanceof Error ? error.message : "Failed to download file"}`);
      }
      return;
    }

    // No document - show usage
    await ctx.reply(
      "*Meeting Recording*\n\n" +
        "To transcribe a meeting:\n" +
        "1. Send an audio file (MP3, M4A, OGG, WAV)\n" +
        "2. Reply to it with: `/meeting Title with Attendee1, Attendee2`\n\n" +
        "Example:\n" +
        "`/meeting Weekly Standup with Sarah, Mike, Alex`\n\n" +
        "_Attendees help identify speakers in the transcript._",
      { parse_mode: "Markdown" }
    );
  });

  // /meetings - list recent meetings
  bot.command("meetings", async (ctx) => {
    if (!meetingManagerRef) {
      await ctx.reply("Meeting system not initialized.");
      return;
    }

    const meetings = meetingManagerRef.listMeetings({ limit: 10 });

    if (meetings.length === 0) {
      await ctx.reply("No meetings recorded yet.\n\nSend an audio file and reply with `/meeting Title with Attendees`");
      return;
    }

    let response = "*Recent Meetings*\n\n";
    for (const m of meetings) {
      const date = new Date(m.date).toLocaleDateString();
      const duration = formatDuration(m.durationSeconds);
      const statusIcon = m.status === "complete" ? "✅" : m.status === "error" ? "❌" : "⏳";

      response += `${statusIcon} *${m.title}*\n`;
      response += `   ${date} • ${duration}\n`;
      response += `   Attendees: ${m.attendees.join(", ") || "—"}\n`;
      response += `   ID: \`${m.id}\`\n\n`;
    }

    try {
      await ctx.reply(response, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(response.replace(/[*_`]/g, ""));
    }
  });

  // Handle audio documents (alternative trigger)
  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const mimeType = doc.mime_type || "";
    const caption = ctx.message.caption || "";

    // Check if it's an audio file
    if (!mimeType.startsWith("audio/") && !mimeType.includes("ogg") && !mimeType.includes("mpeg")) {
      // Treat as general attachment
      try {
        const lane = telegramLane(ctx.chat.id);
        const filePath = await saveTelegramFile(ctx, doc.file_id, doc.file_name || doc.file_unique_id, ctx.chat.id);
        const pending = pendingAttachments.get(lane) ?? [];

        if (caption.trim()) {
          const parsed = parseCommand(caption.trim());
          if (!parsed) {
            addPendingAttachment(lane, filePath);
            await ctx.reply("Attachment saved. Send a message to process it.");
            return;
          }

          // Handle executor switch in caption
          if (isPureExecutorSwitch(parsed) && parsed.newExecutor) {
            const model = getExecutorModel(parsed.newExecutor);
            runManager.cancelRun(lane, "executor switch");
            stateManager.setCurrentExecutor(lane, parsed.newExecutor, model, null);
            addPendingAttachment(lane, filePath);
            await ctx.reply(`Switched to ${parsed.newExecutor}. Attachment saved.`);
            return;
          }

          // Handle /new in caption
          if (parsed.isNewSession) {
            runManager.cancelRun(lane, "new session");
            stateManager.clearExecutor(lane);
            if (!parsed.query) {
              addPendingAttachment(lane, filePath);
              await ctx.reply("Fresh session started. Attachment saved.");
              return;
            }
          }

          // Handle executor switch with query
          if (isExecutorSwitchWithQuery(parsed) && parsed.newExecutor) {
            const model = getExecutorModel(parsed.newExecutor);
            runManager.cancelRun(lane, "executor switch with query");
            stateManager.setCurrentExecutor(lane, parsed.newExecutor, model, null);
          }

          const attachments = [...pending, filePath];
          pendingAttachments.delete(lane);
          await handleNewExecution(ctx, parsed, stateManager, runManager, false, attachments);
          return;
        }

        addPendingAttachment(lane, filePath);
        await ctx.reply("Attachment saved. Send a message to process it.");
      } catch (error) {
        logger.error({ error }, "Failed to save attachment");
        await ctx.reply(`Attachment error: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
      return;
    }

    // Check if caption has /meeting command
    if (!caption.toLowerCase().startsWith("/meeting")) {
      // Prompt user
      await ctx.reply(
        `Audio file detected: *${doc.file_name || "audio"}*\n\n` +
          `To transcribe, reply to this message with:\n` +
          `/meeting Title with Attendee1, Attendee2`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Process the /meeting command with this document
    if (!meetingManagerRef) {
      await ctx.reply("Meeting system not initialized.");
      return;
    }

    // Parse caption: "/meeting title with attendees"
    const input = caption.slice(8).trim(); // Remove "/meeting"
    let title = "Meeting";
    let attendees: string[] = [];

    const withMatch = input.match(/^(.+?)\s+with\s+(.+)$/i);
    if (withMatch) {
      title = (withMatch[1] || "").trim();
      attendees = (withMatch[2] || "").split(/[,;]/).map((a) => a.trim()).filter(Boolean);
    } else if (input) {
      title = input;
    }

    // Check file size
    if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
      await ctx.reply("Audio file too large. Maximum 20MB (~80 minutes of audio).");
      return;
    }

    try {
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const audioBuffer = Buffer.from(await response.arrayBuffer());

      const fileName = doc.file_name || "audio.m4a";

      const meetingId = await meetingManagerRef.startMeetingProcessing({
        title,
        audioBuffer,
        audioFileName: fileName,
        attendees,
        chatId: ctx.chat.id,
      });

      await ctx.reply(
        `*Processing Meeting*\n\n` +
          `Title: ${title}\n` +
          `Attendees: ${attendees.length > 0 ? attendees.join(", ") : "(none specified)"}\n` +
          `File: ${fileName}\n\n` +
          `ID: \`${meetingId}\`\n\n` +
          `_Processing in background. You'll be notified when complete._`,
        { parse_mode: "Markdown" }
      );

      logger.info({ meetingId, title, attendees }, "Meeting processing started from caption");
    } catch (error) {
      logger.error({ error }, "Failed to process meeting document");
      await ctx.reply(`Error: ${error instanceof Error ? error.message : "Failed to download file"}`);
    }
  });

  // Handle photo attachments
  bot.on("message:photo", async (ctx) => {
    try {
      if (!ctx.chat) return;
      const lane = telegramLane(ctx.chat.id);
      const caption = ctx.message.caption || "";
      const photos = ctx.message.photo;
      if (!photos || photos.length === 0) return;

      // Use the highest resolution photo
      const photo = photos[photos.length - 1];
      if (!photo) return;
      const filePath = await saveTelegramFile(ctx, photo.file_id, `${photo.file_id}.jpg`, ctx.chat.id);
      const pending = pendingAttachments.get(lane) ?? [];

      if (caption.trim()) {
        const parsed = parseCommand(caption.trim());
        if (!parsed) {
          addPendingAttachment(lane, filePath);
          await ctx.reply("Photo saved. Send a message to process it.");
          return;
        }

        if (isPureExecutorSwitch(parsed) && parsed.newExecutor) {
          const model = getExecutorModel(parsed.newExecutor);
          runManager.cancelRun(lane, "executor switch");
          stateManager.setCurrentExecutor(lane, parsed.newExecutor, model, null);
          addPendingAttachment(lane, filePath);
          await ctx.reply(`Switched to ${parsed.newExecutor}. Photo saved.`);
          return;
        }

        if (parsed.isNewSession) {
          runManager.cancelRun(lane, "new session");
          stateManager.clearExecutor(lane);
          if (!parsed.query) {
            addPendingAttachment(lane, filePath);
            await ctx.reply("Fresh session started. Photo saved.");
            return;
          }
        }

        if (isExecutorSwitchWithQuery(parsed) && parsed.newExecutor) {
          const model = getExecutorModel(parsed.newExecutor);
          runManager.cancelRun(lane, "executor switch with query");
          stateManager.setCurrentExecutor(lane, parsed.newExecutor, model, null);
        }

        const attachments = [...pending, filePath];
        pendingAttachments.delete(lane);
        await handleNewExecution(ctx, parsed, stateManager, runManager, false, attachments);
        return;
      }

      addPendingAttachment(lane, filePath);
      await ctx.reply("Photo saved. Send a message to process it.");
    } catch (error) {
      logger.error({ error }, "Failed to save photo attachment");
      await ctx.reply(`Photo error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  // /search
  bot.command("search", async (ctx) => {
    const query = ctx.match?.trim();
    if (!query) {
      await ctx.reply("Usage: /search <query>");
      return;
    }
    const searchConfig: SearchConfig = {
      supabaseUrl: config.search.supabaseUrl,
      supabaseAnonKey: config.search.supabaseAnonKey,
      openaiApiKey: config.voice.openaiApiKey,
      embeddingModel: config.search.embeddingModel,
      chunkSize: config.search.chunkSize,
      chunkOverlap: config.search.chunkOverlap,
    };

    try {
      const results = await hybridSearch(query, searchConfig);
      const formatted = formatHybridResults(results, query);
      try {
        await ctx.reply(formatted, { parse_mode: "Markdown" });
      } catch {
        await ctx.reply(formatted.replace(/[*_`]/g, ""));
      }
    } catch (error) {
      logger.warn({ error, query }, "Hybrid search failed, using grep");
      try {
        const results = await searchMemory(query);
        const formatted = formatSearchResults(results, query);
        await ctx.reply(formatted);
      } catch (grepError) {
        logger.error({ error: grepError, query }, "Search failed");
        await ctx.reply(`Search failed: ${error instanceof Error ? error.message : "Unknown"}`);
      }
    }
  });

  // Voice messages
  bot.on("message:voice", async (ctx) => {
    if (!config.voice.enabled) {
      await ctx.reply("Voice messages disabled.");
      return;
    }
    const voiceConfig: VoiceConfig = {
      elevenLabsApiKey: config.voice.elevenLabsApiKey,
      elevenLabsVoiceId: config.voice.elevenLabsVoiceId,
      elevenLabsModel: config.voice.elevenLabsModel,
    };
    if (!voiceConfig.elevenLabsApiKey) {
      await ctx.reply("ElevenLabs API key not configured.");
      return;
    }

    try {
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const audioBuffer = Buffer.from(await response.arrayBuffer());

      await ctx.replyWithChatAction("typing");
      const transcription = await transcribeAudio(audioBuffer, voiceConfig);

      if (!transcription.text.trim()) {
        await ctx.reply("Could not transcribe audio.");
        return;
      }

      logger.info({ text: transcription.text.slice(0, 50) }, "Voice transcribed");

      const parsed = parseCommand(transcription.text);
      if (!parsed) {
        await ctx.reply("Could not parse voice message.");
        return;
      }

      // Handle executor switches via voice
      if (isPureExecutorSwitch(parsed) && parsed.newExecutor) {
        const model = getExecutorModel(parsed.newExecutor);
        const lane = telegramLane(ctx.chat.id);
        runManager.cancelRun(lane, "voice executor switch");
        stateManager.setCurrentExecutor(lane, parsed.newExecutor, model, null);
        await ctx.reply(`Switched to ${parsed.newExecutor}`);
        return;
      }

      if (!parsed.query) {
        await ctx.reply("Could not parse voice message.");
        return;
      }

      const responseText = await handleNewExecution(ctx, parsed, stateManager, runManager, true);

      // Only output voice if toggle is enabled
      if (voiceOutputEnabled && voiceConfig.elevenLabsApiKey && responseText) {
        try {
          const ttsText = truncateForTTS(responseText);
          // Use OGG/Opus format for proper Telegram voice notes with turbo model for low latency
          const ttsOptions: SynthesisOptions = { format: "ogg_opus", turbo: true };
          const synthesis = await synthesizeSpeech(ttsText, voiceConfig, ttsOptions);
          await ctx.replyWithVoice(new InputFile(synthesis.audio, "response.ogg"));
        } catch (ttsError) {
          logger.warn({ error: ttsError }, "TTS failed");
          await ctx.reply(responseText);
        }
      } else if (responseText) {
        await ctx.reply(responseText);
      }
    } catch (error) {
      logger.error({ error }, "Voice processing failed");
      await ctx.reply(`Voice error: ${error instanceof Error ? error.message : "Unknown"}`);
    }
  });

  // Text messages - unified command handling
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const lane = telegramLane(ctx.chat.id);

    // Check for overnight work requests first (e.g., "work on xyz tonight")
    // This handles special patterns before regular command parsing
    try {
      const wasOvernightRequest = await handleOvernightMessage(ctx, text);
      if (wasOvernightRequest) {
        return; // Overnight handler took care of it
      }
    } catch (error) {
      logger.warn({ error }, "Overnight message handling failed, falling back to normal flow");
    }

    const parsed = parseCommand(text);

    if (!parsed) {
      await ctx.reply("Could not parse message.");
      return;
    }

    // Handle deprecation warnings
    if (parsed.deprecationWarning) {
      await ctx.reply(`⚠️ ${parsed.deprecationWarning}`);
    }

    // Handle pure executor switch (no query)
    if (isPureExecutorSwitch(parsed) && parsed.newExecutor) {
      const model = getExecutorModel(parsed.newExecutor);
      runManager.cancelRun(lane, "executor switch");
      stateManager.setCurrentExecutor(lane, parsed.newExecutor, model, null);

      await ctx.reply(
        `Switched to *${parsed.newExecutor}*${model ? ` (${model})` : ""}\n\n` +
          `All messages will now use ${parsed.newExecutor} until you switch or use /new.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Handle /new command
    if (parsed.isNewSession) {
      // Clear executor state
      runManager.cancelRun(lane, "new session");
      stateManager.clearExecutor(lane);

      // If there's a query with /new, execute it fresh
      if (parsed.query) {
        const attachments = consumePendingAttachments(lane);
        await handleNewExecution(ctx, parsed, stateManager, runManager, false, attachments);
      } else {
        await ctx.reply("Fresh session started. Executor reset to Claude.");
      }
      return;
    }

    // Handle executor switch with query (e.g., "/gemini what's the weather")
    if (isExecutorSwitchWithQuery(parsed) && parsed.newExecutor) {
      const model = getExecutorModel(parsed.newExecutor);
      runManager.cancelRun(lane, "executor switch with query");
      stateManager.setCurrentExecutor(lane, parsed.newExecutor, model, null);

      // Execute the query with the new executor
      const attachments = consumePendingAttachments(lane);
      await handleNewExecution(ctx, parsed, stateManager, runManager, false, attachments);
      return;
    }

    // Regular message - use current executor state
    if (!parsed.query && !parsed.command) {
      await ctx.reply("Send a message to continue.");
      return;
    }

    const attachments = consumePendingAttachments(lane);
    await handleNewExecution(ctx, parsed, stateManager, runManager, false, attachments);
  });

  return bot;
}

/**
 * Get subagent prefix for prompt injection (legacy support)
 */
/**
 * Handle execution with the new command system
 */
async function handleNewExecution(
  ctx: Context,
  parsed: ParsedCommand,
  stateManager: StateManager,
  runManager: CLIRunManager,
  returnResponse: boolean,
  attachments: string[] = []
): Promise<string | void> {
  if (!ctx.chat) {
    if (returnResponse) return "Error: chat context unavailable.";
    return;
  }
  const lane = telegramLane(ctx.chat.id);
  const session = stateManager.getOrCreateSession(lane);

  // Get current executor state
  const executorState = stateManager.getCurrentExecutor(lane);
  const currentExecutor = executorState?.executor || "claude";

  // Determine if this is a new session
  const isNewSession = parsed.isNewSession;

  logger.info(
    {
      cwd: parsed.cwd,
      executor: currentExecutor,
      newSession: isNewSession,
      queryPreview: parsed.query.slice(0, 50),
    },
    "Executing command"
  );

  let streamingMsg = null;
  if (!returnResponse) {
    if (ENABLE_STREAMING) {
      streamingMsg = await sendThinkingIndicator(ctx);
    } else {
      await ctx.replyWithChatAction("typing");
    }
  }

  try {
    // Load memory context for new sessions or first message
    let memoryContext = "";
    if (isNewSession || !executorState?.sessionId) {
      const bootstrap = await loadBootstrapFiles();
      if (bootstrap) {
        memoryContext = `<context>\n${bootstrap}\n</context>\n\n`;
        logger.debug({ length: bootstrap.length }, "Loaded memory context");
      }
    }

    if (runManager.getActiveRun(lane)) {
      await ctx.reply("A run is already in progress for this chat. Please wait.");
      return;
    }

    const finalQuery = memoryContext + parsed.query;

    const { result } = await runManager.startRun({
      lane,
      query: finalQuery,
      cwd: parsed.cwd,
      attachments,
    });

    const runResult = await result;

    // Update session activity
    stateManager.updateSessionActivity(session.id);

    if (returnResponse) {
      return runResult.output;
    }

    if (ENABLE_STREAMING && streamingMsg) {
      await editWithResponse(ctx, streamingMsg, runResult.output);
    } else {
      const chunks = chunkMessage(runResult.output);
      for (const chunk of chunks) {
        try {
          await ctx.reply(chunk, { parse_mode: "Markdown" });
        } catch {
          await ctx.reply(chunk);
        }
      }
    }
  } catch (error) {
    logger.error({ error, query: parsed.query }, "Execution failed");
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    if (returnResponse) {
      return `Error: ${errorMessage}`;
    }

    if (ENABLE_STREAMING && streamingMsg) {
      await editWithResponse(ctx, streamingMsg, `Error: ${errorMessage}`);
    } else {
      await ctx.reply(`Error: ${errorMessage}`);
    }
  }
}

function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 1000 / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

export async function startBot(bot: Bot): Promise<void> {
  logger.info("Starting H.O.M.E.R bot...");

  // Clear any existing webhooks to prevent 409 conflicts after restart
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    logger.info("Webhook cleared for clean polling start");
  } catch (error) {
    logger.warn({ error }, "Failed to clear webhook (may not exist)");
  }

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

export function getMeetingManager(): MeetingManager | null {
  return meetingManagerRef;
}
