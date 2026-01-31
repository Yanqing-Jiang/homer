import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { readFileSync, writeFileSync, existsSync } from "fs";
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
  const parts = cron.split(" ");
  if (parts.length !== 5) return cron;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Common patterns
  if (minute === "0" && hour === "*") {
    return "Every hour";
  }
  if (minute === "*/15" || minute === "*/30") {
    return `Every ${minute.slice(2)} minutes`;
  }
  if (minute === "0" && hour?.startsWith("*/")) {
    return `Every ${hour.slice(2)} hours`;
  }
  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    const h = parseInt(hour ?? "0", 10);
    const m = parseInt(minute ?? "0", 10);
    const time = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
    return `Daily at ${time}`;
  }

  return cron;
}

/**
 * Get next N run times for a cron expression
 */
function getNextRuns(cron: string, count: number): string[] {
  // Simple implementation - for accurate results, use a cron library
  const runs: string[] = [];
  const now = new Date();
  let current = new Date(now);

  // Parse cron
  const parts = cron.split(" ");
  if (parts.length !== 5) return runs;

  const [minutePart, hourPart] = parts;

  // Simple: handle fixed hour/minute patterns
  const minute = minutePart?.startsWith("*/")
    ? -1  // Every N minutes
    : parseInt(minutePart ?? "0", 10);

  const hourInterval = hourPart?.startsWith("*/")
    ? parseInt(hourPart.slice(2), 10)
    : null;
  const hour = hourInterval === null
    ? parseInt(hourPart ?? "0", 10)
    : -1;

  for (let i = 0; i < count && runs.length < count; i++) {
    current = new Date(current.getTime() + 60 * 60 * 1000); // Add 1 hour

    if (hourInterval !== null) {
      // Every N hours
      if (current.getHours() % hourInterval === 0 && current.getMinutes() === (minute >= 0 ? minute : 0)) {
        runs.push(current.toISOString());
      }
    } else if (hour >= 0 && minute >= 0) {
      // Daily at specific time
      if (current.getHours() === hour && current.getMinutes() === minute) {
        runs.push(current.toISOString());
      }
    }
  }

  return runs;
}

/**
 * Get all runs between two dates for a cron expression
 */
function getRunsBetween(cron: string, start: Date, end: Date): Date[] {
  const runs: Date[] = [];
  const parts = cron.split(" ");
  if (parts.length !== 5) return runs;

  const [minutePart, hourPart] = parts;
  const minute = minutePart?.startsWith("*/") ? 0 : parseInt(minutePart ?? "0", 10);
  const hourInterval = hourPart?.startsWith("*/")
    ? parseInt(hourPart.slice(2), 10)
    : null;
  const hour = hourInterval === null ? parseInt(hourPart ?? "0", 10) : -1;

  // Iterate through each day
  const current = new Date(start);
  current.setHours(0, 0, 0, 0);

  while (current <= end) {
    if (hourInterval !== null) {
      // Every N hours
      for (let h = 0; h < 24; h += hourInterval) {
        const run = new Date(current);
        run.setHours(h, minute, 0, 0);
        if (run >= start && run <= end) {
          runs.push(run);
        }
      }
    } else if (hour >= 0) {
      // Specific hour
      const run = new Date(current);
      run.setHours(hour, minute, 0, 0);
      if (run >= start && run <= end) {
        runs.push(run);
      }
    }
    current.setDate(current.getDate() + 1);
  }

  return runs;
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
