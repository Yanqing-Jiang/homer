import { Cron } from "croner";
import { EventEmitter } from "events";
import { logger } from "../utils/logger.js";
import { CronUtils } from "../utils/cron.js";
import { recordFire, recordJobFire } from "./observability.js";
import type { ScheduledJobConfig, RegisteredJob } from "./types.js";

interface JobTriggerEvent {
  job: RegisteredJob;
  manual: boolean;
}

/**
 * Manages cron job scheduling and state
 */
export class CronManager extends EventEmitter {
  private tasks: Map<string, Cron> = new Map();
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
      nextRun: config.enabled ? CronUtils.getNextRun(config.cron) : null,
      lastRun: null,
      lastSuccess: null,
      consecutiveFailures: 0,
    };

    this.jobs.set(config.id, registeredJob);
    this.emit("job:updated", registeredJob);

    if (config.enabled) {
      const task = new Cron(config.cron, { protect: true, catch: true }, () => {
        const now = Date.now();
        const prev = task.previousRun();
        if (prev) {
          const delta = now - prev.getTime();
          if (delta > 2000) {
            logger.warn({ jobId: config.id, deltaMs: delta }, "Cron callback fired late");
          }
        }
        recordFire();
        recordJobFire(config.id);
        this.triggerJob(config.id, false);
      });
      this.tasks.set(config.id, task);
      logger.info(
        { jobId: config.id, name: config.name, cron: config.cron, nextRun: task.nextRun()?.toISOString() },
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
    // Use croner's native nextRun for accuracy
    const task = this.tasks.get(jobId);
    job.nextRun = task ? (task.nextRun() ?? null) : null;

    if (success) {
      job.lastSuccess = new Date();
      job.consecutiveFailures = 0;
    } else {
      job.consecutiveFailures++;
    }

    this.emit("job:updated", job);
  }

  /**
   * Disable a job at runtime (stops its cron task, marks config as disabled).
   * Accepts optional StateManager to persist the disable to DB.
   */
  disableJob(jobId: string, stateManager?: { syncScheduledJobEnabled: (jobs: { jobId: string; enabled: boolean }[]) => void }): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    job.config.enabled = false;
    job.nextRun = null;

    const task = this.tasks.get(jobId);
    if (task) {
      task.stop();
      this.tasks.delete(jobId);
    }

    // Persist to DB so disable survives restart
    if (stateManager) {
      stateManager.syncScheduledJobEnabled([{ jobId, enabled: false }]);
    }

    this.emit("job:updated", job);
    logger.info({ jobId, name: job.config.name }, "Job disabled at runtime");
    return true;
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
   * Get the croner Cron instance for a job (for observability)
   */
  getCronTask(jobId: string): Cron | undefined {
    return this.tasks.get(jobId);
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
