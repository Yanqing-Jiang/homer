// Install fatal handlers FIRST - before any other imports that might throw
import { installFatalHandlers, registerShutdownTask } from "./fatal-handlers.js";
installFatalHandlers();

// Import daemon lock
import { acquireDaemonLock, releaseDaemonLock } from "./daemon/lock.js";

import { createBot, startBot, setScheduler, setMeetingManager } from "./bot/index.js";
import { logger } from "./utils/logger.js";
import { StateManager } from "./state/manager.js";
import { config } from "./config/index.js";
import { QueueManager } from "./queue/manager.js";
import { QueueWorker } from "./queue/worker.js";
import { createWebServer, startWebServer, stopWebServer } from "./web/server.js";
import { setWebMeetingsManager, setWebBot, setWebCLIRunManager } from "./web/routes.js";
import { MeetingManager } from "./meetings/index.js";
import { Scheduler } from "./scheduler/index.js";
import { setWriterStateManager } from "./memory/writer.js";
import { getMemoryIndexer, closeMemoryIndexer } from "./memory/indexer.js";
import { executeClaudeCommand } from "./executors/claude.js";
import { initializeGeminiCLIAccountManager, closeGeminiCLIAccountManager } from "./executors/gemini-cli.js";
import { CLIRunManager } from "./executors/cli-runner.js";
import { runMigrations } from "./state/migrations/index.js";
import { initConnectivityMonitor } from "./heartbeat/index.js";
import { staleMapCleaner } from "./utils/stale-map-cleaner.js";
import { processRegistry } from "./process/registry.js";
import { SessionTimeoutManager } from "./process/timeout-manager.js";
import { cleanupScheduler } from "./process/cleanup-scheduler.js";
import { initFallbackChain } from "./process/fallback-chain.js";
import type { FastifyInstance } from "fastify";
import type { VoiceConfig } from "./voice/types.js";
import { getRuntimePaths } from "./utils/runtime-paths.js";

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

async function main(): Promise<void> {
  const runtimePaths = getRuntimePaths();
  // Log build version for stale-daemon detection
  try {
    const { readFileSync } = await import("fs");
    const versionPath = new URL("./.build-version", import.meta.url).pathname;
    const buildInfo = JSON.parse(readFileSync(versionPath, "utf-8"));
    logger.info({ build: buildInfo }, "H.O.M.E.R Phase 5 starting up...");
  } catch {
    logger.info("H.O.M.E.R Phase 5 starting up... (no build version stamp)");
  }

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

  // Wire writer to use session_summaries instead of daily logs
  setWriterStateManager(stateManager);

  // CLI run manager (non-streaming executor control)
  const cliRunManager = new CLIRunManager(stateManager);

  // Run database migrations
  logger.info("Running database migrations...");
  runMigrations(stateManager.getDb());

  // Initialize Gemini CLI account manager with shared DB state.
  initializeGeminiCLIAccountManager(stateManager.getDb(), {
    rateLimitCooldownMs: parseIntEnv("GEMINI_RATE_LIMIT_COOLDOWN_MS", 60_000),
    authFailureCooldownMs: parseIntEnv("GEMINI_AUTH_FAILURE_COOLDOWN_MS", 300_000),
    runtimeFailureCooldownMs: parseIntEnv("GEMINI_RUNTIME_FAILURE_COOLDOWN_MS", 15_000),
    disableAfterFailures: parseIntEnv("GEMINI_DISABLE_AFTER_FAILURES", 5),
    disabledRecheckMs: parseIntEnv("GEMINI_DISABLED_RECHECK_MS", 30 * 60 * 1000),
    lockAcquireTimeoutMs: parseIntEnv("GEMINI_LOCK_TIMEOUT_MS", 15_000),
    syncIntervalMs: parseIntEnv("GEMINI_ACCOUNT_SYNC_INTERVAL_MS", 5_000),
  });

  // Initialize process lifecycle management
  processRegistry.init(stateManager.getDb());
  processRegistry.recover();
  const timeoutManager = new SessionTimeoutManager();
  timeoutManager.start();
  cleanupScheduler.init(stateManager.getDb());
  initFallbackChain(stateManager.getDb());
  logger.info("Process lifecycle management initialized");

  // Cleanup scheduler init (the cron is now in scheduler as "daemon-cleanup")
  // Note: cleanupScheduler.init() was called above

  // Recover stale jobs from previous crashed instances
  logger.info("Checking for stale jobs from previous runs...");
  const recoveredCount = stateManager.recoverStaleJobs(30_000); // 30 seconds
  if (recoveredCount > 0) {
    logger.warn({ count: recoveredCount }, "Recovered stale jobs");
    try {
      const { sendEmergencySms } = await import("./telephony/emergency-sms.js");
      await sendEmergencySms(`Homer restarted, recovered ${recoveredCount} stale jobs`);
    } catch { /* best-effort */ }
  }

  // Clean up zombie cli_runs left from crashed/restarted daemon
  // Note: scheduled_job_state flags and orphaned runs are cleaned in Scheduler.start()
  const zombieCliRuns = stateManager.failAllRunningCliRuns();
  if (zombieCliRuns > 0) {
    logger.warn({ count: zombieCliRuns }, "Cleaned up zombie CLI runs from previous daemon instance");
  }

  // Initialize queue manager
  const queueManager = new QueueManager(stateManager);

  // Session maintenance cron is now in scheduler as "session-maintenance"

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

  // Reminder checker cron is now in scheduler as "reminder-check"

  // Initialize scheduler
  const scheduler = new Scheduler(bot, config.telegram.allowedChatId, stateManager);
  setScheduler(scheduler);
  await scheduler.start();

  // Initialize connectivity monitor (no self-ticking timer — called by health check job)
  const connectivityMonitor = initConnectivityMonitor({
    bot,
    chatId: config.telegram.allowedChatId,
    alertOnFailure: true,
  });
  // One-time initial connectivity check after startup
  connectivityMonitor.checkAll().catch((err) => {
    logger.warn({ error: err }, "Initial connectivity check failed");
  });

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
        cwd: runtimePaths.homeDir,
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

  // Graceful shutdown — two-phase approach:
  // Phase 1: Stop accepting new work (immediate)
  // Phase 2: Drain active processes (configurable timeout, default 5min)
  // Drain timeout for active executor processes. Must be < SHUTDOWN_TIMEOUT_MS (330s)
  // to leave room for Phase 1 (stop accepting) and Phase 3 (cleanup).
  // Budget: Phase 1 (~5s) + Phase 2 drain (270s) + force-kill (10s) + Phase 3 (~5s) = ~290s < 330s
  const DRAIN_TIMEOUT_MS = parseInt(process.env.DRAIN_TIMEOUT_MS ?? "270000", 10);

  // Phase 1: Stop accepting new work
  registerShutdownTask(() => {
    logger.info("Phase 1: Stopping new work acceptance...");
    scheduler.stop();
    queueWorker.stop();
    connectivityMonitor.stop();
    staleMapCleaner.stop();
    timeoutManager.stop();
  });
  registerShutdownTask(async () => {
    logger.info("Phase 1: Stopping bot and web server...");
    await bot.stop();
    if (webServer) {
      await stopWebServer(webServer);
    }
  });

  // Phase 2: Drain active executor processes
  registerShutdownTask(async () => {
    const activeExecutors = processRegistry.getByType("executor").length;
    const activeCliRuns = cliRunManager.activeCount;
    const totalActive = activeExecutors + activeCliRuns;

    if (totalActive === 0) {
      logger.info("Phase 2: No active processes to drain");
    } else {
      logger.info(
        { activeExecutors, activeCliRuns, drainTimeoutMs: DRAIN_TIMEOUT_MS },
        "Phase 2: Draining active processes..."
      );

      const drainStart = Date.now();
      const pollInterval = 2000;

      while (Date.now() - drainStart < DRAIN_TIMEOUT_MS) {
        const currentExecutors = processRegistry.getByType("executor").length;
        const currentCliRuns = cliRunManager.activeCount;

        if (currentExecutors === 0 && currentCliRuns === 0) {
          logger.info(
            { drainDuration: Date.now() - drainStart },
            "Phase 2: All processes drained cleanly"
          );
          break;
        }

        logger.debug(
          { activeExecutors: currentExecutors, activeCliRuns: currentCliRuns },
          "Phase 2: Waiting for processes to complete..."
        );
        await new Promise<void>((r) => setTimeout(r, pollInterval));
      }

      // If still active after drain timeout, force kill
      const remainingExecutors = processRegistry.getByType("executor").length;
      const remainingCliRuns = cliRunManager.activeCount;

      if (remainingExecutors > 0 || remainingCliRuns > 0) {
        logger.warn(
          { remainingExecutors, remainingCliRuns },
          "Phase 2: Drain timeout — force-killing remaining processes"
        );
        processRegistry.killAll("SIGTERM");
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            processRegistry.killAll("SIGKILL");
            resolve();
          }, 5000);
        });
      }
    }

    processRegistry.stop();
  });

  // Phase 3: Cleanup and close
  registerShutdownTask(() => {
    logger.info("Closing memory indexer...");
    closeMemoryIndexer();
  });
  registerShutdownTask(() => {
    logger.info("Closing Gemini CLI account manager...");
    closeGeminiCLIAccountManager();
  });
  registerShutdownTask(() => {
    logger.info("Marking running jobs and CLI runs as failed...");
    stateManager.failAllRunningJobs();
    const failedRuns = stateManager.failAllRunningCliRuns();
    if (failedRuns > 0) {
      logger.info({ count: failedRuns }, "Marked running CLI runs as failed (daemon shutdown)");
    }
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
