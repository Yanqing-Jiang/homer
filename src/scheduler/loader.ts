import { readFile, watch } from "fs/promises";
import { existsSync } from "fs";
import { logger } from "../utils/logger.js";
import {
  type ScheduleFile,
  type ScheduledJobConfig,
  SCHEDULE_LOCATIONS,
} from "./types.js";

interface LoadedSchedule {
  jobs: ScheduledJobConfig[];
  sourceFile: string;
}

type ScheduleChangeCallback = (schedules: LoadedSchedule[]) => void;

/**
 * Validates a cron expression (basic validation)
 */
function isValidCron(cron: string): boolean {
  // Basic validation: should have 5 or 6 space-separated parts
  const parts = cron.trim().split(/\s+/);
  return parts.length >= 5 && parts.length <= 6;
}

/**
 * Validates a scheduled job configuration
 */
function validateJob(job: unknown, sourceFile: string): ScheduledJobConfig | null {
  if (!job || typeof job !== "object") {
    logger.warn({ sourceFile }, "Invalid job: not an object");
    return null;
  }

  const j = job as Record<string, unknown>;

  if (typeof j.id !== "string" || !j.id) {
    logger.warn({ sourceFile, job: j }, "Invalid job: missing id");
    return null;
  }

  if (typeof j.cron !== "string" || !isValidCron(j.cron)) {
    logger.warn({ sourceFile, jobId: j.id }, "Invalid job: invalid cron expression");
    return null;
  }

  if (typeof j.query !== "string" || !j.query) {
    logger.warn({ sourceFile, jobId: j.id }, "Invalid job: missing query");
    return null;
  }

  const validLanes = ["work", "life", "default"];
  const lane = typeof j.lane === "string" && validLanes.includes(j.lane)
    ? j.lane as "work" | "life" | "default"
    : "default";

  return {
    id: j.id,
    name: typeof j.name === "string" ? j.name : j.id,
    cron: j.cron,
    query: j.query,
    lane,
    enabled: j.enabled !== false, // default to true
    timeout: typeof j.timeout === "number" ? j.timeout : undefined,
    model: typeof j.model === "string" ? j.model : undefined,
    executor: typeof j.executor === "string" && ["claude", "kimi", "gemini"].includes(j.executor)
      ? j.executor as "claude" | "kimi" | "gemini"
      : undefined,
    contextFiles: Array.isArray(j.contextFiles) ? j.contextFiles : undefined,
    streamProgress: j.streamProgress === true,
    notifyOnSuccess: j.notifyOnSuccess !== false, // default to true
    notifyOnFailure: j.notifyOnFailure !== false, // default to true
  };
}

/**
 * Load and validate a schedule file
 */
async function loadScheduleFile(
  path: string,
  defaultLane: "work" | "life" | "default"
): Promise<LoadedSchedule | null> {
  if (!existsSync(path)) {
    logger.debug({ path }, "Schedule file does not exist");
    return null;
  }

  try {
    const content = await readFile(path, "utf-8");
    const data = JSON.parse(content) as ScheduleFile;

    if (!data.jobs || !Array.isArray(data.jobs)) {
      logger.warn({ path }, "Schedule file has no jobs array");
      return { jobs: [], sourceFile: path };
    }

    const validJobs: ScheduledJobConfig[] = [];
    for (const job of data.jobs) {
      const validated = validateJob(job, path);
      if (validated) {
        // Use default lane if not specified in job
        if (!job.lane) {
          validated.lane = defaultLane;
        }
        validJobs.push(validated);
      }
    }

    logger.info({ path, jobCount: validJobs.length }, "Loaded schedule file");
    return { jobs: validJobs, sourceFile: path };
  } catch (error) {
    logger.error({ path, error }, "Failed to load schedule file");
    return null;
  }
}

/**
 * Load all schedule files from configured locations
 */
export async function loadAllSchedules(): Promise<LoadedSchedule[]> {
  const schedules: LoadedSchedule[] = [];

  for (const { path, lane } of SCHEDULE_LOCATIONS) {
    const schedule = await loadScheduleFile(path, lane);
    if (schedule && schedule.jobs.length > 0) {
      schedules.push(schedule);
    }
  }

  return schedules;
}

/**
 * Get all jobs from all schedules as a flat list with source info
 */
export function getAllJobs(schedules: LoadedSchedule[]): Array<ScheduledJobConfig & { sourceFile: string }> {
  const jobs: Array<ScheduledJobConfig & { sourceFile: string }> = [];

  for (const schedule of schedules) {
    for (const job of schedule.jobs) {
      jobs.push({ ...job, sourceFile: schedule.sourceFile });
    }
  }

  return jobs;
}

/**
 * Watch schedule files for changes and call callback on change
 */
export class ScheduleWatcher {
  private watchers: Map<string, AbortController> = new Map();
  private callback: ScheduleChangeCallback;
  private debounceTimer: NodeJS.Timeout | null = null;
  private debounceMs = 1000;

  constructor(callback: ScheduleChangeCallback) {
    this.callback = callback;
  }

  async start(): Promise<void> {
    for (const { path } of SCHEDULE_LOCATIONS) {
      // Don't await - watchFile runs indefinitely watching for changes
      this.watchFile(path);
    }
  }

  stop(): void {
    for (const controller of this.watchers.values()) {
      controller.abort();
    }
    this.watchers.clear();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
  }

  private async watchFile(path: string): Promise<void> {
    if (!existsSync(path)) {
      logger.debug({ path }, "Schedule file does not exist, not watching");
      return;
    }

    const controller = new AbortController();
    this.watchers.set(path, controller);

    try {
      const watcher = watch(path, { signal: controller.signal });

      for await (const event of watcher) {
        if (event.eventType === "change") {
          logger.info({ path }, "Schedule file changed, reloading");
          this.scheduleReload();
        }
      }
    } catch (error: unknown) {
      // AbortError is expected when stopping
      if (error instanceof Error && error.name !== "AbortError") {
        logger.error({ path, error }, "Schedule file watcher error");
      }
    }
  }

  private scheduleReload(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      const schedules = await loadAllSchedules();
      this.callback(schedules);
    }, this.debounceMs);
  }
}
