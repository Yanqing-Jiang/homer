import type { Bot } from "grammy";
import { logger } from "../utils/logger.js";
import { loadAllSchedules, getAllJobs, ScheduleWatcher } from "./loader.js";
import { CronManager } from "./manager.js";
import { executeScheduledJob } from "./executor.js";
import { notifyJobResult } from "./notifier.js";
import type { StateManager } from "../state/manager.js";
import type { RegisteredJob } from "./types.js";

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
   * Execute a job and handle results
   */
  private async executeJob(job: RegisteredJob, _manual: boolean): Promise<void> {
    try {
      // Record job start
      this.stateManager.recordScheduledJobStart(job.config.id, job.config.name, job.sourceFile);

      // Execute the job
      const result = await executeScheduledJob(job);

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

      // Notify via Telegram
      await notifyJobResult(this.bot, this.chatId, result, job);
    } catch (error) {
      logger.error({ jobId: job.config.id, error }, "Failed to execute scheduled job");

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
export type { RegisteredJob, ScheduledJobConfig, JobExecutionResult } from "./types.js";
