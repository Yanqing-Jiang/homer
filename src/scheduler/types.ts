import { PATHS } from "../config/paths.js";
import { getRuntimePaths } from "../utils/runtime-paths.js";
import path from "path";
import type { NotificationIntent } from "../notifications/types.js";

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
  lane: "work" | "default" | "trading";
  enabled: boolean;
  timeout?: number; // ms, defaults to 600000 (10 min)
  model?: string; // e.g. "sonnet", "haiku", "opus" - defaults to sonnet
  executor?: "claude" | "codex" | "kimi" | "gemini" | "opencode" | "internal"; // defaults to claude; opencode = GLM-5.2 edit harness; internal for daemon handlers
  /**
   * Internal handler key. The listed keys ship with the daemon; any other value is
   * dispatched to the private overlay's handler table (see src/private-overlay.ts).
   */
  handler?: KnownInternalHandler | (string & {});
  contextFiles?: string[]; // files to load and inject as system prompt context
  streamProgress?: boolean; // stream tool usage to Telegram (default: false)
  notifyOnSuccess?: boolean; // defaults to true
  notifyOnFailure?: boolean; // defaults to true
  minOutputLength?: number; // if set, output shorter than this flips success→failure (guards against meta-comment-as-deliverable)
  emptyStateMarker?: string; // if output contains this substring, it's a legitimate empty-state success and bypasses the minOutputLength guard
  deep?: boolean; // Use Pro model for Gemini executor (skip Flash)
  failureTakeover?: boolean; // spawn Claude Code to diagnose+retry on failure (default: true)
  allowAutoFix?: boolean; // let takeover edit handler code on fix_and_retry (default: false)
  autoCompensate?: boolean; // allow health check to re-trigger if overdue (default: false)
  triggers?: string[]; // downstream job IDs to trigger on success
}

/**
 * Registered job with runtime metadata
 */
export type KnownInternalHandler =
  | "bookmark_ingest" | "session_harvester" | "memory_embeddings" | "memory_reindex" | "weekly_consolidation"
  | "ideas_explore" | "nightly_memory" | "morning_review" | "nightly_code_push" | "db_backup" | "document_ingest"
  | "outcome_tracker" | "preference_updater" | "content_scraper" | "archive_verify" | "health_check"
  | "architecture_updater" | "daemon_cleanup" | "session_maintenance" | "reminder_check" | "link_processor"
  | "telegram_registry_cleanup" | "docker_restart" | "youtube_channel_watch";

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
  notificationIntent?: NotificationIntent;
  sideEffectDelivered?: boolean;
  /**
   * Third disposition beside success and failure. `deferred` means the job did not run
   * to completion because a resource it needs was held; nothing is broken and nothing
   * was produced. The scheduler records it as its own outcome and arms a one-shot
   * re-fire at `retryAt`; it does not touch last_success_at or the failure counters,
   * does not fire success dependencies, and does not enter failure takeover.
   * Absent means "classify by `success`", which is every job except the first deferring producer today.
   *
   * `halted` is the fourth: the job refused to start work (a ceiling it enforces itself was
   * reached, or it failed closed on state it will not trust). It is a failure for run history
   * and notification, but NOT for the circuit breaker: the producer's own ceilings already
   * stopped it, and a second uncoordinated stop (`consecutive_failures`) disabling the job
   * would leave its armed retries inert and the next cadence unfired. Never touches
   * `consecutive_failures`, never enters failure takeover.
   */
  outcome?: "deferred" | "halted";
  /** ISO instant for the scheduler-owned one-shot re-fire. Required when outcome is "deferred". */
  retryAt?: string;
  /** Machine-actionable reason recorded beside the retry (e.g. `browser_leased:...`). */
  retryReason?: string;
  /**
   * This fire opened a new unit of work (for a weekly portal pull: a fresh cadence slot), so failures before
   * it belong to an earlier unit. A failure carrying this starts the streak at 1 instead of
   * incrementing it; a deferral/halt carrying it resets the streak to 0. Without it three
   * failed attempts one week plus the first failure of the next disabled the job at the
   * breaker's threshold of five, and the third week's cron never fired.
   */
  resetFailureStreak?: boolean;
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
const runtimePaths = getRuntimePaths();
const WORK_ROOT = process.env.WORK_ROOT ?? path.join(runtimePaths.homeDir, "work");
const TRADING_ROOT = process.env.TRADING_CWD ?? path.join(runtimePaths.homeDir, "trading");

export const SCHEDULE_LOCATIONS = [
  { path: process.env.WORK_SCHEDULE_FILE ?? path.join(WORK_ROOT, "schedule.json"), lane: "work" as const },
  { path: PATHS.schedule, lane: "default" as const },
  ...(process.env.TRADING_SCHEDULE_ENABLED === "1"
    ? [{
        path: process.env.TRADING_SCHEDULE_FILE ?? path.join(TRADING_ROOT, "config", "schedule.json"),
        lane: "trading" as const,
      }]
    : []),
];

/**
 * Lane to cwd mapping
 */
export const LANE_CWD: Record<string, string> = {
  work: WORK_ROOT,
  default: runtimePaths.homeDir,
  trading: TRADING_ROOT,
};

/**
 * Default job timeout (20 minutes)
 */
export const DEFAULT_JOB_TIMEOUT = 1_200_000;
