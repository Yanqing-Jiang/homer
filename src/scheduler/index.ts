import type { Bot } from "grammy";
import { logger } from "../utils/logger.js";
import { selectRetriesToFire, selectRestartRetries, RESTART_RETRY_DELAY_MS, RESTART_RETRY_REASON } from "./retry-selection.js";
import { loadAllSchedules, getAllJobs, ScheduleWatcher } from "./loader.js";
import { CronManager } from "./manager.js";
import { executeScheduledJob } from "./executor.js";
import { notifyJobResult } from "./notifier.js";
import type { StateManager } from "../state/manager.js";
import type { RegisteredJob, ProgressEvent, JobExecutionResult } from "./types.js";
import { isPlanRequiringApproval, sendPlanForReview } from "../bot/handlers/approval.js";
import { parsePlanFromOutput } from "../plans/review-parser.js";
import { executeInternalJob } from "./internal-handlers.js";
import { runCompletionCheckup } from "../executors/completion-checkup.js";
import { routeTelegramNotification, sendChunkedTelegramMessage } from "../notifications/telegram-router.js";
import { startHeartbeat, stopHeartbeat, startWatchdog, stopWatchdog } from "./observability.js";
import { validateAndLogRegistry } from "./registry.js";
import { memoryEvents } from "../events/memory-events.js";
import { escapeHtml } from "../utils/telegram-format.js";

function isMemoryJob(job: RegisteredJob): boolean {
  const id = job.config.id.toLowerCase();
  const query = job.config.query.toLowerCase();
  return (
    id.includes("memory") ||
    id.includes("daily-log") ||
    query.includes("/nightly-memory") ||
    query.includes("memory/daily")
  );
}

// Throttle progress messages to avoid Telegram rate limits
const PROGRESS_THROTTLE_MS = 2000; // Min 2s between progress updates

/**
 * Main Scheduler class that orchestrates scheduled job execution
 */
export class Scheduler {
  private bot: Bot | null;
  private chatId: number;
  private stateManager: StateManager;
  private cronManager: CronManager;
  private watcher: ScheduleWatcher;
  private isRunning = false;
  private compensateInterval: ReturnType<typeof setInterval> | null = null;
  private progressMessageId: Map<string, number> = new Map(); // jobId -> messageId
  private lastProgressTime: Map<string, number> = new Map(); // jobId -> timestamp
  private debouncedTriggers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(bot: Bot | null, chatId: number, stateManager: StateManager) {
    this.bot = bot;
    this.chatId = chatId;
    this.stateManager = stateManager;
    this.cronManager = new CronManager();
    this.watcher = new ScheduleWatcher((schedules) => this.handleScheduleChange(schedules));

    // Listen for job triggers
    this.cronManager.on("job:trigger", ({ job, manual }) => {
      this.executeJob(job, manual);
    });

    // Sync nextRun to state manager
    this.cronManager.on("job:updated", (job: RegisteredJob) => {
      this.stateManager.updateScheduledJobNextRun(job.config.id, job.nextRun);
    });
  }

  /**
   * Start the scheduler
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("Scheduler already running");
      return;
    }

    logger.info("Starting scheduler...");

    // Phase 0: Clean up stale state from previous daemon crashes
    const clearedFlags = this.stateManager.resetScheduledJobRunFlags();
    if (clearedFlags > 0) {
      logger.warn({ count: clearedFlags }, "Cleared stale scheduled job run flags");
    }
    const orphaned = this.stateManager.cleanupOrphanedJobRuns();
    if (orphaned.count > 0) {
      logger.warn({ count: orphaned.count, jobIds: orphaned.jobIds }, "Marked orphaned job runs as failed (scheduler boot)");
    }

    // Phase 1: Snapshot due jobs from DB BEFORE registration overwrites next_run_at_ms
    const dueJobIds = this.stateManager.getDueJobs().map(j => j.jobId);

    // Phase 2: Load and register all jobs (overwrites next_run_at_ms to future)
    const schedules = await loadAllSchedules();
    const jobs = getAllJobs(schedules);

    // Add system jobs (not in schedule.json — internal daemon tasks)
    jobs.push(...Scheduler.SYSTEM_JOBS);

    // Phase 0.8: validate registry against the actual loaded job universe
    // (multi-source schedule set + system jobs). Fatal on missing handler files;
    // warn on cosmetic drift.
    validateAndLogRegistry({ loadedScheduledIds: jobs.map((j) => j.id) });
    await this.tombstoneRemovedJobs(jobs, "startup");

    // Phase 3: Seed DB rows BEFORE registration so job:updated → updateScheduledJobNextRun works
    this.stateManager.ensureJobStateRows(
      jobs.map(j => ({ jobId: j.id, sourceFile: j.sourceFile, enabled: j.enabled }))
    );

    // Phase 4: Merge DB disabled state (circuit breaker) with config enabled state.
    // If DB says disabled (circuit breaker set it), override config to keep it disabled.
    const dbStates = this.stateManager.getAllScheduledJobStates();
    const dbDisabled = this.getDbDisabledJobIds(dbStates);
    for (const job of jobs) {
      if (dbDisabled.has(job.id) && job.enabled) {
        logger.warn({ jobId: job.id }, "Job kept disabled from DB state (circuit breaker)");
        job.enabled = false;
        // registerJob will skip cron creation for disabled jobs
      }
    }

    // Phase 4b: Register all jobs with cron manager (after DB state merge)
    for (const job of jobs) {
      this.cronManager.registerJob(job, job.sourceFile);
    }

    this.stateManager.syncScheduledJobEnabled(
      jobs.map(j => ({ jobId: j.id, enabled: j.enabled }))
    );

    // Phase 4c: a run this restart cut down gets a wake-up. Flipping its run row (Phase 0)
    // armed nothing, so an ABVP run killed mid-download rested until the next weekly cron
    // and was superseded there — a lost week, no message. Armed before Phase 5 so the same
    // fireDueRetries path that honours every other retry sees it; its own ceilings bound it.
    for (const jobId of selectRestartRetries(orphaned.jobIds, jobs)) {
      const retryAt = new Date(Date.now() + RESTART_RETRY_DELAY_MS).toISOString();
      this.stateManager.setJobRetryAt(jobId, retryAt, RESTART_RETRY_REASON);
      logger.warn({ jobId, retryAt, reason: RESTART_RETRY_REASON }, "Orphaned run: armed a restart retry");
    }

    // Phase 5: Trigger catch-up — jobs are registered, getJob() works now.
    // Retries armed by a `deferred` outcome are reconciled first: they are durable in
    // scheduled_job_state and survive a daemon restart, and unlike missed-fire
    // compensation they are not gated on autoCompensate.
    this.fireDueRetries();
    this.triggerDueJobs(dueJobIds);

    // Start file watcher for hot reload
    await this.watcher.start();

    this.isRunning = true;
    const enabledCount = this.cronManager.getEnabledJobs().length;
    logger.info({ totalJobs: jobs.length, enabledJobs: enabledCount }, "Scheduler started");

    // Periodic catch-up every 10 minutes
    this.compensateInterval = setInterval(() => {
      this.fireDueRetries();
      this.compensateMissedFires();
    }, 10 * 60 * 1000);

    // Start observability (heartbeat + zombie watchdog)
    startHeartbeat(this.cronManager);
    startWatchdog(this.cronManager, (jobId) => {
      // Re-register zombie job
      const job = this.cronManager.getJob(jobId);
      if (job) {
        logger.warn({ jobId }, "Re-registering zombie cron job");
        this.cronManager.registerJob(job.config, job.sourceFile);
      }
    });

    // Set up debounced reactive triggers for memory pipelines
    this.setupReactiveTriggers();
  }

  /**
   * Set up debounced reactive triggers for memory pipelines.
   * When a dirty flag is set, waits 30s then triggers the corresponding job.
   */
  private setupReactiveTriggers(): void {
    const PIPELINE_TO_JOB: Record<string, string> = {
      reindex: "memory-reindex",
      embeddings: "memory-embeddings",
    };

    memoryEvents.on("pipeline:dirty", ({ pipeline }: { pipeline: string }) => {
      const jobId = PIPELINE_TO_JOB[pipeline];
      if (!jobId) return;

      const existing = this.debouncedTriggers.get(pipeline);
      if (existing) clearTimeout(existing);

      this.debouncedTriggers.set(
        pipeline,
        setTimeout(() => {
          this.debouncedTriggers.delete(pipeline);
          logger.info({ pipeline, jobId }, "Debounced reactive trigger firing");
          this.cronManager.triggerJob(jobId, false);
        }, 30_000),
      );
    });

    logger.info("Reactive memory pipeline triggers initialized");
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (!this.isRunning) return;

    logger.info("Stopping scheduler...");
    if (this.compensateInterval) {
      clearInterval(this.compensateInterval);
      this.compensateInterval = null;
    }
    // Clear debounced triggers
    for (const timer of this.debouncedTriggers.values()) {
      clearTimeout(timer);
    }
    this.debouncedTriggers.clear();
    memoryEvents.removeAllListeners("pipeline:dirty");
    stopHeartbeat();
    stopWatchdog();
    this.watcher.stop();
    this.cronManager.stop();
    this.isRunning = false;
    logger.info("Scheduler stopped");
  }

  /**
   * Fire one-shot retries armed by a `deferred` outcome.
   *
   * Deliberately independent of compensateMissedFires: a retry is an explicit
   * scheduler-owned re-fire the job asked for, not a compensation for a missed cron
   * tick, so it is NOT gated on `autoCompensate`. `retry_at` is durable in
   * scheduled_job_state, so a retry armed before a daemon restart is honoured after it;
   * this runs at boot and every compensation cycle. `recordScheduledJobStart` clears
   * `retry_at`, which is what keeps it one-shot.
   */
  private fireDueRetries(): void {
    try {
      const due = this.stateManager.getDueRetries();
      const selected = selectRetriesToFire(due, {
        now: Date.now(),
        lastRunAt: (jobId) => {
          const st = this.stateManager.getScheduledJobState(jobId);
          // Whichever happened later. `fireDueRetries` writes lastTriggeredAt for every retry
          // it fires, so a retry that never reached recordScheduledJobStart is still deduped.
          const candidates = [st?.lastRunAt, st?.lastTriggeredAt].filter(Boolean) as string[];
          if (!candidates.length) return null;
          return candidates.sort().at(-1)!;
        },
        isFireable: (jobId) => {
          const job = this.cronManager.getJob(jobId);
          return Boolean(job && job.config.enabled);
        },
      });
      for (const row of selected) {
        logger.warn(
          { jobId: row.jobId, retryAt: row.retryAt, reason: row.retryReason },
          "Firing scheduler-owned retry for a deferred job",
        );
        this.stateManager.recordCompensationTrigger(row.jobId);
        this.cronManager.triggerJob(row.jobId, false);
      }
    } catch (err) {
      logger.error({ error: err }, "fireDueRetries failed");
    }
  }

  /**
   * DB-driven catch-up: compensate for missed cron fires
   */
  private compensateMissedFires(): void {
    try {
      const dueJobs = this.stateManager.getDueJobs();
      const DEDUP_WINDOW_MS = 5 * 60 * 1000;
      const MAX_COMPENSATIONS_PER_CYCLE = 5;
      const now = Date.now();
      let compensated = 0;

      for (const dueJob of dueJobs) {
        if (compensated >= MAX_COMPENSATIONS_PER_CYCLE) break;
        // Skip if triggered within last 5 minutes (dedup)
        if (dueJob.lastTriggeredAt) {
          const last = new Date(dueJob.lastTriggeredAt).getTime();
          if (now - last < DEDUP_WINDOW_MS) continue;
        }

        const job = this.cronManager.getJob(dueJob.jobId);
        if (!job || !job.config.enabled) continue;
        // Honor explicit opt-out; default remains false per loader.
        if (job.config.autoCompensate === false) continue;

        logger.warn({ jobId: dueJob.jobId }, "DB catch-up: compensating missed fire");
        this.stateManager.recordCompensationTrigger(dueJob.jobId);
        this.cronManager.triggerJob(dueJob.jobId, false);
        compensated++;
      }
    } catch (err) {
      logger.error({ error: err }, "compensateMissedFires failed");
    }
  }

  /**
   * Trigger previously snapshotted due jobs after registration completes.
   * Used at boot to compensate missed fires without racing against getJob().
   */
  private triggerDueJobs(dueJobIds: string[]): void {
    const DEDUP_WINDOW_MS = 5 * 60 * 1000;
    const now = Date.now();
    let compensated = 0;

    for (const jobId of dueJobIds) {
      if (compensated >= 5) break;

      const job = this.cronManager.getJob(jobId);
      if (!job || !job.config.enabled) continue;
      if (job.config.autoCompensate === false) continue;

      // Dedup: skip if triggered recently
      const state = this.stateManager.getScheduledJobState(jobId);
      if (state?.lastRunAt) {
        const last = new Date(state.lastRunAt).getTime();
        if (now - last < DEDUP_WINDOW_MS) continue;
      }

      logger.warn({ jobId }, "Boot catch-up: compensating missed fire");
      this.stateManager.recordCompensationTrigger(jobId);
      this.cronManager.triggerJob(jobId, false);
      compensated++;
    }

    if (compensated > 0) {
      logger.info({ count: compensated }, "Boot catch-up complete");
    }
  }

  /**
   * Manually trigger a job by ID
   */
  triggerJob(jobId: string, manual: boolean = true): boolean {
    const job = this.cronManager.getJob(jobId);
    if (!job) {
      logger.warn({ jobId }, "Job not found");
      return false;
    }

    this.cronManager.triggerJob(jobId, manual);
    return true;
  }

  /**
   * Get all registered jobs
   */
  getJobs(): RegisteredJob[] {
    return this.cronManager.getAllJobs();
  }

  /**
   * Get a specific job by ID
   */
  getJob(jobId: string): RegisteredJob | undefined {
    return this.cronManager.getJob(jobId);
  }

  /**
   * Handle schedule file changes (hot reload)
   */
  private async handleScheduleChange(schedules: Awaited<ReturnType<typeof loadAllSchedules>>): Promise<void> {
    logger.info("Reloading schedules...");

    // Snapshot nextRun for all enabled jobs before tearing down
    const snapshots = new Map<string, Date>();
    for (const job of this.cronManager.getEnabledJobs()) {
      const task = this.cronManager.getCronTask(job.config.id);
      const next = task?.nextRun();
      if (next) snapshots.set(job.config.id, next);
    }

    const reloadStart = Date.now();

    // Unregister all existing jobs
    this.cronManager.unregisterAll();

    // Load new jobs + system jobs
    const jobs = getAllJobs(schedules);
    jobs.push(...Scheduler.SYSTEM_JOBS);
    validateAndLogRegistry({ loadedScheduledIds: jobs.map((j) => j.id) });
    await this.tombstoneRemovedJobs(jobs, "hot_reload");

    // Seed DB rows for any new jobs, then merge DB-disabled state BEFORE
    // registration so job:updated can persist nextRun and disabled jobs never
    // briefly receive cron tasks.
    this.stateManager.ensureJobStateRows(
      jobs.map(j => ({ jobId: j.id, sourceFile: j.sourceFile, enabled: j.enabled }))
    );
    const dbStates = this.stateManager.getAllScheduledJobStates();
    const dbDisabled = this.getDbDisabledJobIds(dbStates);
    for (const job of jobs) {
      if (dbDisabled.has(job.id) && job.enabled) {
        logger.warn({ jobId: job.id }, "Job kept disabled from DB state (circuit breaker)");
        job.enabled = false;
      }
    }

    for (const job of jobs) {
      this.cronManager.registerJob(job, job.sourceFile);
    }

    const reloadDuration = Date.now() - reloadStart;

    // Gap protection: if reload took > 1s, check if any expected fires fell into the gap
    if (reloadDuration > 1000) {
      const now = Date.now();
      for (const [jobId, nextExpected] of snapshots) {
        if (nextExpected.getTime() <= now && nextExpected.getTime() >= reloadStart) {
          const job = this.cronManager.getJob(jobId);
          if (!job || !job.config.enabled || job.config.autoCompensate === false) continue;
          logger.warn({ jobId, reloadDurationMs: reloadDuration }, "Hot-reload gap: compensating missed fire");
          this.cronManager.triggerJob(jobId, false);
        }
      }
    }

    this.stateManager.syncScheduledJobEnabled(
      jobs.map(j => ({ jobId: j.id, enabled: j.enabled }))
    );

    const enabledCount = this.cronManager.getEnabledJobs().length;
    logger.info({ totalJobs: jobs.length, enabledJobs: enabledCount, reloadDurationMs: reloadDuration }, "Schedules reloaded");
  }

  /**
   * Send or update progress message in Telegram
   */
  private async sendProgress(jobId: string, event: ProgressEvent): Promise<void> {
    logger.info({ jobId, eventType: event.type, message: event.message }, "Progress event received");

    // Skip non-essential events if throttled
    const now = Date.now();
    const lastTime = this.lastProgressTime.get(jobId) || 0;
    const isThrottled = now - lastTime < PROGRESS_THROTTLE_MS;

    // Always send started/completed, throttle tool_use events
    if (event.type !== "started" && event.type !== "completed" && isThrottled) {
      return;
    }

    this.lastProgressTime.set(jobId, now);

    try {
      if (event.type === "completed") {
        this.lastProgressTime.delete(jobId);
        this.progressMessageId.delete(jobId);
      }

      await routeTelegramNotification({
        db: this.stateManager.getDb(),
        sourceType: "scheduler_job",
        sourceId: `${jobId}:progress:${event.type}`,
        intent: "operational_status",
        title: event.jobName,
        messageText: event.message,
        reason: "progress_event",
      });
    } catch (error) {
      logger.warn({ error, jobId, eventType: event.type }, "Failed to send progress update");
    }
  }

  /**
   * Circuit breaker: auto-disable jobs after 5 consecutive failures
   */
  private async checkCircuitBreaker(jobId: string, jobName: string): Promise<void> {
    const job = this.cronManager.getJob(jobId);
    if (!job || job.consecutiveFailures < 5) return;

    this.cronManager.disableJob(jobId, this.stateManager);
    logger.warn({ jobId, consecutiveFailures: job.consecutiveFailures }, "Circuit breaker: job auto-disabled after 5 consecutive failures");

    if (this.bot) {
      try {
        await this.bot.api.sendMessage(
          this.chatId,
          `⚠️ <b>${escapeHtml(jobName)}</b> auto-disabled after 5 consecutive failures. Re-enable manually.`,
          { parse_mode: "HTML" }
        );
      } catch { /* notification best-effort */ }
    }

    // Emergency SMS as backup notification
    try {
      const { sendEmergencySms } = await import("../telephony/emergency-sms.js");
      await sendEmergencySms(`Job "${jobName}" auto-disabled after 5 consecutive failures`);
    } catch { /* best-effort */ }
  }

  // Dependency triggers — extracted to constant
  // Memory chains removed: session-harvester→memory-reindex, memory-reindex→memory-embeddings,
  // nightly-memory→memory-embeddings/git-commit.
  // These are now handled by dirty flags + debounced reactive triggers.
  // Scraping jobs are terminal: their rows land in `scrapes` and morning-reads
  // reads them directly.
  private static readonly DEPENDENCY_TRIGGERS: Record<string, string[]> = {};

  // System jobs — internal daemon tasks registered at boot and on hot reload
  private static readonly SYSTEM_JOBS: Array<import("./types.js").ScheduledJobConfig & { sourceFile: string }> = [
    {
      id: "daemon-cleanup", name: "Daemon Cleanup", cron: "0 */2 * * *",
      query: "", lane: "default", enabled: true, executor: "internal",
      handler: "daemon_cleanup", timeout: 600_000,
      notifyOnSuccess: false, notifyOnFailure: true, failureTakeover: false,
      sourceFile: "system",
    },
    {
      id: "session-maintenance", name: "Session Maintenance", cron: "0 * * * *",
      query: "", lane: "default", enabled: true, executor: "internal",
      handler: "session_maintenance", timeout: 600_000,
      notifyOnSuccess: false, notifyOnFailure: true, failureTakeover: false,
      sourceFile: "system",
    },
    {
      id: "reminder-check", name: "Reminder Check", cron: "*/30 * * * *",
      query: "", lane: "default", enabled: true, executor: "internal",
      handler: "reminder_check", timeout: 600_000,
      notifyOnSuccess: false, notifyOnFailure: false, failureTakeover: false,
      sourceFile: "system",
    },
  ];

  private getDbDisabledJobIds(dbStates: ReturnType<StateManager["getAllScheduledJobStates"]>): Set<string> {
    return new Set(
      dbStates
        .filter((state) => !state.enabled)
        .map((state) => state.jobId)
    );
  }

  private async tombstoneRemovedJobs(
    jobs: Array<import("./types.js").ScheduledJobConfig & { sourceFile: string }>,
    phase: "startup" | "hot_reload",
  ): Promise<void> {
    const removed = this.stateManager.tombstoneRemovedScheduledJobs(jobs.map((job) => job.id));
    if (removed.length === 0) {
      return;
    }

    logger.warn({ removed, phase }, "Scheduled jobs removed from loaded config; tombstoned DB state");
    const message = [
      "<b>Scheduler jobs removed</b>",
      `Phase: ${escapeHtml(phase)}`,
      ...removed.map((jobId) => `- ${escapeHtml(jobId)}`),
    ].join("\n");
    const bot = this.bot;

    await routeTelegramNotification({
      db: this.stateManager.getDb(),
      sourceType: "scheduler_job",
      sourceId: `scheduler_removed_jobs:${phase}`,
      intent: "failure_alert",
      title: "Scheduler jobs removed",
      messageText: message,
      reason: "scheduled_job_removed",
      metadata: { removed, phase },
      deliver: bot ? async () => sendChunkedTelegramMessage({
        bot,
        chatId: this.chatId,
        message,
        parseMode: "HTML",
      }) : undefined,
    });
  }

  private fireDependencyTriggers(jobId: string): void {
    // Check config-based triggers first, fall back to hardcoded map
    const job = this.cronManager.getJob(jobId);
    const configTriggers = job?.config.triggers;
    const downstream = configTriggers && configTriggers.length > 0
      ? configTriggers
      : Scheduler.DEPENDENCY_TRIGGERS[jobId];

    if (downstream) {
      for (const targetId of downstream) {
        logger.info({ jobId: targetId, triggeredBy: jobId }, "Triggering downstream job");
        this.cronManager.triggerJob(targetId, false);
      }
    }
  }

  /**
   * Execute a job and handle results
   */
  private async executeJob(job: RegisteredJob, manual: boolean): Promise<void> {
    try {
      // Record job start (with locking)
      const runId = this.stateManager.recordScheduledJobStart(job.config.id, job.config.name, job.sourceFile);

      // If runId is null, job is already running - skip
      if (runId === null) {
        return;
      }

      // Only stream progress if explicitly enabled (most jobs don't need it)
      const onProgress = job.config.streamProgress
        ? (event: ProgressEvent) => void this.sendProgress(job.config.id, event)
        : undefined;

      const isInternal = job.config.executor === "internal" || !!job.config.handler;
      const bot = this.bot;
      const takeoverEnabled = job.config.failureTakeover !== false && bot !== null;

      // Execute the job (internal handler or CLI executor) with hang watchdog.
      // An explicitly configured timeout is AUTHORITATIVE (+30s cleanup grace); the
      // 25-min default applies only when a job declares no budget. There is no
      // universal floor: it silently turned nightly-code-push's 120s budget into
      // 10 minutes of uncancelled work before takeover (2026-07-27 cascade).
      const DEFAULT_HANG_TIMEOUT_MS = 25 * 60 * 1000;
      // Bounded window for an aborted handler to unwind before we give up on it.
      const SETTLE_GRACE_MS = 30_000;
      const HANG_TIMEOUT_MS = typeof job.config.timeout === "number" && job.config.timeout > 0
        ? job.config.timeout + 30_000
        : DEFAULT_HANG_TIMEOUT_MS;
      const hangTimeoutMinutes = Math.round(HANG_TIMEOUT_MS / 60_000);

      // AbortController for cooperative cancellation of internal jobs.
      // When the hang watchdog fires, the signal propagates into the handler
      // so batch loops and LLM calls can exit early instead of running forever.
      const controller = new AbortController();
      let hangTimerId: ReturnType<typeof setTimeout> | null = null;
      const hangPromise = new Promise<never>((_, reject) => {
        hangTimerId = setTimeout(() => {
          controller.abort();
          reject(new Error(`Job hung: exceeded ${hangTimeoutMinutes}-minute timeout`));
        }, HANG_TIMEOUT_MS);
      });

      let result: JobExecutionResult;
      // Set once the original execution actually settles. If the watchdog fires and
      // this stays false past the grace window, the handler ignored the abort and is
      // STILL RUNNING — retrying on top of it is what produced overlapping runs.
      let settled = false;
      let execPromise: Promise<JobExecutionResult> | undefined;
      try {
        execPromise = (isInternal
          ? executeInternalJob(job, {
              stateManager: this.stateManager,
              bot,
              chatId: this.chatId,
              jobRunId: runId,
              signal: controller.signal,
              disableScheduledJob: (jobId) => this.cronManager.disableJob(jobId, this.stateManager),
            })
          : executeScheduledJob(job, onProgress, {
              ...(takeoverEnabled ? { skipDiagnosis: true } : {}),
              scheduledRunId: runId,
              signal: controller.signal,
            })
        ).finally(() => { settled = true; });
        result = await Promise.race([execPromise, hangPromise]);
      } catch (hangError) {
        // DEBT: when the watchdog wins this race the handler's own result — its `retryAt`,
        // `outcome` and `resetFailureStreak` — is discarded, so an ABVP run aborted here rests
        // until the next weekly cron even though state.json carries a bounded resume_after. Bounded
        // by the job's 6 h timeout and by the flock the unsettled handler still holds. Upgrade
        // (read `resume_after` from the handler's state, or let the settled result win) the first
        // time a >6 h ABVP hang is observed.
        const msg = hangError instanceof Error ? hangError.message : String(hangError);
        logger.warn({ jobId: job.config.id, jobName: job.config.name }, msg);
        // Timeout must mean cancellation: the controller is already aborted, so give
        // the handler a bounded grace to unwind before declaring the run dead.
        if (execPromise && !settled) {
          await Promise.race([
            execPromise.catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, SETTLE_GRACE_MS)),
          ]);
        }
        result = {
          jobId: job.config.id,
          jobName: job.config.name,
          sourceFile: job.sourceFile,
          startedAt: new Date(),
          completedAt: new Date(),
          success: false,
          output: msg,
          error: msg,
          exitCode: -1,
          duration: HANG_TIMEOUT_MS,
        };
      } finally {
        if (hangTimerId) clearTimeout(hangTimerId);
      }

      // An unsettled original still holds its resources (child processes, CDP, git
      // locks). Diagnosing/retrying alongside it doubles the load that caused the
      // timeout, so skip takeover entirely and let process cleanup own termination.
      const originalStillRunning = !settled;
      if (originalStillRunning) {
        logger.error(
          { jobId: job.config.id, jobName: job.config.name, graceMs: SETTLE_GRACE_MS },
          "Job did not settle after abort — original still running, skipping takeover",
        );
      }

      // A job may ask for a one-shot re-fire on ANY disposition: a cadence catch-up that left
      // its own next-due instant in the past (success), or a retryable failure whose bounded
      // resume_after would otherwise have no tick to land on. `deferred` arms its own retry
      // inside recordScheduledJobDeferred. Every arming happens INSIDE the same transaction
      // that releases the run lock, so a new run cannot start in the gap and inherit a stale
      // retry from the run that just finished.
      const requestedRetry = result.retryAt
        ? { retryAt: result.retryAt, reason: result.retryReason ?? "requested_retry" }
        : { retryAt: null, reason: null };
      if (result.retryAt) {
        logger.info(
          { jobId: job.config.id, retryAt: result.retryAt, reason: result.retryReason, success: result.success },
          "Job requested a one-shot re-fire",
        );
      }
      // See JobExecutionResult.resetFailureStreak: the fire that opens a new unit of work
      // starts the failure streak over, in the DB counter and the in-memory one the breaker reads.
      // Computed BEFORE the deferred branch: the slot-opening fire is exactly the one most likely
      // to defer (a QC lease at 14:00Z), and dropping the reset there let two bad weeks reach the
      // breaker through the run's own retry ticks.
      const streak = { resetFailureStreak: result.resetFailureStreak === true };
      if (streak.resetFailureStreak) this.cronManager.resetFailureStreak(job.config.id);

      // === DEFERRED PATH ===
      // A third disposition beside success and failure: the job did not run to
      // completion because a resource it needs was held. Nothing is broken, so this must
      // not enter failure takeover or the circuit breaker; nothing was produced, so it
      // must not write last_success_at, reset consecutive_failures, or fire success
      // dependencies. The producer owns its own user-facing notification (rate-limited),
      // so notifyJobResult is deliberately skipped.
      if (result.outcome === "deferred") {
        const retryAt = result.retryAt ?? new Date(Date.now() + 30 * 60 * 1000).toISOString();
        const reason = result.retryReason ?? "deferred";
        this.stateManager.recordScheduledJobDeferred(
          runId, job.config.id, result.output, retryAt, reason, streak,
        );
        logger.warn(
          { jobId: job.config.id, retryAt, reason },
          "Job deferred; scheduler armed a one-shot retry",
        );
        return;
      }

      // === HALTED PATH ===
      // The job refused to start work: one of ITS OWN ceilings was reached, or it failed closed
      // on state it will not trust. A failure for history and notification, but it must not feed
      // the circuit breaker — ABVP's ceilings (3 attempts, 6 deferrals, 3 runs per slot) are the
      // stop, and a second uncoordinated stop here would disable the job with its retries
      // armed and inert. No takeover either: nothing ran, so there is nothing to take over.
      if (result.outcome === "halted") {
        this.stateManager.recordScheduledJobHalted(
          runId, job.config.id, result.output, result.error, requestedRetry, streak,
        );
        logger.warn(
          { jobId: job.config.id, error: result.error, resetFailureStreak: streak.resetFailureStreak },
          "Job halted on its own ceiling; not counted toward the circuit breaker",
        );
        await notifyJobResult(this.bot, this.chatId, this.stateManager.getDb(), result, job, runId);
        return;
      }

      // === FAILURE + TAKEOVER PATH ===
      if (!result.success && takeoverEnabled && bot && !originalStillRunning) {
        // Record failure but keep is_running lock held
        this.stateManager.recordScheduledJobFailed(
          runId, job.config.id, result.output, result.error, result.exitCode
        );

        try {
          const { runFailureTakeover } = await import("./failure-takeover.js");
          const takeoverResult = await runFailureTakeover({
            job,
            failedResult: result,
            runId,
            stateManager: this.stateManager,
            bot,
            chatId: this.chatId,
            disableScheduledJob: (id) => this.cronManager.disableJob(id, this.stateManager),
          });

          if (!takeoverResult) {
            // Guards prevented takeover (daily limit, concurrent limit, etc.)
            // Fall through to normal failure handling
            this.stateManager.recordScheduledJobComplete(
              runId, job.config.id, false,
              result.output, result.error, result.exitCode, requestedRetry, streak
            );
            this.cronManager.updateJobState(job.config.id, false, streak);
            await this.checkCircuitBreaker(job.config.id, job.config.name);
            await notifyJobResult(this.bot, this.chatId, this.stateManager.getDb(), result, job, runId);
            return;
          }

          if (takeoverResult.finalSuccess) {
            // Takeover saved it — record as success
            this.stateManager.recordScheduledJobComplete(
              runId, job.config.id, true,
              takeoverResult.retryResult?.output ?? result.output, undefined, 0, requestedRetry, streak
            );
            this.cronManager.updateJobState(job.config.id, true);
            this.fireDependencyTriggers(job.config.id);

            try {
              const diagSnippet = escapeHtml(takeoverResult.decision.diagnosis.slice(0, 200));
              await bot.api.sendMessage(
                this.chatId,
                `<b>🔧 ${escapeHtml(job.config.name)} recovered</b>\n\nDiagnosis: ${diagSnippet}\nAction: ${takeoverResult.decision.action}`,
                { parse_mode: "HTML" }
              );
            } catch { /* notification best-effort */ }
            return;
          }

          // Takeover didn't fix it after retries — record as failure and ALWAYS alert.
          this.stateManager.recordScheduledJobComplete(
            runId, job.config.id, false,
            result.output, result.error, result.exitCode, requestedRetry, streak
          );
          this.cronManager.updateJobState(job.config.id, false, streak);
          await this.checkCircuitBreaker(job.config.id, job.config.name);

          // Escalation alert is unconditional (spec: always push the error on escalation).
          try {
            const esc = takeoverResult.escalation;
            const lastErr = takeoverResult.retryResult?.error
              ?? takeoverResult.retryResult?.output
              ?? result.error ?? result.output ?? "(no error text)";
            const errSnippet = escapeHtml(lastErr.slice(0, 500));
            const diagSnippet = escapeHtml(takeoverResult.decision.diagnosis.slice(0, 300));

            let suggestionLine = "";
            if (esc?.action === "switch_harness" && esc.suggestedHarness) {
              suggestionLine = `\n\n💡 Suggestion: switch harness → <b>${escapeHtml(esc.suggestedHarness)}</b> (advisory — apply via the job harness override)`;
            } else if (esc?.action === "abandon") {
              suggestionLine = `\n\n💡 Suggestion: abandon this job`;
            }
            if (esc?.reportMessage) {
              suggestionLine += `\n${escapeHtml(esc.reportMessage.slice(0, 300))}`;
            }

            await bot.api.sendMessage(
              this.chatId,
              `<b>❌ ${escapeHtml(job.config.name)} failed after ${takeoverResult.retriesAttempted} ${takeoverResult.retriesAttempted === 1 ? "retry" : "retries"}</b>\n\nError: ${errSnippet}\n\nDiagnosis: ${diagSnippet}${suggestionLine}`,
              { parse_mode: "HTML" }
            );
          } catch { /* notification best-effort */ }
          return;

        } catch (takeoverError) {
          // Takeover itself crashed — record original failure normally
          logger.error({ jobId: job.config.id, error: takeoverError }, "Failure takeover crashed");
          this.stateManager.recordScheduledJobComplete(
            runId, job.config.id, false,
            result.output, result.error, result.exitCode, requestedRetry, streak
          );
          this.cronManager.updateJobState(job.config.id, false, streak);
          await this.checkCircuitBreaker(job.config.id, job.config.name);
          await notifyJobResult(this.bot, this.chatId, this.stateManager.getDb(), result, job, runId);
          return;
        }
      }

      // === SUCCESS PATH (or failure with takeover disabled) ===
      this.stateManager.recordScheduledJobComplete(
        runId, job.config.id, result.success,
        result.output, result.error, result.exitCode, requestedRetry, streak
      );
      this.cronManager.updateJobState(job.config.id, result.success, streak);


      if (!result.success) {
        await this.checkCircuitBreaker(job.config.id, job.config.name);
      }

      if (result.success) {
        this.fireDependencyTriggers(job.config.id);
      }

      // Check if output contains an implementation plan requiring approval
      if (result.success && isPlanRequiringApproval(result.output)) {
        logger.info({ jobId: job.config.id }, "Plan detected, requesting structured approval");

        // Parse into structured plan and send review card
        const plan = parsePlanFromOutput(result.output, "scheduler-job");
        plan.id = `plan_${job.config.id}_${Date.now()}`;
        plan.rawText = result.output;

        // Also save in legacy table for backward compat
        this.stateManager.savePendingPlan(job.config.id, result.output);

        if (this.bot) {
          await sendPlanForReview(this.bot, this.stateManager, this.chatId, plan);
        } else {
          logger.warn({ jobId: job.config.id, planId: plan.id }, "Plan review requires Telegram; saved pending plan without sending");
        }

        // Don't send normal notification - plan approval takes over
        return;
      }

      // Notify via Telegram (final result)
      await notifyJobResult(this.bot, this.chatId, this.stateManager.getDb(), result, job, runId);

      if (result.fallbackUsed && result.executorUsed) {
        await routeTelegramNotification({
          db: this.stateManager.getDb(),
          sourceType: "scheduler_job",
          sourceId: `${job.config.id}:fallback`,
          jobRunId: runId,
          intent: "operational_status",
          title: job.config.name,
          messageText: `Fallback used for ${job.config.name}\nExecutor: ${result.executorUsed}`,
          reason: "fallback_used",
        });
      }

      if (result.success) {
        this.stateManager.deleteSuccessfulHeartbeatRun(runId, job.config.id);
      }

      // Run completion checkup for manual triggers
      if (manual && result.success) {
        const check = await runCompletionCheckup({
          name: job.config.name,
          id: job.config.id,
          query: job.config.query,
          output: result.output ?? "",
          isMemoryJob: isMemoryJob(job),
        });
        if (check) {
          const status = check.complete ? "✅ Checkup: Complete" : "⚠️ Checkup: Incomplete";
          const lines: string[] = [status];
          if (check.summary) lines.push(`Summary: ${check.summary}`);
          if (check.missing && check.missing.length > 0) {
            lines.push(`Missing: ${check.missing.join("; ")}`);
          }
          if (check.next_steps && check.next_steps.length > 0) {
            lines.push(`Next: ${check.next_steps.join("; ")}`);
          }
          if (typeof check.confidence === "number") {
            lines.push(`Confidence: ${Math.round(check.confidence * 100)}%`);
          }
          lines.push(`Job: ${job.config.id}`);
          try {
            if (this.bot) {
              await this.bot.api.sendMessage(this.chatId, lines.join("\n"));
            }
          } catch (err) {
            logger.warn({ error: err, jobId: job.config.id }, "Failed to send completion checkup");
          }
        }
      }
    } catch (error) {
      logger.error({ jobId: job.config.id, error }, "Failed to execute scheduled job");

      // Clean up progress message
      const existingMsgId = this.progressMessageId.get(job.config.id);
      if (existingMsgId && this.bot) {
        try {
          await this.bot.api.deleteMessage(this.chatId, existingMsgId);
        } catch {
          // Ignore
        }
        this.progressMessageId.delete(job.config.id);
      }

      // Update failure state
      // DEBT: a throw out of the job carries no result, so `resetFailureStreak` is unknown here and
      // a fire that opened a new slot still increments the streak. Exception path only; upgrade
      // if a handler is ever seen throwing on its slot-opening tick.
      this.cronManager.updateJobState(job.config.id, false);
      await this.checkCircuitBreaker(job.config.id, job.config.name);

      // Record failure (need to get runId from most recent incomplete run)
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      // Get the most recent incomplete run for this job
      const incompleteRun = this.stateManager.getDb()
        .prepare(`SELECT id FROM scheduled_job_runs WHERE job_id = ? AND completed_at IS NULL ORDER BY id DESC LIMIT 1`)
        .get(job.config.id) as { id: number } | undefined;

      if (incompleteRun) {
        this.stateManager.recordScheduledJobComplete(
          incompleteRun.id,
          job.config.id,
          false,
          "",
          errorMessage,
          1,
          // The job threw before returning a result, so there is no request to honour. The run
          // is over, which consumes whatever retry it was started for.
          { retryAt: null, reason: null },
        );
      }

      // Notify failure
      if (job.config.notifyOnFailure !== false && this.bot) {
        try {
          await this.bot.api.sendMessage(
            this.chatId,
            `❌ *${job.config.name}* failed\n\nError: ${errorMessage}`,
            { parse_mode: "Markdown" }
          );
        } catch {
          // Ignore notification errors
        }
      }
    }
  }
}

// Re-export types
export type { RegisteredJob, ScheduledJobConfig, JobExecutionResult, ProgressEvent } from "./types.js";
