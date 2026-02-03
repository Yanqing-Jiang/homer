/**
 * Schedule file structure (schedule.json)
 */
export interface ScheduleFile {
  version: string;
  jobs: ScheduledJobConfig[];
}

/**
 * Individual job configuration from schedule.json
 */
export interface ScheduledJobConfig {
  id: string;
  name: string;
  cron: string;
  query: string;
  lane: "work" | "life" | "default";
  enabled: boolean;
  timeout?: number; // ms, defaults to 600000 (10 min)
  model?: string; // e.g. "sonnet", "haiku", "opus" - defaults to sonnet
  executor?: "claude" | "kimi" | "gemini"; // defaults to claude; kimi for cheap API; gemini for free CLI
  contextFiles?: string[]; // files to load and inject as system prompt context
  streamProgress?: boolean; // stream tool usage to Telegram (default: false)
  notifyOnSuccess?: boolean; // defaults to true
  notifyOnFailure?: boolean; // defaults to true
}

/**
 * Registered job with runtime metadata
 */
export interface RegisteredJob {
  config: ScheduledJobConfig;
  sourceFile: string;
  nextRun: Date | null;
  lastRun: Date | null;
  lastSuccess: Date | null;
  consecutiveFailures: number;
}

/**
 * Result of a scheduled job execution
 */
export interface JobExecutionResult {
  jobId: string;
  jobName: string;
  sourceFile: string;
  startedAt: Date;
  completedAt: Date;
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
  duration: number; // ms
}

/**
 * Progress event types for streaming updates
 */
export type ProgressEventType =
  | "started"
  | "tool_use"
  | "tool_result"
  | "subagent_start"
  | "subagent_done"
  | "thinking"
  | "searching"
  | "completed";

/**
 * Progress event for real-time streaming
 */
export interface ProgressEvent {
  type: ProgressEventType;
  jobId: string;
  jobName: string;
  timestamp: Date;
  message: string;
  details?: {
    tool?: string;
    query?: string;
    duration?: number;
    success?: boolean;
  };
}

/**
 * Progress callback for streaming updates
 */
export type ProgressCallback = (event: ProgressEvent) => void;

/**
 * Schedule locations for loading
 */
export const SCHEDULE_LOCATIONS = [
  { path: "/Users/yj/work/schedule.json", lane: "work" as const },
  { path: "/Users/yj/life/schedule.json", lane: "life" as const },
  { path: "/Users/yj/memory/schedule.json", lane: "default" as const },
];

/**
 * Lane to cwd mapping
 */
export const LANE_CWD: Record<string, string> = {
  work: "/Users/yj/work",
  life: "/Users/yj/life",
  default: "/Users/yj",
};

/**
 * Default job timeout (10 minutes)
 */
export const DEFAULT_JOB_TIMEOUT = 600_000;
