import { Cron } from "croner";
import { logger } from "../utils/logger.js";
import { monitorEventLoopDelay } from "perf_hooks";
import type { CronManager } from "./manager.js";

// Global fire counters
let totalFires = 0;
let lastFireAt = 0;
const jobFireTimes: Map<string, number> = new Map();

let heartbeatJob: Cron | null = null;
let watchdogJob: Cron | null = null;
let eld: ReturnType<typeof monitorEventLoopDelay> | null = null;

// Self-exit hang detector: launchd restarts the daemon after process.exit.
// Threshold: 3 consecutive heartbeats with p99 event-loop lag > 5000ms.
const HANG_LAG_MS = 5000;
const HANG_CONSECUTIVE = 3;
let hangCount = 0;

/**
 * Record a cron fire (global counter)
 */
export function recordFire(): void {
  totalFires++;
  lastFireAt = Date.now();
}

/**
 * Record a specific job fire timestamp
 */
export function recordJobFire(jobId: string): void {
  jobFireTimes.set(jobId, Date.now());
}

/**
 * Start heartbeat logging (every 60s)
 */
export function startHeartbeat(cronManager: CronManager): void {
  // Start event loop delay monitoring
  eld = monitorEventLoopDelay({ resolution: 20 });
  eld.enable();

  heartbeatJob = new Cron("* * * * *", () => {
    if (!eld) return;

    const meanMs = eld.mean / 1e6;
    const p99Ms = eld.percentile(99) / 1e6;

    const activeTasks = cronManager.getEnabledJobs().length;
    const totalJobs = cronManager.getAllJobs().length;

    logger.info(
      {
        activeTasks,
        totalJobs,
        totalFires,
        eventLoopLagMeanMs: Math.round(meanMs * 100) / 100,
        eventLoopLagP99Ms: Math.round(p99Ms * 100) / 100,
        lastFireAt: lastFireAt ? new Date(lastFireAt).toISOString() : null,
      },
      "scheduler_heartbeat"
    );

    if (p99Ms > 500) {
      logger.fatal(
        { eventLoopLagP99Ms: p99Ms },
        "Event loop lag critically high — cron fires at risk"
      );
    }

    // Hang detector: self-exit so launchd restarts a wedged daemon.
    if (p99Ms > HANG_LAG_MS) {
      hangCount++;
      if (hangCount >= HANG_CONSECUTIVE) {
        logger.fatal(
          { eventLoopLagP99Ms: p99Ms, hangCount },
          "Event loop wedged — exiting so launchd restarts the daemon"
        );
        process.exit(1);
      }
    } else {
      hangCount = 0;
    }

    // Reset ELD histogram for fresh window
    eld.reset();
  });
}

/**
 * Stop heartbeat
 */
export function stopHeartbeat(): void {
  if (heartbeatJob) {
    heartbeatJob.stop();
    heartbeatJob = null;
  }
  if (eld) {
    eld.disable();
    eld = null;
  }
}

/**
 * Start watchdog for zombie cron jobs (every 5 min)
 */
export function startWatchdog(
  cronManager: CronManager,
  onZombie: (jobId: string) => void
): void {
  watchdogJob = new Cron("*/5 * * * *", () => {
    const now = Date.now();

    for (const job of cronManager.getEnabledJobs()) {
      const task = cronManager.getCronTask(job.config.id);
      if (!task) continue;

      const lastFire = jobFireTimes.get(job.config.id);
      if (!lastFire) continue; // Haven't fired yet — can't judge

      // Estimate interval from nextRun
      const nextRun = task.nextRun();
      const prevRun = task.previousRun();
      if (!nextRun || !prevRun) continue;

      const intervalMs = nextRun.getTime() - prevRun.getTime();
      if (intervalMs <= 0) continue;

      const elapsed = now - lastFire;

      // Zombie: hasn't fired in > 2x its interval
      if (elapsed > intervalMs * 2) {
        logger.error(
          { jobId: job.config.id, elapsedMs: elapsed, intervalMs },
          "Zombie cron detected — job hasn't fired in 2x interval"
        );
        onZombie(job.config.id);
      }
    }
  });
}

/**
 * Stop watchdog
 */
export function stopWatchdog(): void {
  if (watchdogJob) {
    watchdogJob.stop();
    watchdogJob = null;
  }
}
