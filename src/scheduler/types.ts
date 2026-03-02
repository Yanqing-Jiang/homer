import { PATHS } from "../config/paths.js";

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
  lane: "work" | "life" | "default" | "trading";
  enabled: boolean;
  timeout?: number; // ms, defaults to 600000 (10 min)
  model?: string; // e.g. "sonnet", "haiku", "opus" - defaults to sonnet
  executor?: "claude" | "kimi" | "gemini" | "internal"; // defaults to claude; internal for daemon handlers
  handler?: "ideas_review" | "night_supervisor" | "overnight_review" | "idea_ingest" | "idea_dedup" | "session_summaries" | "session_harvester" | "memory_embeddings" | "memory_reindex" | "weekly_consolidation" | "memory_cleanup" | "ideas_explore" | "nightly_memory" | "homer_improvements" | "learning_engine" | "planning_reminder" | "job_hunt_discover" | "job_hunt_daily_approval" | "job_hunt_weekly_report" | "job_hunt_email_monitor" | "job_hunt_followup" | "job_hunt_stalled_check" | "memory_git_commit" | "nightly_code_push" | "db_backup" | "outcome_tracker" | "preference_updater" | "content_scraper" | "idea_synthesizer" | "archive_verify" | "health_check";
  contextFiles?: string[]; // files to load and inject as system prompt context
  streamProgress?: boolean; // stream tool usage to Telegram (default: false)
  notifyOnSuccess?: boolean; // defaults to true
  notifyOnFailure?: boolean; // defaults to true
  failureTakeover?: boolean; // spawn Claude Code to diagnose+retry on failure (default: true)
  allowAutoFix?: boolean; // let takeover edit handler code on fix_and_retry (default: false)
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
  executorUsed?: string;
  fallbackUsed?: boolean;
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
  { path: PATHS.schedule, lane: "default" as const },
  ...(process.env.TRADING_SCHEDULE_ENABLED === "1"
    ? [{
        path: process.env.TRADING_SCHEDULE_FILE ?? "/Users/yj/trading/config/schedule.json",
        lane: "trading" as const,
      }]
    : []),
];

/**
 * Lane to cwd mapping
 */
export const LANE_CWD: Record<string, string> = {
  work: "/Users/yj/work",
  life: "/Users/yj/life",
  default: "/Users/yj",
  trading: process.env.TRADING_CWD ?? "/Users/yj/trading",
};

/**
 * Default job timeout (10 minutes)
 */
export const DEFAULT_JOB_TIMEOUT = 600_000;
