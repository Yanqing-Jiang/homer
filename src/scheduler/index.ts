import type { Bot } from "grammy";
import { logger } from "../utils/logger.js";
import { loadAllSchedules, getAllJobs, ScheduleWatcher } from "./loader.js";
import { CronManager } from "./manager.js";
import { executeScheduledJob } from "./executor.js";
import { notifyJobResult } from "./notifier.js";
import type { StateManager } from "../state/manager.js";
import type { RegisteredJob, ProgressEvent } from "./types.js";
import { isPlanRequiringApproval, createPlanApprovalKeyboard } from "../bot/handlers/approval.js";
import { executeInternalJob } from "./internal-handlers.js";
import { runCompletionCheckup } from "../executors/completion-checkup.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isMemoryJob(job: RegisteredJob): boolean {
  const id = job.config.id.toLowerCase();
  const query = job.config.query.toLowerCase();
  return (
    id.includes("memory") ||
    id.includes("daily-log") ||
    id.includes("session-summaries") ||
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
  private progressMessageId: Map<string, number> = new Map(); // jobId -> messageId
  private lastProgressTime: Map<string, number> = new Map(); // jobId -> timestamp

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

    // Load all schedules
    const schedules = await loadAllSchedules();
    const jobs = getAllJobs(schedules);

    // Register all jobs with cron manager
    for (const job of jobs) {
      this.cronManager.registerJob(job, job.sourceFile);
    }

    // Start file watcher for hot reload
    await this.watcher.start();

    this.isRunning = true;
    const enabledCount = this.cronManager.getEnabledJobs().length;
    logger.info({ totalJobs: jobs.length, enabledJobs: enabledCount }, "Scheduler started");
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (!this.isRunning) return;

    logger.info("Stopping scheduler...");
    this.watcher.stop();
    this.cronManager.stop();
    this.isRunning = false;
    logger.info("Scheduler stopped");
  }

  /**
   * Manually trigger a job by ID
   */
  triggerJob(jobId: string): boolean {
    const job = this.cronManager.getJob(jobId);
    if (!job) {
      logger.warn({ jobId }, "Job not found");
      return false;
    }

    this.cronManager.triggerJob(jobId, true);
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

    // Unregister all existing jobs
    this.cronManager.unregisterAll();

    // Register new jobs
    const jobs = getAllJobs(schedules);
    for (const job of jobs) {
      this.cronManager.registerJob(job, job.sourceFile);
    }

    const enabledCount = this.cronManager.getEnabledJobs().length;
    logger.info({ totalJobs: jobs.length, enabledJobs: enabledCount }, "Schedules reloaded");
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
      const existingMsgId = this.progressMessageId.get(jobId);

      if (event.type === "started") {
        // Send new progress message
        const msg = await this.bot.api.sendMessage(this.chatId, event.message, {
          parse_mode: "Markdown",
        });
        this.progressMessageId.set(jobId, msg.message_id);
        logger.info({ jobId, messageId: msg.message_id }, "Sent progress start message");
      } else if (event.type === "completed") {
        // Delete progress message on completion (final result will be sent separately)
        if (existingMsgId) {
          try {
            await this.bot.api.deleteMessage(this.chatId, existingMsgId);
          } catch {
            // Message may already be deleted
          }
          this.progressMessageId.delete(jobId);
        }
        this.lastProgressTime.delete(jobId);
      } else if (existingMsgId) {
        // Update existing progress message
        const progressText = `🔄 *${event.jobName}*\n\n${event.message}`;
        try {
          await this.bot.api.editMessageText(this.chatId, existingMsgId, progressText, {
            parse_mode: "Markdown",
          });
          logger.info({ jobId, eventType: event.type }, "Updated progress message");
        } catch (editError) {
          logger.debug({ editError, jobId }, "Message edit failed (likely unchanged)");
        }
      }
    } catch (error) {
      logger.warn({ error, jobId, eventType: event.type }, "Failed to send progress update");
    }
  }

  // Dependency triggers — extracted to constant
  private static readonly DEPENDENCY_TRIGGERS: Record<string, string[]> = {
    "idea-ingest": ["ideas-explore"],
    "ideas-explore": ["idea-dedup"],
    "job-hunt-discover": ["job-hunt-daily-approval"],
    "session-harvester": ["session-summaries"],
    "nightly-memory": ["memory-embeddings", "memory-git-commit"],
    "outcome-tracker": ["preference-updater"],
  };

  private fireDependencyTriggers(jobId: string): void {
    const downstream = Scheduler.DEPENDENCY_TRIGGERS[jobId];
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

      // Execute the job (internal handler or CLI executor)
      const result = isInternal
        ? await executeInternalJob(job, {
            stateManager: this.stateManager,
            bot: this.bot,
            chatId: this.chatId,
          })
        : await executeScheduledJob(job, onProgress, takeoverEnabled ? { skipDiagnosis: true } : undefined);

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
          });

          if (!takeoverResult) {
            // Guards prevented takeover (daily limit, concurrent limit, etc.)
            // Fall through to normal failure handling
            this.stateManager.recordScheduledJobComplete(
              runId, job.config.id, false,
              result.output, result.error, result.exitCode
            );
            this.cronManager.updateJobState(job.config.id, false);
            await notifyJobResult(this.bot, this.chatId, result, job);
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
          await notifyJobResult(this.bot, this.chatId, result, job);
          return;
        }
      }

      // === SUCCESS PATH (or failure with takeover disabled) ===
      this.stateManager.recordScheduledJobComplete(
        runId, job.config.id, result.success,
        result.output, result.error, result.exitCode
      );
      this.cronManager.updateJobState(job.config.id, result.success);

      if (result.success) {
        this.fireDependencyTriggers(job.config.id);
      }

      // Check if output contains an implementation plan requiring approval
      if (result.success && isPlanRequiringApproval(result.output)) {
        logger.info({ jobId: job.config.id }, "Plan detected, requesting approval");

        // Save plan for later execution
        this.stateManager.savePendingPlan(job.config.id, result.output);

        // Send plan for approval with inline buttons
        const preview = escapeHtml(result.output.slice(0, 1500));
        const truncated = result.output.length > 1500 ? "\n...(truncated)" : "";
        const jobName = escapeHtml(job.config.name);
        const jobId = escapeHtml(job.config.id);
        try {
          await this.bot.api.sendMessage(
            this.chatId,
            `📋 <b>Plan Generated</b>\n` +
            `<b>Job:</b> ${jobName}\n` +
            `<b>ID:</b> <code>${jobId}</code>\n\n` +
            `<pre>${preview}${truncated}</pre>\n\n` +
            `Choose an action below. Use "Add Instructions" to provide executor context.`,
            {
              parse_mode: "HTML",
              reply_markup: createPlanApprovalKeyboard(job.config.id),
            }
          );
        } catch (err) {
          logger.warn({ error: err, jobId: job.config.id }, "Failed to send plan approval message");
        }

        // Don't send normal notification - plan approval takes over
        return;
      }

      // Notify via Telegram (final result)
      await notifyJobResult(this.bot, this.chatId, result, job);

      if (result.fallbackUsed && result.executorUsed) {
        try {
          await this.bot.api.sendMessage(
            this.chatId,
            `⚠️ Fallback used for *${job.config.name}*\\nExecutor: ${result.executorUsed}`,
            { parse_mode: "Markdown" }
          );
        } catch (err) {
          logger.warn({ error: err, jobId: job.config.id }, "Failed to notify fallback usage");
        }
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
