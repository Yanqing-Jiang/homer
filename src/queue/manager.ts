import { randomUUID } from "crypto";
import { StateManager, type Job } from "../state/manager.js";
import { logger } from "../utils/logger.js";
import { EventEmitter } from "events";

const MAX_CONCURRENT_PER_LANE = 1;
const MAX_CONCURRENT_GLOBAL = 4;
const MAX_RETRY_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 1000;

export interface QueuedJob {
  id: string;
  lane: string;
  executor: string;
  query: string;
  chatId: number;
  messageId?: number;
}

export class QueueManager extends EventEmitter {
  private stateManager: StateManager;
  private processing = false;

  constructor(stateManager: StateManager) {
    super();
    this.stateManager = stateManager;
  }

  /**
   * Add a job to the queue
   */
  enqueue(job: Omit<QueuedJob, "id">): string {
    const id = randomUUID();
    this.stateManager.createJob({
      id,
      lane: job.lane,
      executor: job.executor,
      query: job.query,
      chatId: job.chatId,
      messageId: job.messageId,
    });

    logger.info({ jobId: id, lane: job.lane, executor: job.executor }, "Job enqueued");
    this.emit("job:enqueued", id);

    // Trigger processing
    this.processNext();

    return id;
  }

  /**
   * Get the next available job for processing
   * Respects concurrency limits per lane and globally
   */
  getNextAvailableJob(): Job | null {
    // Check global concurrent limit
    const globalRunning = this.stateManager.getRunningJobsCount();
    if (globalRunning >= MAX_CONCURRENT_GLOBAL) {
      logger.debug({ globalRunning, maxGlobal: MAX_CONCURRENT_GLOBAL }, "Global concurrent limit reached");
      return null;
    }

    // Get all lanes and check each for available work
    const lanes = ["work", "invest", "personal", "learning"];

    for (const lane of lanes) {
      // Check per-lane concurrent limit
      const laneRunning = this.stateManager.getRunningJobsCount(lane);
      if (laneRunning >= MAX_CONCURRENT_PER_LANE) {
        continue;
      }

      // Get next pending job for this lane
      const job = this.stateManager.getNextPendingJob(lane);
      if (job) {
        return job;
      }
    }

    return null;
  }

  /**
   * Mark a job as running
   */
  startJob(jobId: string): void {
    this.stateManager.updateJobStatus(jobId, "running");
    logger.info({ jobId }, "Job started");
    this.emit("job:started", jobId);
  }

  /**
   * Mark a job as completed
   */
  completeJob(jobId: string, result: string): void {
    this.stateManager.updateJobStatus(jobId, "completed", { result });
    logger.info({ jobId }, "Job completed");
    this.emit("job:completed", jobId);

    // Process next job
    this.processNext();
  }

  /**
   * Mark a job as failed, with potential retry
   */
  failJob(jobId: string, error: string): void {
    const job = this.stateManager.getJobById(jobId);
    if (!job) {
      logger.error({ jobId }, "Job not found for failure update");
      return;
    }

    if (job.attempts < MAX_RETRY_ATTEMPTS) {
      // Retry with exponential backoff
      const delay = BASE_RETRY_DELAY_MS * Math.pow(2, job.attempts);
      logger.warn({ jobId, attempts: job.attempts, retryDelay: delay }, "Job failed, scheduling retry");

      this.stateManager.updateJobStatus(jobId, "pending", { error });
      this.emit("job:retry", jobId, delay);

      setTimeout(() => {
        this.processNext();
      }, delay);
    } else {
      // Max retries exceeded
      logger.error({ jobId, attempts: job.attempts }, "Job failed after max retries");
      this.stateManager.updateJobStatus(jobId, "failed", { error });
      this.emit("job:failed", jobId);

      // Process next job
      this.processNext();
    }
  }

  /**
   * Get a job by ID
   */
  getJob(jobId: string): Job | null {
    return this.stateManager.getJobById(jobId);
  }

  /**
   * Get recent jobs
   */
  getRecentJobs(limit: number = 50): Job[] {
    return this.stateManager.getRecentJobs(limit);
  }

  /**
   * Get job statistics
   */
  getStats(): { pending: number; running: number; completed: number; failed: number } {
    return this.stateManager.getJobStats();
  }

  /**
   * Trigger processing of the next available job
   */
  private processNext(): void {
    if (this.processing) return;
    this.processing = true;

    try {
      const job = this.getNextAvailableJob();
      if (job) {
        this.emit("job:ready", job);
      }
    } finally {
      this.processing = false;
    }
  }
}
