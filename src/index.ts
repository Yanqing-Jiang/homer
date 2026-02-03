// Install fatal handlers FIRST - before any other imports that might throw
import { installFatalHandlers, registerShutdownTask } from "./fatal-handlers.js";
installFatalHandlers();

// Import daemon lock
import { acquireDaemonLock, releaseDaemonLock } from "./daemon/lock.js";

import { createBot, startBot, setScheduler, getReminderManager, setMeetingManager } from "./bot/index.js";
import { logger } from "./utils/logger.js";
import cron from "node-cron";
import { StateManager } from "./state/manager.js";
import { config } from "./config/index.js";
import { QueueManager } from "./queue/manager.js";
import { QueueWorker } from "./queue/worker.js";
import { createWebServer, startWebServer, stopWebServer } from "./web/server.js";
import { setWebMeetingsManager, setWebBot, setWebCLIRunManager } from "./web/routes.js";
import { MeetingManager } from "./meetings/index.js";
import { Scheduler } from "./scheduler/index.js";
import { checkAndFlushExpiringSessions } from "./memory/flush.js";
import { getMemoryIndexer, closeMemoryIndexer } from "./memory/indexer.js";
import { executeClaudeCommand } from "./executors/claude.js";
import { CLIRunManager } from "./executors/cli-runner.js";
import { runMigrations } from "./state/migrations/index.js";
import { initConnectivityMonitor } from "./heartbeat/index.js";
import type { FastifyInstance } from "fastify";
import type { Bot } from "grammy";
import type { VoiceConfig } from "./voice/types.js";

/**
 * Check for pending reminders and send notifications
 */
async function checkAndSendReminders(bot: Bot): Promise<void> {
  const reminderManager = getReminderManager();
  if (!reminderManager) return;

  const pending = reminderManager.getPendingDue();

  for (const reminder of pending) {
    try {
      await bot.api.sendMessage(
        reminder.chatId,
        `⏰ *Reminder*\n\n${reminder.message}`,
        { parse_mode: "Markdown" }
      );
      reminderManager.markSent(reminder.id);
      logger.info({ reminderId: reminder.id }, "Reminder sent");
    } catch (error) {
      logger.error({ error, reminderId: reminder.id }, "Failed to send reminder");
      // Mark as sent anyway to prevent infinite retries
      reminderManager.markSent(reminder.id);
    }
  }
}

async function main(): Promise<void> {
  logger.info("H.O.M.E.R Phase 5 starting up...");

  // Acquire OS-level daemon lock FIRST (before any initialization)
  // Exit with code 0 on any lock failure so launchd won't restart
  try {
    const lockAcquired = acquireDaemonLock();
    if (!lockAcquired) {
      logger.info("Another Homer instance is running. Exiting cleanly.");
      process.exit(0);
    }
  } catch (lockErr) {
    logger.error({ err: lockErr }, "Lock acquisition failed. Exiting cleanly.");
    process.exit(0); // Exit 0 so launchd doesn't restart loop
  }

  // Register lock cleanup on shutdown
  registerShutdownTask(() => {
    logger.info("Releasing daemon lock...");
    releaseDaemonLock();
  });

  // Initialize state manager
  const stateManager = new StateManager(config.paths.database);

  // CLI run manager (non-streaming executor control)
  const cliRunManager = new CLIRunManager(stateManager);

  // Run database migrations
  logger.info("Running database migrations...");
  runMigrations(stateManager.getDb());

  // Recover stale jobs from previous crashed instances
  logger.info("Checking for stale jobs from previous runs...");
  const recoveredCount = stateManager.recoverStaleJobs(30_000); // 30 seconds
  if (recoveredCount > 0) {
    logger.warn({ count: recoveredCount }, "Recovered stale jobs");
  }

  // Initialize queue manager
  const queueManager = new QueueManager(stateManager);

  // Schedule session cleanup and memory flush every hour
  const ttlMs = config.session.ttlHours * 60 * 60 * 1000;
  cron.schedule("0 * * * *", async () => {
    logger.debug("Running scheduled session cleanup and flush");
    stateManager.cleanupExpiredSessions();
    stateManager.cleanupOldJobs();
    stateManager.cleanupOldReminders();

    // Check for sessions about to expire and flush their context
    try {
      await checkAndFlushExpiringSessions(stateManager, ttlMs);
    } catch (error) {
      logger.error({ error }, "Failed to flush expiring sessions");
    }
  });

  // Initialize memory indexer (creates FTS5 tables if needed)
  try {
    const indexer = getMemoryIndexer(config.paths.database);
    logger.info("Memory indexer initialized");
    // Index files on startup
    indexer.indexAllMemoryFiles().catch((err) => {
      logger.warn({ error: err }, "Initial memory indexing failed");
    });
  } catch (error) {
    logger.warn({ error }, "Failed to initialize memory indexer");
  }

  // Create the bot
  const bot = createBot(stateManager, cliRunManager);
  setWebBot(bot); // Enable bot health checks in web routes
  setWebCLIRunManager(cliRunManager);

  // Initialize meeting manager
  const voiceConfigForMeetings: VoiceConfig = {
    elevenLabsApiKey: config.voice.elevenLabsApiKey,
    elevenLabsVoiceId: config.voice.elevenLabsVoiceId,
    elevenLabsModel: config.voice.elevenLabsModel,
  };
  const meetingManager = new MeetingManager({
    stateManager,
    voiceConfig: voiceConfigForMeetings,
    bot,
  });
  await meetingManager.initialize();
  setMeetingManager(meetingManager);
  setWebMeetingsManager(meetingManager);
  logger.info("Meeting manager initialized");

  // Schedule reminder checker every minute
  cron.schedule("* * * * *", async () => {
    await checkAndSendReminders(bot);
  });

  // Initialize scheduler
  const scheduler = new Scheduler(bot, config.telegram.allowedChatId, stateManager);
  setScheduler(scheduler);
  await scheduler.start();

  // Initialize connectivity monitor (30-minute health checks)
  const connectivityMonitor = initConnectivityMonitor({
    bot,
    chatId: config.telegram.allowedChatId,
    alertOnFailure: true,
    checkIntervalMs: 30 * 60 * 1000, // 30 minutes
  });
  connectivityMonitor.start();

  // Initialize queue worker
  const queueWorker = new QueueWorker(queueManager, stateManager, bot);
  queueWorker.start();

  // Start web server if enabled (pass scheduler for dashboard)
  let webServer: FastifyInstance | null = null;
  if (config.web.enabled) {
    // Voice configuration for web voice chat (using ElevenLabs for both STT and TTS)
    const voiceConfig: VoiceConfig = {
      elevenLabsApiKey: config.voice.elevenLabsApiKey,
      elevenLabsVoiceId: config.voice.elevenLabsVoiceId,
      elevenLabsModel: config.voice.elevenLabsModel,
    };

    // Voice message processor - integrates with Claude
    const processVoiceMessage = async (
      text: string,
      conversationId?: string
    ): Promise<{ response: string; conversationId?: string }> => {
      const result = await executeClaudeCommand(text, {
        cwd: "/Users/yj",
        claudeSessionId: conversationId,
      });

      // Process memory updates from voice interaction
      const { processResponse } = await import("./utils/response-processor.js");
      const { cleanedContent } = await processResponse(result.output, "general");

      return {
        response: cleanedContent,
        conversationId: result.claudeSessionId,
      };
    };

    webServer = await createWebServer(stateManager, queueManager, scheduler, {
      voiceConfig: config.voice.enabled ? voiceConfig : undefined,
      processVoiceMessage: config.voice.enabled ? processVoiceMessage : undefined,
    });
    await startWebServer(webServer);
  }

  // Register shutdown tasks with fatal-handlers
  // These will be called during graceful shutdown (SIGINT/SIGTERM)
  registerShutdownTask(() => {
    logger.info("Shutting down connectivity monitor...");
    connectivityMonitor.stop();
  });
  registerShutdownTask(() => {
    logger.info("Shutting down scheduler...");
    scheduler.stop();
  });
  registerShutdownTask(() => {
    logger.info("Shutting down queue worker...");
    queueWorker.stop();
  });
  registerShutdownTask(async () => {
    logger.info("Shutting down bot...");
    await bot.stop();
  });
  if (webServer) {
    registerShutdownTask(async () => {
      logger.info("Shutting down web server...");
      await stopWebServer(webServer!);
    });
  }
  registerShutdownTask(() => {
    logger.info("Closing memory indexer...");
    closeMemoryIndexer();
  });
  registerShutdownTask(() => {
    logger.info("Marking running jobs as failed...");
    stateManager.failAllRunningJobs();
  });
  registerShutdownTask(() => {
    logger.info("Closing state manager...");
    stateManager.close();
  });

  await startBot(bot);
}

main().catch((error) => {
  logger.fatal({ error }, "Failed to start H.O.M.E.R");
  process.exit(1);
});
