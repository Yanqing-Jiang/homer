import type { Bot } from "grammy";
import { logger } from "../utils/logger.js";
import { loadAllSchedules, getAllJobs, ScheduleWatcher } from "./loader.js";
import { CronManager } from "./manager.js";
import { executeScheduledJob } from "./executor.js";
import { notifyJobResult } from "./notifier.js";
import type { StateManager } from "../state/manager.js";
import type { RegisteredJob, ProgressEvent } from "./types.js";

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

  /**
   * Execute a job and handle results
   */
  private async executeJob(job: RegisteredJob, _manual: boolean): Promise<void> {
    try {
      // Record job start
      this.stateManager.recordScheduledJobStart(job.config.id, job.config.name, job.sourceFile);

      // Only stream progress if explicitly enabled (most jobs don't need it)
      const onProgress = job.config.streamProgress
        ? (event: ProgressEvent) => void this.sendProgress(job.config.id, event)
        : undefined;

      // Execute the job
      const result = await executeScheduledJob(job, onProgress);

      // Update job state
      this.cronManager.updateJobState(job.config.id, result.success);

      // Record result in database
      this.stateManager.recordScheduledJobComplete(
        job.config.id,
        result.success,
        result.output,
        result.error,
        result.exitCode
      );

      // Notify via Telegram (final result)
      await notifyJobResult(this.bot, this.chatId, result, job);
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

      // Record failure
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      this.stateManager.recordScheduledJobComplete(
        job.config.id,
        false,
        "",
        errorMessage,
        1
      );

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
