import type { Bot } from "grammy";
import { logger } from "../utils/logger.js";
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
import { routeTelegramNotification } from "../notifications/telegram-router.js";
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
  private bot: Bot;
  private chatId: number;
  private stateManager: StateManager;
  private cronManager: CronManager;
  private watcher: ScheduleWatcher;
  private isRunning = false;
  private compensateInterval: ReturnType<typeof setInterval> | null = null;
  private progressMessageId: Map<string, number> = new Map(); // jobId -> messageId
  private lastProgressTime: Map<string, number> = new Map(); // jobId -> timestamp
  private debouncedTriggers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(bot: Bot, chatId: number, stateManager: StateManager) {
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
    const orphanedRuns = this.stateManager.cleanupOrphanedJobRuns();
    if (orphanedRuns > 0) {
      logger.warn({ count: orphanedRuns }, "Marked orphaned job runs as failed (scheduler boot)");
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

    // Phase 3: Seed DB rows BEFORE registration so job:updated → updateScheduledJobNextRun works
    this.stateManager.ensureJobStateRows(
      jobs.map(j => ({ jobId: j.id, sourceFile: j.sourceFile, enabled: j.enabled }))
    );

    // Phase 4: Merge DB disabled state (circuit breaker) with config enabled state.
    // If DB says disabled (circuit breaker set it), override config to keep it disabled.
    const dbStates = this.stateManager.getAllScheduledJobStates();
    const dbDisabled = new Set(
      dbStates.filter(s => !s.enabled).map(s => s.jobId)
    );
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

    // Phase 5: Trigger catch-up — jobs are registered, getJob() works now
    this.triggerDueJobs(dueJobIds);

    // Start file watcher for hot reload
    await this.watcher.start();

    this.isRunning = true;
    const enabledCount = this.cronManager.getEnabledJobs().length;
    logger.info({ totalJobs: jobs.length, enabledJobs: enabledCount }, "Scheduler started");

    // Periodic catch-up every 10 minutes
    this.compensateInterval = setInterval(() => this.compensateMissedFires(), 10 * 60 * 1000);

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

    // Register new jobs + system jobs
    const jobs = getAllJobs(schedules);
    jobs.push(...Scheduler.SYSTEM_JOBS);

    for (const job of jobs) {
      this.cronManager.registerJob(job, job.sourceFile);
    }

    const reloadDuration = Date.now() - reloadStart;

    // Gap protection: if reload took > 1s, check if any expected fires fell into the gap
    if (reloadDuration > 1000) {
      const now = Date.now();
      for (const [jobId, nextExpected] of snapshots) {
        if (nextExpected.getTime() <= now && nextExpected.getTime() >= reloadStart) {
          logger.warn({ jobId, reloadDurationMs: reloadDuration }, "Hot-reload gap: compensating missed fire");
          this.cronManager.triggerJob(jobId, false);
        }
      }
    }

    // Seed DB rows for any new jobs, then merge DB-disabled state
    this.stateManager.ensureJobStateRows(
      jobs.map(j => ({ jobId: j.id, sourceFile: j.sourceFile, enabled: j.enabled }))
    );
    const dbStates = this.stateManager.getAllScheduledJobStates();
    const dbDisabled = new Set(
      dbStates.filter(s => !s.enabled).map(s => s.jobId)
    );
    for (const job of jobs) {
      if (dbDisabled.has(job.id) && job.enabled) {
        job.enabled = false;
        this.cronManager.disableJob(job.id);
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

    try {
      await this.bot.api.sendMessage(
        this.chatId,
        `⚠️ <b>${escapeHtml(jobName)}</b> auto-disabled after 5 consecutive failures. Re-enable manually.`,
        { parse_mode: "HTML" }
      );
    } catch { /* notification best-effort */ }

    // Emergency SMS as backup notification
    try {
      const { sendEmergencySms } = await import("../telephony/emergency-sms.js");
      await sendEmergencySms(`Job "${jobName}" auto-disabled after 5 consecutive failures`);
    } catch { /* best-effort */ }
  }

  // Dependency triggers — extracted to constant
  // Memory chains removed: session-harvester→memory-reindex, memory-reindex→memory-embeddings,
  // nightly-memory→memory-embeddings/git-commit, idea-dedup→memory-embeddings.
  // These are now handled by dirty flags + debounced reactive triggers.
  private static readonly DEPENDENCY_TRIGGERS: Record<string, string[]> = {
    "idea-ingest": ["idea-synthesizer"],
    "ideas-explore": ["idea-synthesizer"],
    "content-scraper": ["idea-synthesizer"],
    "idea-synthesizer": ["idea-dedup"],
    "job-hunt-discover": ["job-hunt-daily-approval"],
    "outcome-tracker": ["preference-updater"],
  };

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
      id: "reminder-check", name: "Reminder Check", cron: "* * * * *",
      query: "", lane: "default", enabled: true, executor: "internal",
      handler: "reminder_check", timeout: 600_000,
      notifyOnSuccess: false, notifyOnFailure: false, failureTakeover: false,
      sourceFile: "system",
    },
  ];

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
      const takeoverEnabled = job.config.failureTakeover !== false;

      // Execute the job (internal handler or CLI executor) with hang watchdog.
      // Default: 25 min (covers LLM reasoning tasks); minimum 10 min enforced for all jobs.
      const DEFAULT_HANG_TIMEOUT_MS = 25 * 60 * 1000;
      const MIN_HANG_TIMEOUT_MS = 10 * 60 * 1000;
      const configuredTimeout = typeof job.config.timeout === "number" && job.config.timeout > 0
        ? job.config.timeout + 30_000
        : DEFAULT_HANG_TIMEOUT_MS;
      const HANG_TIMEOUT_MS = Math.max(configuredTimeout, MIN_HANG_TIMEOUT_MS);
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
      try {
        const execPromise = isInternal
          ? executeInternalJob(job, {
              stateManager: this.stateManager,
              bot: this.bot,
              chatId: this.chatId,
              jobRunId: runId,
              signal: controller.signal,
              disableScheduledJob: (jobId) => this.cronManager.disableJob(jobId, this.stateManager),
            })
          : executeScheduledJob(job, onProgress, {
              ...(takeoverEnabled ? { skipDiagnosis: true } : {}),
              scheduledRunId: runId,
            });
        result = await Promise.race([execPromise, hangPromise]);
      } catch (hangError) {
        const msg = hangError instanceof Error ? hangError.message : String(hangError);
        logger.warn({ jobId: job.config.id, jobName: job.config.name }, msg);
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

      // === FAILURE + TAKEOVER PATH ===
      if (!result.success && takeoverEnabled) {
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
            bot: this.bot,
            chatId: this.chatId,
            disableScheduledJob: (id) => this.cronManager.disableJob(id, this.stateManager),
          });

          if (!takeoverResult) {
            // Guards prevented takeover (daily limit, concurrent limit, etc.)
            // Fall through to normal failure handling
            this.stateManager.recordScheduledJobComplete(
              runId, job.config.id, false,
              result.output, result.error, result.exitCode
            );
            this.cronManager.updateJobState(job.config.id, false);
            await this.checkCircuitBreaker(job.config.id, job.config.name);
            await notifyJobResult(this.bot, this.chatId, this.stateManager.getDb(), result, job, runId);
            return;
          }

          if (takeoverResult.finalSuccess) {
            // Takeover saved it — record as success
            this.stateManager.recordScheduledJobComplete(
              runId, job.config.id, true,
              takeoverResult.retryResult?.output ?? result.output, undefined, 0
            );
            this.cronManager.updateJobState(job.config.id, true);
            this.fireDependencyTriggers(job.config.id);

            try {
              const diagSnippet = escapeHtml(takeoverResult.decision.diagnosis.slice(0, 200));
              await this.bot.api.sendMessage(
                this.chatId,
                `<b>🔧 ${escapeHtml(job.config.name)} recovered</b>\n\nDiagnosis: ${diagSnippet}\nAction: ${takeoverResult.decision.action}`,
                { parse_mode: "HTML" }
              );
            } catch { /* notification best-effort */ }
            return;
          }

          // Takeover didn't fix it — record as failure
          this.stateManager.recordScheduledJobComplete(
            runId, job.config.id, false,
            result.output, result.error, result.exitCode
          );
          this.cronManager.updateJobState(job.config.id, false);
          await this.checkCircuitBreaker(job.config.id, job.config.name);

          const diagnosis = takeoverResult.decision.diagnosis;
          const reportMsg = takeoverResult.decision.reportMessage;
          if (job.config.notifyOnFailure !== false) {
            try {
              const diagSnippet = escapeHtml(diagnosis.slice(0, 300));
              const reportSnippet = reportMsg ? `\n\n${escapeHtml(reportMsg.slice(0, 300))}` : "";
              await this.bot.api.sendMessage(
                this.chatId,
                `<b>❌ ${escapeHtml(job.config.name)} failed</b>\n\nDiagnosis: ${diagSnippet}${reportSnippet}`,
                { parse_mode: "HTML" }
              );
            } catch { /* notification best-effort */ }
          }
          return;

        } catch (takeoverError) {
          // Takeover itself crashed — record original failure normally
          logger.error({ jobId: job.config.id, error: takeoverError }, "Failure takeover crashed");
          this.stateManager.recordScheduledJobComplete(
            runId, job.config.id, false,
            result.output, result.error, result.exitCode
          );
          this.cronManager.updateJobState(job.config.id, false);
          await this.checkCircuitBreaker(job.config.id, job.config.name);
          await notifyJobResult(this.bot, this.chatId, this.stateManager.getDb(), result, job, runId);
          return;
        }
      }

      // === SUCCESS PATH (or failure with takeover disabled) ===
      this.stateManager.recordScheduledJobComplete(
        runId, job.config.id, result.success,
        result.output, result.error, result.exitCode
      );
      this.cronManager.updateJobState(job.config.id, result.success);

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

        await sendPlanForReview(this.bot, this.stateManager, this.chatId, plan);

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
            await this.bot.api.sendMessage(this.chatId, lines.join("\n"));
          } catch (err) {
            logger.warn({ error: err, jobId: job.config.id }, "Failed to send completion checkup");
          }
        }
      }
    } catch (error) {
      logger.error({ jobId: job.config.id, error }, "Failed to execute scheduled job");

      // Clean up progress message
      const existingMsgId = this.progressMessageId.get(job.config.id);
      if (existingMsgId) {
        try {
          await this.bot.api.deleteMessage(this.chatId, existingMsgId);
        } catch {
          // Ignore
        }
        this.progressMessageId.delete(job.config.id);
      }

      // Update failure state
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
          1
        );
      }

      // Notify failure
      if (job.config.notifyOnFailure !== false) {
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
