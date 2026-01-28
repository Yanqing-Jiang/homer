import { createBot, startBot, setScheduler, getReminderManager, setBrowserManager } from "./bot/index.js";
import { logger } from "./utils/logger.js";
import cron from "node-cron";
import { StateManager } from "./state/manager.js";
import { config } from "./config/index.js";
import { QueueManager } from "./queue/manager.js";
import { QueueWorker } from "./queue/worker.js";
import { createWebServer, startWebServer, stopWebServer } from "./web/server.js";
import { Scheduler } from "./scheduler/index.js";
import { BrowserManager } from "./browser/index.js";
import { checkAndFlushExpiringSessions } from "./memory/flush.js";
import { organizeMemory } from "./scheduler/jobs/organize-memory.js";
import { getMemoryIndexer, closeMemoryIndexer } from "./memory/indexer.js";
import type { FastifyInstance } from "fastify";
import type { Bot } from "grammy";

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

  // Initialize state manager
  const stateManager = new StateManager(config.paths.database);

  // Initialize queue manager
  const queueManager = new QueueManager(stateManager);

  // Initialize browser manager
  const browserManager = new BrowserManager(stateManager["db"], {
    profilesPath: config.paths.browserProfiles,
    defaultTimeout: 30000,
    headless: true,
  });
  setBrowserManager(browserManager);

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

  // Schedule memory organization at 3 AM daily
  cron.schedule("0 3 * * *", async () => {
    logger.info("Running scheduled memory organization");
    try {
      const result = await organizeMemory();
      logger.info(
        {
          date: result.date,
          entriesProcessed: result.entriesProcessed,
          updatesWritten: result.updatesWritten,
        },
        "Memory organization completed"
      );
    } catch (error) {
      logger.error({ error }, "Memory organization failed");
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
  const bot = createBot(stateManager);

  // Schedule reminder checker every minute
  cron.schedule("* * * * *", async () => {
    await checkAndSendReminders(bot);
  });

  // Initialize scheduler
  const scheduler = new Scheduler(bot, config.telegram.allowedChatId, stateManager);
  setScheduler(scheduler);
  await scheduler.start();

  // Initialize queue worker
  const queueWorker = new QueueWorker(queueManager, stateManager, bot);
  queueWorker.start();

  // Start web server if enabled (pass scheduler for dashboard)
  let webServer: FastifyInstance | null = null;
  if (config.web.enabled) {
    webServer = await createWebServer(stateManager, queueManager, scheduler);
    await startWebServer(webServer);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down...");
    scheduler.stop();
    queueWorker.stop();
    await browserManager.close();
    await bot.stop();
    if (webServer) {
      await stopWebServer(webServer);
    }
    closeMemoryIndexer();
    stateManager.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await startBot(bot);
}

main().catch((error) => {
  logger.fatal({ error }, "Failed to start H.O.M.E.R");
  process.exit(1);
});
