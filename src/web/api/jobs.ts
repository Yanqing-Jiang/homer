import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { CronUtils } from "../../utils/cron.js";
import type { StateManager } from "../../state/manager.js";
import type { Scheduler } from "../../scheduler/index.js";
import { logger } from "../../utils/logger.js";

const SCHEDULE_FILE = process.env.SCHEDULE_FILE ?? "/Users/yj/memory/schedule.json";

let schedulerRef: Scheduler | null = null;

interface ScheduleConfig {
  version: string;
  jobs: Array<{
    id: string;
    name: string;
    cron: string;
    query: string;
    lane: string;
    enabled: boolean;
    timeout?: number;
    model?: string;
    contextFiles?: string[];
    streamProgress?: boolean;
    notifyOnSuccess?: boolean;
    notifyOnFailure?: boolean;
  }>;
}

interface UpdateJobBody {
  enabled?: boolean;
  cron?: string;
  query?: string;
  name?: string;
  scheduledDate?: string;  // ISO date string - for drag-drop reschedule
}

export interface JobWithSchedule {
  id: string;
  name: string;
  cron: string;
  cronHuman: string;
  lane: string;
  enabled: boolean;
  timeout: number | null;
  model: string | null;
  lastRun: string | null;
  lastSuccess: string | null;
  consecutiveFailures: number;
  nextRuns: string[];
}

/**
 * Set the scheduler reference for job operations
 */
export function setJobsScheduler(scheduler: Scheduler): void {
  schedulerRef = scheduler;
}

/**
 * Register jobs API routes
 */
export function registerJobsRoutes(
  server: FastifyInstance,
  stateManager: StateManager
): void {
  // List all jobs with their next scheduled runs
  server.get("/api/jobs/scheduled", async () => {
    const scheduleConfig = loadScheduleConfig();
    const registeredJobs = schedulerRef?.getJobs() ?? [];

    const jobs: JobWithSchedule[] = scheduleConfig.jobs.map((job) => {
      const registered = registeredJobs.find((r) => r.config.id === job.id);
      const state = stateManager.getScheduledJobState(job.id);

      return {
        id: job.id,
        name: job.name,
        cron: job.cron,
        cronHuman: cronToHuman(job.cron),
        lane: job.lane,
        enabled: job.enabled,
        timeout: job.timeout ?? null,
        model: job.model ?? null,
        lastRun: state?.lastRunAt ?? registered?.lastRun?.toISOString() ?? null,
        lastSuccess: state?.lastSuccessAt ?? registered?.lastSuccess?.toISOString() ?? null,
        consecutiveFailures: state?.consecutiveFailures ?? registered?.consecutiveFailures ?? 0,
        nextRuns: getNextRuns(job.cron, 5),
      };
    });

    return { jobs };
  });

  // Get single job details
  server.get("/api/jobs/scheduled/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const scheduleConfig = loadScheduleConfig();
    const job = scheduleConfig.jobs.find((j) => j.id === id);

    if (!job) {
      reply.status(404);
      return { error: "Job not found" };
    }

    const state = stateManager.getScheduledJobState(id);
    const history = stateManager.getRecentScheduledJobRuns(id, 10);

    return {
      ...job,
      cronHuman: cronToHuman(job.cron),
      state,
      history: history.map((h) => ({
        id: h.id,
        startedAt: h.startedAt,
        completedAt: h.completedAt,
        success: h.success === 1,
        output: h.output?.slice(0, 500),
        error: h.error,
        exitCode: h.exitCode,
      })),
      nextRuns: getNextRuns(job.cron, 10),
    };
  });

  // Update job configuration
  server.patch("/api/jobs/scheduled/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as UpdateJobBody;

    const scheduleConfig = loadScheduleConfig();
    const jobIndex = scheduleConfig.jobs.findIndex((j) => j.id === id);

    if (jobIndex === -1) {
      reply.status(404);
      return { error: "Job not found" };
    }

    // Apply updates
    const job = scheduleConfig.jobs[jobIndex]!;
    if (body.enabled !== undefined) job.enabled = body.enabled;
    if (body.cron !== undefined) job.cron = body.cron;
    if (body.scheduledDate !== undefined) {
      // Convert scheduled date to cron, preserving original time
      job.cron = dateTimeToCron(body.scheduledDate, job.cron);
    }
    if (body.query !== undefined) job.query = body.query;
    if (body.name !== undefined) job.name = body.name;

    // Save config (file watcher handles hot reload automatically)
    saveScheduleConfig(scheduleConfig);

    return {
      ...job,
      cronHuman: cronToHuman(job.cron),
      message: "Job updated",
    };
  });

  // Trigger job immediately
  server.post("/api/jobs/scheduled/:id/run", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    if (!schedulerRef) {
      reply.status(503);
      return { error: "Scheduler not initialized" };
    }

    const job = schedulerRef.getJob(id);
    if (!job) {
      reply.status(404);
      return { error: "Job not found" };
    }

    const triggered = schedulerRef.triggerJob(id);
    if (!triggered) {
      reply.status(400);
      return { error: "Failed to trigger job" };
    }

    return { success: true, jobId: id, jobName: job.config.name };
  });

  // Get job run history
  server.get("/api/jobs/scheduled/:id/history", async (request: FastifyRequest) => {
    const { id } = request.params as { id: string };
    const query = request.query as { limit?: string };
    const limit = query.limit ? parseInt(query.limit, 10) : 20;

    const history = stateManager.getRecentScheduledJobRuns(id, limit);

    return {
      history: history.map((h) => ({
        id: h.id,
        startedAt: h.startedAt,
        completedAt: h.completedAt,
        success: h.success === 1,
        output: h.output,
        error: h.error,
        exitCode: h.exitCode,
        durationMs: h.completedAt && h.startedAt
          ? new Date(h.completedAt).getTime() - new Date(h.startedAt).getTime()
          : null,
      })),
    };
  });

  // SSE endpoint for job status updates
  server.get("/api/jobs/stream", async (request: FastifyRequest, reply: FastifyReply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let eventId = 0;

    const sendEvent = (type: string, data: unknown) => {
      eventId++;
      reply.raw.write(`id: ${eventId}\n`);
      reply.raw.write(`event: ${type}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Send initial state
    const scheduleConfig = loadScheduleConfig();
    sendEvent("init", { jobCount: scheduleConfig.jobs.length });

    // Heartbeat and status check every 30 seconds
    const interval = setInterval(() => {
      reply.raw.write(": heartbeat\n\n");

      // Send any running jobs
      const registeredJobs = schedulerRef?.getJobs() ?? [];
      const activeJobs = registeredJobs.filter((j) => j.lastRun && !j.lastSuccess);
      if (activeJobs.length > 0) {
        sendEvent("status", {
          running: activeJobs.map((j) => ({
            id: j.config.id,
            name: j.config.name,
            startedAt: j.lastRun?.toISOString(),
          })),
        });
      }
    }, 30000);

    request.raw.on("close", () => {
      clearInterval(interval);
    });
  });

  // Calendar view - get jobs by date range
  server.get("/api/jobs/calendar", async (request: FastifyRequest) => {
    const query = request.query as { start?: string; end?: string };

    // Default to current month
    const now = new Date();
    const startDate = query.start
      ? new Date(query.start)
      : new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = query.end
      ? new Date(query.end)
      : new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const scheduleConfig = loadScheduleConfig();
    const calendarEvents: Array<{
      jobId: string;
      jobName: string;
      date: string;
      time: string;
      enabled: boolean;
    }> = [];

    // Generate schedule for each enabled job
    for (const job of scheduleConfig.jobs) {
      const runs = getRunsBetween(job.cron, startDate, endDate);
      for (const run of runs) {
        calendarEvents.push({
          jobId: job.id,
          jobName: job.name,
          date: run.toISOString().split("T")[0]!,
          time: run.toTimeString().slice(0, 5),
          enabled: job.enabled,
        });
      }
    }

    return {
      start: startDate.toISOString().split("T")[0],
      end: endDate.toISOString().split("T")[0],
      events: calendarEvents.sort((a, b) => {
        const aDate = new Date(`${a.date}T${a.time}`);
        const bDate = new Date(`${b.date}T${b.time}`);
        return aDate.getTime() - bDate.getTime();
      }),
    };
  });
}

/**
 * Load schedule configuration from file
 */
function loadScheduleConfig(): ScheduleConfig {
  if (!existsSync(SCHEDULE_FILE)) {
    return { version: "1.0", jobs: [] };
  }

  try {
    const content = readFileSync(SCHEDULE_FILE, "utf-8");
    return JSON.parse(content) as ScheduleConfig;
  } catch (error) {
    logger.error({ error, file: SCHEDULE_FILE }, "Failed to load schedule config");
    return { version: "1.0", jobs: [] };
  }
}

/**
 * Save schedule configuration to file
 */
function saveScheduleConfig(config: ScheduleConfig): void {
  try {
    writeFileSync(SCHEDULE_FILE, JSON.stringify(config, null, 2), "utf-8");
    logger.info({ file: SCHEDULE_FILE }, "Saved schedule config");
  } catch (error) {
    logger.error({ error, file: SCHEDULE_FILE }, "Failed to save schedule config");
    throw error;
  }
}

/**
 * Convert cron expression to human-readable string
 */
function cronToHuman(cron: string): string {
  return CronUtils.toHuman(cron);
}

/**
 * Get next N run times for a cron expression
 */
function getNextRuns(cron: string, count: number): string[] {
  return CronUtils.getNextRuns(cron, count).map(d => d.toISOString());
}

/**
 * Get all runs between two dates for a cron expression
 */
function getRunsBetween(cron: string, start: Date, end: Date): Date[] {
  return CronUtils.getRunsBetween(cron, start, end);
}

/**
 * Convert a date/time to a cron expression, preserving the original time from the cron
 * This is used for drag-drop rescheduling - we want to keep the same time but change the day
 */
function dateTimeToCron(scheduledDate: string, originalCron: string): string {
  const parts = originalCron.split(" ");
  if (parts.length !== 5) return originalCron;

  const [minute, hour, , , ] = parts;
  const date = new Date(scheduledDate);

  // For daily jobs, keep the same time but update to run on the new day
  // Since cron doesn't have a "run once on specific date" format,
  // we'll create a weekly cron that runs on the target day of week
  const dayOfWeek = date.getDay(); // 0-6, Sunday = 0

  return `${minute} ${hour} * * ${dayOfWeek}`;
}
