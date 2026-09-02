// Load .env BEFORE installing fatal handlers — fatal-handlers reads secrets
// (Twilio creds, owner phone) at module-init time, and the launchd plist no
// longer carries those secrets. Without this line, a fresh-install daemon would
// have no env on first import.
import "dotenv/config";

// Install fatal handlers FIRST - before any other imports that might throw
import { installFatalHandlers, registerFatalExitTask, registerShutdownTask, sendStartupFailureSms } from "./fatal-handlers.js";
installFatalHandlers();

// Import daemon lock
import { acquireDaemonLock, releaseDaemonLock } from "./daemon/lock.js";

import { createBot, startBot, setScheduler, setMeetingManager } from "./bot/index.js";
import { markTelegramDisabled, stopTelegramPolling } from "./bot/polling-health.js";
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
import { ensureMemoryScaffold } from "./memory/bootstrap.js";
import { initConnectivityMonitor } from "./heartbeat/index.js";
import { staleMapCleaner } from "./utils/stale-map-cleaner.js";
import { processRegistry } from "./process/registry.js";
import { SessionTimeoutManager } from "./process/timeout-manager.js";
import { cleanupScheduler } from "./process/cleanup-scheduler.js";
import { browserLeaseBroker, reapResidentChromeOnFatalExit, residentChromeSupervisor, RESIDENT_CDP_PROFILE } from "./scraping/chrome-launcher.js";
import { startBrowserControlServer, stopBrowserControlServer } from "./scraping/browser-control.js";
import { BrowserStatusService } from "./scraping/browser-status.js";
import { SessionStewardship } from "./scraping/session-stewardship.js";
import { runAgentBrowserBindingSelfTest } from "./scraping/agent-browser-binding.js";
import { initFallbackChain } from "./process/fallback-chain.js";
import { initTraceWriter, rehydrateHealth, setGitCommit } from "./executors/trace-writer.js";
import {
  readDiskBuildInfo,
  setRuntimeBuildInfo,
  writeRuntimeBuildStamp,
} from "./utils/build-info.js";
import type { FastifyInstance } from "fastify";
import type { Bot } from "grammy";
import type { VoiceConfig } from "./voice/types.js";
import { getRuntimePaths } from "./utils/runtime-paths.js";


async function main(): Promise<void> {
  const runtimePaths = getRuntimePaths();
  // Log build version for stale-daemon detection
  const buildInfo = readDiskBuildInfo();
  if (buildInfo) {
    setRuntimeBuildInfo(buildInfo);
    logger.info({ build: buildInfo }, "H.O.M.E.R Phase 5 starting up...");
  } else {
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

  try {
    await ensureMemoryScaffold(stateManager.getDb());
  } catch (err) {
    logger.warn({ err }, "Memory scaffold initialization failed (continuing)");
  }

  // Seed internal-baseline job rows once (harness-independence cutover, B-semantics).
  // Idempotent + guarded by a marker so a switch-all is never undone by a restart.
  try {
    const { seedInternalHarnessBaselines } = await import("./scheduler/harness-baseline-seed.js");
    const seed = seedInternalHarnessBaselines(stateManager.getDb());
    if (seed.seeded) logger.info({ jobRows: seed.jobRows }, "Internal harness baselines seeded");
  } catch (err) {
    logger.warn({ err }, "Internal-baseline seed failed to run (non-blocking)");
  }

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
  residentChromeSupervisor.start();
  registerShutdownTask(() => residentChromeSupervisor.stop());
  // Crash-only: SIGTERM the Chrome WE launched (bounded), unless the lease ledger shows
  // a live external holder — then leave it up for the next generation to adopt.
  registerFatalExitTask(() => reapResidentChromeOnFatalExit("uncaught-fatal"));
  const browserStatus = new BrowserStatusService(() => {
    const status = residentChromeSupervisor.status();
    return { generation: status.generation, supervisorPid: process.pid, chromePid: status.chromePid,
      ownership: status.ownership, degradedReason: browserLeaseBroker.degraded(),
      adoptionGraceUntil: (() => { const at = browserLeaseBroker.adoptionGraceUntil(); return at ? new Date(at).toISOString() : null; })(),
      externalReservation: (() => {
        const r = browserLeaseBroker.externalReservationSummary();
        return r ? { surface: r.surface, owner: r.owner, expiresAt: new Date(r.expiresAt).toISOString(), granted: r.granted } : null;
      })(),
      profilePath: RESIDENT_CDP_PROFILE,
      cdp: {
        state: status.cdp.state, pages: status.cdp.pages, restartCount: status.cdp.restartCount, restartDeferrals: status.cdp.restartDeferrals,
        // F9: while maintenance is on the supervisor neither probes nor relaunches, and the
        // only consumer that pages anyone (the hourly health check) prints `cdp.reason`.
        // Name the way out there, in the exact form the operator must type.
        reason: status.maintenance.enabled
          ? `MAINTENANCE${status.maintenance.reason ? ` (${status.maintenance.reason})` : ""} — no probing or relaunch until: bin/browserctl maintenance off`
          : status.cdp.reason ?? null,
      },
      maintenance: status.maintenance, records: browserLeaseBroker.snapshot() };
  });
  const publishBrowserStatus = () => { try { browserStatus.publish(); } catch (err) { logger.warn({ err }, "Chrome status publication failed"); } };
  browserLeaseBroker.setTransitionHandler(publishBrowserStatus);
  residentChromeSupervisor.setTransitionHandler(publishBrowserStatus);
  browserStatus.start(); registerShutdownTask(() => browserStatus.stop());
  const stewardship = new SessionStewardship(browserLeaseBroker, browserStatus);
  const browserControlServer = startBrowserControlServer(
    browserLeaseBroker,
    (enabled, reason) => residentChromeSupervisor.setMaintenance(enabled, reason),
    undefined,
    (surface) => stewardship.touch(surface, true),
  );
  registerShutdownTask(() => stopBrowserControlServer(browserControlServer));
  /**
   * Bring the browser up, but NEVER let it decide whether Homer runs.
   *
   * 2026-09-01: `stewardship.ensureSurfaces()` threw "broker is draining leases" (the
   * supervisor had started a drain after the singleton forward), the rejection reached
   * `main().catch`, and the daemon exited 1 — 63 times in 70 minutes. The scheduler, the
   * Telegram bot, memory, telephony and every non-browser job were all healthy and all
   * went down with it.
   *
   * ALLOWED WHILE THE BROWSER IS DEGRADED: everything that does not drive Chrome —
   * the scheduler and all non-browser jobs, the Telegram bot, memory indexing/search,
   * telephony, the queue worker, the browser-control socket (so `browserctl status` and
   * `browserctl maintenance` still answer), and status publication.
   * REFUSED WHILE DEGRADED: agent-browser reservations — BrowserLeaseBroker.reserveExternal
   * throws on `degradedReason`, so browser-driven jobs fail fast with a clear reason
   * instead of attaching to a browser we could not verify.
   */
  //
  // Logging is deliberately rate limited (M5): the retry runs every 60 s and an
  // unthrottled pair of ERROR lines per attempt is ~2,880/day into stdout.log, which buries
  // the one line that matters. First three attempts at error, then one warn every 10 min
  // while the reason is unchanged, and one info on recovery.
  const BROWSER_RETRY_MS = 60_000;
  const BROWSER_LOUD_ATTEMPTS = 3;
  const BROWSER_QUIET_LOG_MS = 10 * 60_000;
  const BROWSER_SMS_AFTER_MS = 10 * 60_000;
  let browserAttempt = 0;
  let browserLastLoggedReason: string | null = null;
  let browserLastLoggedAt = 0;
  let browserDegradedSince: number | null = null;
  let browserSmsSent = false;

  // M4: a degradation that outlives BROWSER_SMS_AFTER_MS gets ONE SMS. Telegram is not a
  // reliable channel for it — the same daemon may also be failing to poll. Never called on a
  // healthy-but-reserved browser, so a fence cannot raise a false alarm.
  const maybeSendBrowserDegradedSms = (): void => {
    if (browserSmsSent || browserDegradedSince === null) return;
    if (Date.now() - browserDegradedSince < BROWSER_SMS_AFTER_MS) return;
    browserSmsSent = true;
    void import("./telephony/emergency-sms.js")
      .then(({ sendEmergencySms }) => sendEmergencySms(`Homer agent-browser degraded >10m: ${browserLeaseBroker.degraded() ?? "unknown"}`))
      .catch(() => { /* best effort */ });
  };

  const noteBrowserFailure = (reason: string, phase: "startup" | "retry"): void => {
    browserAttempt++;
    if (browserDegradedSince === null) browserDegradedSince = Date.now();
    const changed = reason !== browserLastLoggedReason;
    const quietElapsed = Date.now() - browserLastLoggedAt >= BROWSER_QUIET_LOG_MS;
    if (browserAttempt <= BROWSER_LOUD_ATTEMPTS || changed) {
      logger.error({ err: reason, phase, attempt: browserAttempt }, "Agent-browser automation degraded (daemon continues)");
    } else if (quietElapsed) {
      logger.warn({ err: reason, phase, attempt: browserAttempt, degradedForMs: Date.now() - browserDegradedSince },
        "Agent-browser automation still degraded");
    } else {
      return; // suppressed entirely; the next 10-minute tick reports it
    }
    browserLastLoggedReason = reason;
    browserLastLoggedAt = Date.now();
  };

  /**
   * The serialized-binding self-test verdict, tracked SEPARATELY from the CDP probe (F3).
   * A CDP probe says nothing about whether agent-browser can bind, so an external holder
   * appearing must never be allowed to clear a real self-test failure, and "healthy but
   * reserved" must never cancel the retry that would eventually re-run the test (F4).
   */
  let browserSelfTest: "untested" | "passed" | "failed" = "untested";

  const runBrowserSelfTest = async (phase: "startup" | "retry"): Promise<boolean> => {
    try {
      await runAgentBrowserBindingSelfTest();
      browserSelfTest = "passed";
      browserLeaseBroker.setDegraded(null);
      logger.info({ sessions: 2, policy: "globally-serialized", concurrentCreationRefused: true }, "Agent-browser startup serialized-binding self-test passed");
      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      browserSelfTest = "failed";
      browserLeaseBroker.setDegraded(reason);
      noteBrowserFailure(`serialized-binding self-test: ${reason}`, phase);
      return false;
    }
  };

  /**
   * N4: a browser that is HEALTHY BUT RESERVED is not degraded.
   *
   * `runAgentBrowserBindingSelfTest` opens with `reserveExternal`, which the adoption fence
   * refuses outright and which the global agent-browser serialization refuses while an
   * external holder is live. So on any restart that adopts a Chrome — the normal outcome now
   * that the exit paths leave it for QC's backfill — the self-test failed, the broker was
   * flagged degraded, `/status` and the health check reported a fault that did not exist, and
   * the 10-minute clock could fire a false `agent-browser degraded >10m` SMS. The self-test is
   * an assertion we cannot make without taking the browser from its holder, so it is deferred
   * and health is judged on the CDP probe alone — but only for a browser that has not ALREADY
   * failed the test for a real reason (F3).
   */
  const browserIsReserved = (): { reserved: boolean; fencedUntil: number | null; externalHolders: number } => {
    const fencedUntil = browserLeaseBroker.adoptionGraceUntil();
    const externalHolders = browserLeaseBroker.externalLeaseCount();
    return { reserved: fencedUntil !== null || externalHolders > 0, fencedUntil, externalHolders };
  };
  const markBrowserHealthy = (): void => {
    if (browserDegradedSince !== null) {
      logger.info({ degradedForMs: Date.now() - browserDegradedSince, attempts: browserAttempt },
        "Agent-browser automation recovered; broker no longer degraded");
    }
    browserLeaseBroker.setDegraded(null);
    browserAttempt = 0; browserDegradedSince = null; browserSmsSent = false;
    browserLastLoggedReason = null; browserLastLoggedAt = 0;
  };

  /**
   * `armRetry` — keep (or start) the 60 s recovery loop. False ONLY when the self-test has
   * actually passed, so a deferred test is always re-run once the holder releases (F4).
   * `degraded` — whether anything is genuinely wrong; drives the startup log line.
   */
  const bringBrowserUp = async (phase: "startup" | "retry"): Promise<{ armRetry: boolean; degraded: boolean }> => {
    const reservation = browserIsReserved();
    if (!reservation.reserved) {
      const selfTestOk = await runBrowserSelfTest(phase);
      try {
        await residentChromeSupervisor.heartbeatNow();
        await stewardship.ensureSurfaces();
        if (selfTestOk) {
          markBrowserHealthy();
          return { armRetry: false, degraded: false };
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        browserLeaseBroker.setDegraded(reason);
        noteBrowserFailure(`surface reconcile: ${reason}`, phase);
      }
      maybeSendBrowserDegradedSms();
      return { armRetry: true, degraded: true };
    }

    // Reserved. Judge on the CDP probe FIRST, so a transient reconcile error cannot pre-empt
    // the healthy-but-reserved verdict and start the degraded clock for a healthy browser (F7).
    let cdpState: "ready" | "empty" | "absent" = "absent";
    let cdpReason: string | null = null;
    try {
      await residentChromeSupervisor.heartbeatNow();
      const cdp = residentChromeSupervisor.status().cdp;
      cdpState = cdp.state;
      cdpReason = cdp.reason ?? null;
    } catch (err) {
      cdpReason = err instanceof Error ? err.message : String(err);
    }

    if (cdpState !== "ready") {
      const reason = `CDP ${cdpState}${cdpReason ? ` (${cdpReason})` : ""} while the browser is reserved`;
      browserLeaseBroker.setDegraded(reason);
      noteBrowserFailure(reason, phase);
      maybeSendBrowserDegradedSms();
      return { armRetry: true, degraded: true };
    }

    // Reconcile is best-effort on a reserved-healthy browser: a failure here is logged, not
    // treated as a degradation of agent-browser automation (F7).
    try {
      await stewardship.ensureSurfaces();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), phase },
        "Surface reconcile failed on a reserved but healthy browser — retrying on the next tick");
    }

    if (browserSelfTest === "failed") {
      // F3: agent-browser is genuinely broken and a holder merely appeared. Keep the existing
      // degradation and the retry; a CDP probe is no evidence that binding works.
      logger.warn(
        { phase, externalHolders: reservation.externalHolders, degradedReason: browserLeaseBroker.degraded() },
        "Browser reserved, but the serialized-binding self-test has already FAILED — degradation retained",
      );
      maybeSendBrowserDegradedSms();
      return { armRetry: true, degraded: true };
    }

    markBrowserHealthy();
    logger.info(
      { phase, externalHolders: reservation.externalHolders,
        fencedUntil: reservation.fencedUntil ? new Date(reservation.fencedUntil).toISOString() : null },
      "Browser healthy but reserved by an external holder — serialized-binding self-test deferred, NOT degraded; it will run once the holder releases",
    );
    // F4: armRetry stays true so the deferred test is actually re-run later.
    return { armRetry: true, degraded: false };
  };

  const startupBrowser = await bringBrowserUp("startup");
  stewardship.start(); registerShutdownTask(() => stewardship.stop());
  residentChromeSupervisor.setSurfaceReconciler(() => stewardship.ensureSurfaces());
  if (startupBrowser.armRetry) {
    // Keep retrying in the background so a browser that recovers (Chrome relaunched, an
    // orphan adopted, `browserctl maintenance off`) re-arms automation without a daemon
    // restart, AND so a self-test deferred because the browser was reserved is actually run
    // once the holder releases (F4). An ordinary supervisor relaunch calls beginGeneration(),
    // which clears the broker's `draining` flag, so even the "broker is draining leases"
    // failure recovers here; only maintenance mode is permanent, and the loop skips that.
    const retryTimer: ReturnType<typeof setInterval> = setInterval(() => {
      void (async () => {
        if (residentChromeSupervisor.maintenance().enabled) return;
        // The self-test is never run against a browser an EXTERNAL holder is driving —
        // taking the agent surface from QC's backfill mid-run is the interruption we are
        // avoiding — but bringBrowserUp handles that itself now (N4). The interval is
        // cleared ONLY once the self-test has actually passed, never on a CDP probe (F3).
        const result = await bringBrowserUp("retry");
        if (!result.armRetry) clearInterval(retryTimer);
      })();
    }, BROWSER_RETRY_MS);
    retryTimer.unref?.();
    registerShutdownTask(() => clearInterval(retryTimer));
    if (startupBrowser.degraded) {
      logger.error({ retryMs: BROWSER_RETRY_MS }, "Starting H.O.M.E.R with agent-browser DEGRADED — scheduler, bot and non-browser jobs run normally");
    } else {
      logger.info({ retryMs: BROWSER_RETRY_MS }, "Starting H.O.M.E.R with the serialized-binding self-test deferred (browser reserved) — it will run once the holder releases");
    }
  }
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

  // Create the bot only when Telegram credentials are configured.
  let bot: Bot | null = null;
  if (config.telegram.enabled) {
    bot = createBot(stateManager, cliRunManager);
  } else {
    markTelegramDisabled();
    logger.warn("Telegram disabled: set TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID to enable chat, reminders, and push notifications");
  }

  // Initialize meeting manager
  const voiceConfigForMeetings: VoiceConfig = {
    elevenLabsApiKey: config.voice.elevenLabsApiKey,
    elevenLabsVoiceId: config.voice.elevenLabsVoiceId,
    elevenLabsModel: config.voice.elevenLabsModel,
    voiceIdModelPath: config.voice.voiceIdModelPath,
  };
  const meetingManager = new MeetingManager({
    stateManager,
    voiceConfig: voiceConfigForMeetings,
    bot: bot ?? undefined,
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
    bot: bot ?? undefined,
    chatId: config.telegram.enabled ? config.telegram.allowedChatId : undefined,
    alertOnFailure: config.telegram.enabled,
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

  const runtimeStamp = writeRuntimeBuildStamp("homer-daemon");
  if (runtimeStamp) {
    logger.info({ runtimeStamp }, "Runtime build stamp written");
  } else {
    logger.warn("Failed to write runtime build stamp");
  }
  // Graceful shutdown — two-phase approach:
  // Phase 1: Stop accepting new work (immediate)
  // Phase 2: Cancel + drain active processes (15s default)
  // Budget: Phase 1 (~5s) + Phase 2 cancel+drain (15s) + force-kill (5s) + Phase 3 (~5s) = ~30s
  const DRAIN_TIMEOUT_MS = parseInt(process.env.DRAIN_TIMEOUT_MS ?? "15000", 10);

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
    if (bot) {
      // Tell the polling supervisor this stop is deliberate, so its backoff loop does
      // not restart the poller while the daemon is shutting down.
      stopTelegramPolling();
      await bot.stop();
    }
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

  if (bot) {
    await startBot(bot);
  } else {
    logger.info("Homer daemon running without Telegram polling");
  }
}

main().catch((error) => {
  logger.fatal({ err: error, error }, "Failed to start H.O.M.E.R");
  // F9: a startup failure used to be silent — the supervisor restarts forever with a 30 s
  // backoff cap and the "Homer restarted" ping needs a successful bot.start, so a rejected
  // startup await (port busy, migration error) could loop all night unheard. One SMS,
  // rate-limited on disk across restarts so the loop itself cannot page 63 times.
  sendStartupFailureSms(error);
  // This path calls process.exit directly and therefore never runs the registered
  // shutdown tasks — which is how the 2026-09-01 Chrome orphan outlived its daemon.
  // Reap it here (lease-ledger aware) before exiting, with a hard cap so a wedged
  // Chrome cannot hold the exit open.
  void Promise.race([
    reapResidentChromeOnFatalExit("main-catch"),
    new Promise<void>((r) => setTimeout(r, 8_000)),
  ]).catch(() => { /* already fatal — never let the reaper mask the exit */ })
    .finally(() => process.exit(1));
});
