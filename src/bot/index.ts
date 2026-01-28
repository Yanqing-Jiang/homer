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
import { searchMemory, formatSearchResults } from "../memory/search.js";
import { hybridSearch, formatHybridResults, indexMemoryFiles, getIndexStatus } from "../search/index.js";
import type { SearchConfig } from "../search/types.js";
import { transcribeAudio, synthesizeSpeech, truncateForTTS } from "../voice/index.js";
import type { VoiceConfig } from "../voice/types.js";
import { InputFile } from "grammy";
import { BrowserManager } from "../browser/index.js";
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
let browserManagerRef: BrowserManager | null = null;

export function setScheduler(scheduler: Scheduler): void {
  schedulerRef = scheduler;
}

export function setReminderManager(reminderManager: ReminderManager): void {
  reminderManagerRef = reminderManager;
}

export function setBrowserManager(browserManager: BrowserManager): void {
  browserManagerRef = browserManager;
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
      "H.O.M.E.R Phase 6 ready.\n\n" +
        "*Routing (auto-detected):*\n" +
        "Just type - context detected from query\n" +
        "/new - Start fresh session\n" +
        "/g - Gemini subagent\n" +
        "/x - Codex subagent\n\n" +
        "*Session:*\n" +
        "/status - Active sessions\n" +
        "/jobs - Scheduled jobs\n" +
        "/trigger <id> - Run job\n\n" +
        "*Reminders:*\n" +
        "/remind <time> <msg>\n" +
        "/reminders - List\n" +
        "/cancel <id>\n\n" +
        "*Search:*\n" +
        "/search <query> - Hybrid search\n" +
        "/index - Reindex memory\n" +
        "/indexstatus - Index status\n\n" +
        "*Browser:*\n" +
        "/browse [profile] <url>\n" +
        "/snap [profile]\n" +
        "/act [profile] <action>\n" +
        "/auth [profile] [target]\n" +
        "/profiles - List profiles\n\n" +
        "Just type or speak - I'll figure out the context.",
      { parse_mode: "Markdown" }
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

  // Handle /search command - search memory files (hybrid vector + keyword)
  bot.command("search", async (ctx) => {
    const query = ctx.match?.trim();

    if (!query) {
      await ctx.reply("Usage: /search <query>\n\nSearches across all memory files using hybrid search.");
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
      // Try hybrid search first, falls back to grep internally
      const results = await hybridSearch(query, searchConfig);
      const formatted = formatHybridResults(results, query);

      try {
        await ctx.reply(formatted, { parse_mode: "Markdown" });
      } catch {
        await ctx.reply(formatted.replace(/[*_`]/g, ""));
      }
    } catch (error) {
      // Ultimate fallback to simple grep
      logger.warn({ error, query }, "Hybrid search failed, using grep fallback");
      try {
        const results = await searchMemory(query);
        const formatted = formatSearchResults(results, query);
        await ctx.reply(formatted);
      } catch (grepError) {
        logger.error({ error: grepError, query }, "All search methods failed");
        await ctx.reply(`Search failed: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }
  });

  // Handle /index command - reindex memory files
  bot.command("index", async (ctx) => {
    const searchConfig: SearchConfig = {
      supabaseUrl: config.search.supabaseUrl,
      supabaseAnonKey: config.search.supabaseAnonKey,
      openaiApiKey: config.voice.openaiApiKey,
      embeddingModel: config.search.embeddingModel,
      chunkSize: config.search.chunkSize,
      chunkOverlap: config.search.chunkOverlap,
    };

    if (!searchConfig.supabaseUrl || !searchConfig.supabaseAnonKey) {
      await ctx.reply("Supabase not configured. Search will use grep fallback.");
      return;
    }

    if (!searchConfig.openaiApiKey) {
      await ctx.reply("OpenAI API key not configured for embeddings.");
      return;
    }

    await ctx.reply("Indexing memory files...");

    try {
      const result = await indexMemoryFiles(searchConfig);
      await ctx.reply(
        `Indexing complete:\n` +
        `  - Indexed: ${result.indexed}\n` +
        `  - Skipped: ${result.skipped}\n` +
        `  - Errors: ${result.errors}`
      );
    } catch (error) {
      logger.error({ error }, "Indexing failed");
      await ctx.reply(`Indexing failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  // Handle /indexstatus command - show index status
  bot.command("indexstatus", async (ctx) => {
    const searchConfig: SearchConfig = {
      supabaseUrl: config.search.supabaseUrl,
      supabaseAnonKey: config.search.supabaseAnonKey,
      openaiApiKey: config.voice.openaiApiKey,
      embeddingModel: config.search.embeddingModel,
      chunkSize: config.search.chunkSize,
      chunkOverlap: config.search.chunkOverlap,
    };

    try {
      const status = await getIndexStatus(searchConfig);

      if (status.totalDocuments === 0) {
        await ctx.reply("No documents indexed. Use /index to index memory files.");
        return;
      }

      let response = `*Index Status*\n\n`;
      response += `Total chunks: ${status.totalDocuments}\n\n`;

      for (const stat of status.fileStats) {
        const fileName = stat.filePath.split("/").pop();
        const date = new Date(stat.lastIndexed).toLocaleDateString();
        response += `*${fileName}*: ${stat.chunks} chunks (${date})\n`;
      }

      try {
        await ctx.reply(response, { parse_mode: "Markdown" });
      } catch {
        await ctx.reply(response.replace(/[*_`]/g, ""));
      }
    } catch (error) {
      logger.error({ error }, "Failed to get index status");
      await ctx.reply(`Failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  // Handle /browse command - navigate and screenshot
  bot.command("browse", async (ctx) => {
    if (!browserManagerRef) {
      await ctx.reply("Browser manager not initialized.");
      return;
    }

    const args = ctx.match?.trim() || "";
    const parts = args.split(/\s+/);

    // Parse: /browse [profile] <url>
    let profileName = "default";
    let url = parts[0] || "";

    if (parts.length >= 2) {
      // Check if first arg looks like a URL
      const firstArg = parts[0] || "";
      if (!firstArg.startsWith("http")) {
        profileName = firstArg;
        url = parts[1] || "";
      }
    }

    if (!url || !url.startsWith("http")) {
      await ctx.reply("Usage: /browse [profile] <url>\n\nExample: /browse https://google.com");
      return;
    }

    try {
      await ctx.replyWithChatAction("upload_photo");
      const result = await browserManagerRef.browse(profileName, url);

      await ctx.replyWithPhoto(new InputFile(result.screenshot.buffer, "screenshot.png"), {
        caption: `${result.title}\n${url}`,
      });
    } catch (error) {
      logger.error({ error, url, profile: profileName }, "Browse failed");
      await ctx.reply(`Browse failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  // Handle /snap command - screenshot current page
  bot.command("snap", async (ctx) => {
    if (!browserManagerRef) {
      await ctx.reply("Browser manager not initialized.");
      return;
    }

    const profileName = ctx.match?.trim() || "default";

    try {
      await ctx.replyWithChatAction("upload_photo");
      const result = await browserManagerRef.snap(profileName);

      await ctx.replyWithPhoto(new InputFile(result.screenshot.buffer, "screenshot.png"), {
        caption: `${result.title}\n${result.url}`,
      });
    } catch (error) {
      logger.error({ error, profile: profileName }, "Snap failed");
      await ctx.reply(`Snap failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  // Handle /act command - execute browser action
  bot.command("act", async (ctx) => {
    if (!browserManagerRef) {
      await ctx.reply("Browser manager not initialized.");
      return;
    }

    const args = ctx.match?.trim() || "";
    const parts = args.split(/\s+/);

    // Parse: /act [profile] <action>
    let profileName = "default";
    let actionStr = args;

    // Check if first arg is a profile name (not an action keyword)
    const actionKeywords = ["click", "type", "scroll", "wait", "navigate", "goto", "go"];
    const firstPart = parts[0] || "";
    if (parts.length >= 2 && !actionKeywords.includes(firstPart.toLowerCase())) {
      profileName = firstPart;
      actionStr = parts.slice(1).join(" ");
    }

    if (!actionStr) {
      await ctx.reply(
        "Usage: /act [profile] <action>\n\n" +
        "Actions:\n" +
        "  click <selector>\n" +
        "  type <selector> <text>\n" +
        "  scroll up|down\n" +
        "  wait <ms>\n" +
        "  navigate <url>"
      );
      return;
    }

    try {
      const result = await browserManagerRef.act(profileName, actionStr);
      await ctx.reply(result);
    } catch (error) {
      logger.error({ error, action: actionStr, profile: profileName }, "Action failed");
      await ctx.reply(`Action failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  // Handle /auth command - start headed auth flow
  bot.command("auth", async (ctx) => {
    if (!browserManagerRef) {
      await ctx.reply("Browser manager not initialized.");
      return;
    }

    const args = ctx.match?.trim() || "";
    const parts = args.split(/\s+/);

    // Parse: /auth [profile] [target]
    const firstPart = parts[0] || "";
    const secondPart = parts[1] || "";
    let profileName = firstPart || "google";
    let target: "google" | "notebooklm" = "google";

    if (secondPart === "notebooklm" || firstPart === "notebooklm") {
      target = "notebooklm";
      if (firstPart === "notebooklm") {
        profileName = "google";
      }
    }

    try {
      const result = await browserManagerRef.startAuth(profileName, target);
      await ctx.reply(result);
    } catch (error) {
      logger.error({ error, profile: profileName, target }, "Auth start failed");
      await ctx.reply(`Auth failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  // Handle /profiles command - list browser profiles
  bot.command("profiles", async (ctx) => {
    if (!browserManagerRef) {
      await ctx.reply("Browser manager not initialized.");
      return;
    }

    const profiles = browserManagerRef.listProfiles();

    if (profiles.length === 0) {
      await ctx.reply("No browser profiles. Use /browse or /auth to create one.");
      return;
    }

    let response = "*Browser Profiles*\n\n";
    for (const p of profiles) {
      const authIcon = p.authState === "authenticated" ? "✅" : p.authState === "pending" ? "⏳" : "❌";
      const age = Math.round((Date.now() - p.lastUsedAt) / 1000 / 60);
      response += `${authIcon} *${p.name}*\n`;
      response += `  └ Last used: ${age}m ago\n`;
      response += `  └ Headless: ${p.headlessCapable ? "yes" : "no"}\n\n`;
    }

    try {
      await ctx.reply(response, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(response.replace(/[*_`]/g, ""));
    }
  });

  // Handle voice messages
  bot.on("message:voice", async (ctx) => {
    if (!config.voice.enabled) {
      await ctx.reply("Voice messages are disabled.");
      return;
    }

    const voiceConfig: VoiceConfig = {
      openaiApiKey: config.voice.openaiApiKey,
      elevenLabsApiKey: config.voice.elevenLabsApiKey,
      elevenLabsVoiceId: config.voice.elevenLabsVoiceId,
      elevenLabsModel: config.voice.elevenLabsModel,
    };

    if (!voiceConfig.openaiApiKey) {
      await ctx.reply("OpenAI API key not configured for voice transcription.");
      return;
    }

    try {
      // Download voice message
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const audioBuffer = Buffer.from(await response.arrayBuffer());

      // Transcribe
      await ctx.replyWithChatAction("typing");
      const transcription = await transcribeAudio(audioBuffer, voiceConfig);

      if (!transcription.text.trim()) {
        await ctx.reply("Could not transcribe audio. Please try again.");
        return;
      }

      logger.info({ text: transcription.text.slice(0, 50) }, "Voice transcribed");

      // Process as text message
      const text = transcription.text;
      const route = parseRoute(text);

      let responseText: string;

      if (!route) {
        // This shouldn't happen with auto-detection
        responseText = "Could not parse your voice message. Please try again.";
      } else if (!route.query) {
        responseText = `Switched to ${route.context}${route.subcontext ? `/${route.subcontext}` : ""}. Send your query.`;
        stateManager.getOrCreateSession(route.context);
      } else {
        responseText = await handleVoiceExecution(
          ctx,
          route.context,
          route.cwd,
          route.query,
          stateManager,
          {
            newSession: route.newSession,
            subagent: route.subagent,
            subcontext: route.subcontext,
          }
        );
      }

      // Synthesize response if ElevenLabs is configured
      if (voiceConfig.elevenLabsApiKey && responseText) {
        try {
          const ttsText = truncateForTTS(responseText);
          const synthesis = await synthesizeSpeech(ttsText, voiceConfig);
          await ctx.replyWithVoice(new InputFile(synthesis.audio, "response.mp3"));
        } catch (ttsError) {
          logger.warn({ error: ttsError }, "TTS failed, sending text instead");
          await ctx.reply(responseText);
        }
      } else {
        await ctx.reply(responseText);
      }
    } catch (error) {
      logger.error({ error }, "Voice processing failed");
      await ctx.reply(`Voice error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  // Handle all text messages
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;

    // Parse the route (now always returns a route with auto-detection)
    const route = parseRoute(text);

    if (!route) {
      // This shouldn't happen with the new router, but handle gracefully
      await ctx.reply("Could not parse your message. Try again.");
      return;
    }

    // Empty query after prefix - just switch context
    if (!route.query) {
      await ctx.reply(`Switched to ${route.context}${route.subcontext ? `/${route.subcontext}` : ""}. Send your query.`);
      // Create/touch session for this context
      stateManager.getOrCreateSession(route.context);
      return;
    }

    // Log context detection info for debugging
    if (route.detectedContext) {
      logger.debug(
        {
          type: route.detectedContext.type,
          confidence: route.detectedContext.confidence,
          project: route.detectedContext.project,
          area: route.detectedContext.area,
          cwd: route.cwd,
        },
        "Context auto-detected"
      );
    }

    await handleExecution(ctx, route.context, route.cwd, route.query, stateManager, {
      newSession: route.newSession,
      subagent: route.subagent,
      subcontext: route.subcontext,
    });
  });

  return bot;
}

interface ExecutionOptions {
  newSession: boolean;
  subagent?: "gemini" | "codex";
  subcontext?: string;
}

/**
 * Handle execution for voice messages - returns response text instead of sending
 */
async function handleVoiceExecution(
  _ctx: Context,
  context: string,
  cwd: string,
  query: string,
  stateManager: StateManager,
  options: ExecutionOptions
): Promise<string> {
  const { newSession, subagent, subcontext } = options;

  const session = stateManager.getOrCreateSession(context);

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
      source: "voice",
    },
    "Executing voice command"
  );

  try {
    let memoryContext = "";
    if (newSession || !claudeSessionId) {
      const bootstrap = await loadBootstrapFiles(context, cwd);
      if (bootstrap) {
        memoryContext = `<context>\n${bootstrap}\n</context>\n\n`;
      }
    }

    const subagentPrefix = getSubagentPrefix(subagent);
    const finalQuery = memoryContext + subagentPrefix + query;

    const result = await executeClaudeCommand(finalQuery, {
      cwd,
      claudeSessionId,
      subagent,
    });

    if (result.claudeSessionId) {
      stateManager.setClaudeSessionId(context, result.claudeSessionId, subcontext);
    } else if (claudeSessionId) {
      stateManager.updateClaudeSessionActivity(context, subcontext);
    }

    stateManager.updateSessionActivity(session.id);

    const { cleanedResponse } = await processMemoryUpdates(result.output, context);

    return cleanedResponse;
  } catch (error) {
    logger.error({ error, context, query }, "Voice execution failed");
    return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
  }
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
