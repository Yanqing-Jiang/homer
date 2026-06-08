// Load .env BEFORE installing fatal handlers — fatal-handlers reads secrets
// (Twilio creds, owner phone) at module-init time, and the launchd plist no
// longer carries those secrets. Without this line, a fresh-install daemon would
// have no env on first import.
import "dotenv/config";

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
import { createTelephonyServer, startTelephonyServer, stopTelephonyServer } from "./telephony/server.js";
import { MeetingManager } from "./meetings/index.js";
import { Scheduler } from "./scheduler/index.js";
import { getMemoryIndexer, closeMemoryIndexer } from "./memory/indexer.js";
import { CLIRunManager } from "./executors/cli-runner.js";
import { runMigrations } from "./state/migrations/index.js";
import { initConnectivityMonitor } from "./heartbeat/index.js";
import { staleMapCleaner } from "./utils/stale-map-cleaner.js";
import { processRegistry } from "./process/registry.js";
import { SessionTimeoutManager } from "./process/timeout-manager.js";
import { cleanupScheduler } from "./process/cleanup-scheduler.js";
import { initFallbackChain } from "./process/fallback-chain.js";
import { initTraceWriter, rehydrateHealth, setGitCommit } from "./executors/trace-writer.js";
import { setRuntimeBuildInfo } from "./utils/build-info.js";
import type { FastifyInstance } from "fastify";
import type { VoiceConfig } from "./voice/types.js";
import { getRuntimePaths } from "./utils/runtime-paths.js";
import fs from "fs";
import path from "path";


async function main(): Promise<void> {
  const runtimePaths = getRuntimePaths();
  // Log build version for stale-daemon detection
  try {
    const { readFileSync } = await import("fs");
    const versionPath = new URL("./.build-version", import.meta.url).pathname;
    const buildInfo = JSON.parse(readFileSync(versionPath, "utf-8"));
    setRuntimeBuildInfo(buildInfo);
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

  // CLI run manager (non-streaming executor control)
  const cliRunManager = new CLIRunManager(stateManager);

  // Run database migrations
  logger.info("Running database migrations...");
  runMigrations(stateManager.getDb());

  // Phase 0.9: validate memory-file registry against PATHS (warn-only)
  try {
    const { validateAndLogMemoryRegistry } = await import("./memory/registry.js");
    validateAndLogMemoryRegistry();
  } catch (err) {
    logger.warn({ err }, "Memory registry validation failed to run (non-blocking)");
  }

  // Initialize process lifecycle management
  processRegistry.init(stateManager.getDb());
  processRegistry.recover();
  const timeoutManager = new SessionTimeoutManager();
  timeoutManager.start();
  cleanupScheduler.init(stateManager.getDb());
  initFallbackChain(stateManager.getDb());
  initTraceWriter(stateManager.getDb());
  rehydrateHealth(stateManager.getDb());
  // Cache git commit for execution traces
  try {
    const { execSync } = await import("child_process");
    const commit = execSync("git rev-parse --short HEAD", { cwd: runtimePaths.homerRoot, timeout: 3000 }).toString().trim();
    if (commit) setGitCommit(commit);
  } catch { /* not in a git repo or git not available */ }
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
  logger.info("Meeting manager initialized");

  // Reminder checker cron is now in scheduler as "reminder-check"

  // Initialize canonical memory service with file watcher
  const { getCanonicalMemoryService } = await import("./memory/canonical-service.js");
  const canonicalMemory = getCanonicalMemoryService(stateManager, getMemoryIndexer());
  canonicalMemory.startFileWatcher();

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

  // Start telephony webhook server (Twilio SMS + ElevenLabs call-complete + /health).
  // Replaces the old Fastify web server after the web UI moved to a separate repo.
  let telephonyServer: FastifyInstance | null = null;
  if (config.telephony.enabled) {
    telephonyServer = await createTelephonyServer({
      stateManager,
      bot,
      chatId: config.telegram.allowedChatId,
    });
    await startTelephonyServer(telephonyServer);
  }

  // Graceful shutdown — two-phase approach:
  // Phase 1: Stop accepting new work (immediate)
  // Phase 2: Cancel + drain active processes (15s default)
  // Budget: Phase 1 (~5s) + Phase 2 cancel+drain (15s) + force-kill (5s) + Phase 3 (~5s) = ~30s
  const DRAIN_TIMEOUT_MS = parseInt(process.env.DRAIN_TIMEOUT_MS ?? "15000", 10);

  // Drain sentinel: tells heartbeat we're shutting down gracefully (don't emergency-restart)
  const DRAIN_SENTINEL = path.join(
    runtimePaths.libraryApplicationSupportDir, "Homer", "daemon.draining"
  );
  // Remove stale sentinel from prior crash on startup
  try { fs.unlinkSync(DRAIN_SENTINEL); } catch { /* not present = fine */ }

  // Write drain sentinel FIRST (before stopping web server) so heartbeat sees it
  registerShutdownTask(() => {
    logger.info("Writing drain sentinel...");
    fs.writeFileSync(DRAIN_SENTINEL, JSON.stringify({
      pid: process.pid,
      at: new Date().toISOString(),
    }));
  });

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
    logger.info("Phase 1: Stopping bot and telephony server...");
    await bot.stop();
    if (telephonyServer) {
      await stopTelephonyServer(telephonyServer);
    }
  });

  // Phase 2: Cancel + drain active executor processes
  registerShutdownTask(async () => {
    const cancelledCount = cliRunManager.cancelAll("daemon restart");
    if (cancelledCount > 0) {
      logger.info({ cancelledCount }, "Phase 2: Cancelled active CLI runs");
    }

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
  // Clean up drain sentinel at the very end of shutdown
  registerShutdownTask(() => {
    try { fs.unlinkSync(DRAIN_SENTINEL); } catch { /* already gone = fine */ }
  });

  await startBot(bot);
}

main().catch((error) => {
  logger.fatal({ error }, "Failed to start H.O.M.E.R");
  process.exit(1);
});
