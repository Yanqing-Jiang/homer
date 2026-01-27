import { createBot, startBot, setScheduler, getReminderManager } from "./bot/index.js";
import { logger } from "./utils/logger.js";
import cron from "node-cron";
import { StateManager } from "./state/manager.js";
import { config } from "./config/index.js";
import { QueueManager } from "./queue/manager.js";
import { QueueWorker } from "./queue/worker.js";
import { createWebServer, startWebServer, stopWebServer } from "./web/server.js";
import { Scheduler } from "./scheduler/index.js";
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
  logger.info("H.O.M.E.R Phase 4 starting up...");

  // Initialize state manager
  const stateManager = new StateManager(config.paths.database);

  // Initialize queue manager
  const queueManager = new QueueManager(stateManager);

  // Schedule session cleanup every hour
  cron.schedule("0 * * * *", () => {
    logger.debug("Running scheduled session cleanup");
    stateManager.cleanupExpiredSessions();
    stateManager.cleanupOldJobs();
    stateManager.cleanupOldReminders();
  });

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
    await bot.stop();
    if (webServer) {
      await stopWebServer(webServer);
    }
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
