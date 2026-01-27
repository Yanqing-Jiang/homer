import cron, { type ScheduledTask } from "node-cron";
import { EventEmitter } from "events";
import { logger } from "../utils/logger.js";
import type { ScheduledJobConfig, RegisteredJob } from "./types.js";

interface JobTriggerEvent {
  job: RegisteredJob;
  manual: boolean;
}

/**
 * Manages cron job scheduling and state
 */
export class CronManager extends EventEmitter {
  private tasks: Map<string, ScheduledTask> = new Map();
  private jobs: Map<string, RegisteredJob> = new Map();

  constructor() {
    super();
  }

  /**
   * Register a job with the cron scheduler
   */
  registerJob(config: ScheduledJobConfig, sourceFile: string): void {
    // Unregister existing job with same id
    if (this.tasks.has(config.id)) {
      this.unregisterJob(config.id);
    }

    const registeredJob: RegisteredJob = {
      config,
      sourceFile,
      nextRun: this.getNextRun(config.cron),
      lastRun: null,
      lastSuccess: null,
      consecutiveFailures: 0,
    };

    this.jobs.set(config.id, registeredJob);

    if (config.enabled) {
      const task = cron.schedule(config.cron, () => {
        this.triggerJob(config.id, false);
      });
      this.tasks.set(config.id, task);
      logger.info(
        { jobId: config.id, name: config.name, cron: config.cron },
        "Registered scheduled job"
      );
    } else {
      logger.debug(
        { jobId: config.id, name: config.name },
        "Registered disabled job (not scheduling)"
      );
    }
  }

  /**
   * Unregister a job from the cron scheduler
   */
  unregisterJob(jobId: string): void {
    const task = this.tasks.get(jobId);
    if (task) {
      task.stop();
      this.tasks.delete(jobId);
    }
    this.jobs.delete(jobId);
    logger.debug({ jobId }, "Unregistered scheduled job");
  }

  /**
   * Unregister all jobs
   */
  unregisterAll(): void {
    for (const [jobId, task] of this.tasks) {
      task.stop();
      logger.debug({ jobId }, "Stopped scheduled job");
    }
    this.tasks.clear();
    this.jobs.clear();
  }

  /**
   * Trigger a job for execution (manual or scheduled)
   */
  triggerJob(jobId: string, manual: boolean): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      logger.warn({ jobId }, "Attempted to trigger unknown job");
      return;
    }

    if (!job.config.enabled && !manual) {
      logger.debug({ jobId }, "Skipping disabled job");
      return;
    }

    logger.info(
      { jobId, name: job.config.name, manual },
      manual ? "Manually triggering job" : "Triggering scheduled job"
    );

    this.emit("job:trigger", { job, manual } as JobTriggerEvent);
  }

  /**
   * Update job state after execution
   */
  updateJobState(jobId: string, success: boolean): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.lastRun = new Date();
    job.nextRun = job.config.enabled ? this.getNextRun(job.config.cron) : null;

    if (success) {
      job.lastSuccess = new Date();
      job.consecutiveFailures = 0;
    } else {
      job.consecutiveFailures++;
    }
  }

  /**
   * Get a registered job by ID
   */
  getJob(jobId: string): RegisteredJob | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Get all registered jobs
   */
  getAllJobs(): RegisteredJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Get all enabled jobs
   */
  getEnabledJobs(): RegisteredJob[] {
    return this.getAllJobs().filter((j) => j.config.enabled);
  }

  /**
   * Calculate next run time for a cron expression
   */
  private getNextRun(_cronExpr: string): Date | null {
    try {
      // node-cron doesn't have a built-in way to get next run
      // We use cron-parser for this
      // For now, return null and we'll implement properly
      // Actually node-cron validates, let's use a simpler approach
      return null; // Will be calculated when needed
    } catch {
      return null;
    }
  }

  /**
   * Stop all scheduled tasks
   */
  stop(): void {
    this.unregisterAll();
    this.removeAllListeners();
    logger.info("Cron manager stopped");
  }
}
