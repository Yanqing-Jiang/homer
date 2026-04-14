/**
 * Single Job Registry — SSoT (Phase 0.8)
 *
 * Three sources currently describe the scheduler universe:
 *   1. `~/memory/schedule.json`         — cron entries
 *   2. `src/scheduler/jobs/*.ts`         — handler files
 *   3. `src/scheduler/internal-handlers.ts` — switch/case on handler name
 *
 * They drift. This module declares one authoritative registry and validates it
 * against the three sources at daemon startup. On mismatch we emit a structured
 * warning so the drift is visible instead of silent.
 *
 * We deliberately WARN rather than THROW for now. Throwing would refuse to start
 * a daemon that has been happily running for months; the value of this module is
 * surfacing drift, not enforcing perfection on first run.
 */

import { readdirSync } from "fs";
import { resolve } from "path";
import { logger } from "../utils/logger.js";

// ── Entry types ─────────────────────────────────────────────

export type JobKind =
  | "internal"  // dispatched via internal-handlers.ts switch/case
  | "cli"       // dispatched via executor.ts (claude/kimi/codex/gemini/bash)
  | "event"     // fired via event-bus / dependency trigger, not cron
  | "helper";   // code module only — NOT a scheduled job (artifact-store etc.)

export interface JobEntry {
  /** canonical id (kebab-case). Matches schedule.json `id` when scheduled. */
  id: string;
  /** short human label */
  name: string;
  /** classification */
  kind: JobKind;
  /**
   * If kind === "internal", this is the underscore-form handler key used in
   * the switch/case of internal-handlers.ts. If kind === "cli", this is the
   * executor kind. If kind === "helper" or "event", leave empty.
   */
  handler?: string;
  /**
   * Handler file in src/scheduler/jobs/ (without `.ts`). Only set if a file
   * backs this job. Many internal-handlers cases are inline and have no file.
   */
  handlerFile?: string;
  /** Whether this job is expected to be present in schedule.json */
  expectedInSchedule: boolean;
  /** Short free-text note explaining quirks (aliasing, disabled rationale, etc.) */
  note?: string;
}

// ── Registry ─────────────────────────────────────────────────

/**
 * Jobs that have both a scheduled entry AND a handler file in jobs/.
 * Handler file name is derived from id unless noted.
 */
const SCHEDULED_WITH_HANDLER_FILE: JobEntry[] = [
  { id: "archive-verify", name: "Archive Verify", kind: "internal", handler: "archive_verify", handlerFile: "archive-verify", expectedInSchedule: true },
  { id: "content-scraper", name: "Content Scraper", kind: "internal", handler: "content_scraper", handlerFile: "content-scraper", expectedInSchedule: true },
  { id: "db-backup", name: "DB Backup", kind: "internal", handler: "db_backup", handlerFile: "db-backup", expectedInSchedule: true },
  { id: "harness-auto-improve", name: "Harness Auto-Improve", kind: "internal", handler: "harness_auto_improve", handlerFile: "harness-auto-improve", expectedInSchedule: true, note: "disabled — pending merge with homer-improvements (Phase 4.1)" },
  { id: "homer-improvements", name: "Homer Improvements", kind: "internal", handler: "homer_improvements", handlerFile: "homer-improvements", expectedInSchedule: true, note: "disabled — pending merge with harness-auto-improve (Phase 4.1)" },
  { id: "idea-synthesizer", name: "Idea Synthesizer", kind: "internal", handler: "idea_synthesizer", handlerFile: "idea-synthesizer", expectedInSchedule: true },
  { id: "ideas-explore", name: "Ideas Explore", kind: "internal", handler: "ideas_explore", handlerFile: "ideas-explore", expectedInSchedule: true },
  { id: "job-hunt-discover", name: "Job Hunt Discover", kind: "internal", handler: "job_hunt_discover", handlerFile: "job-hunt-discover", expectedInSchedule: true },
  { id: "job-hunt-email-monitor", name: "Job Hunt Email Monitor", kind: "internal", handler: "job_hunt_email_monitor", handlerFile: "job-hunt-email-monitor", expectedInSchedule: true },
  { id: "job-hunt-followup", name: "Job Hunt Followup", kind: "internal", handler: "job_hunt_followup", handlerFile: "job-hunt-followup", expectedInSchedule: true },
  { id: "learning-engine", name: "Learning Engine", kind: "internal", handler: "learning_engine", handlerFile: "learning-engine", expectedInSchedule: true, note: "disabled — will merge into weekly-consolidation (Phase 4)" },
  { id: "link-processor", name: "Link Processor", kind: "internal", handler: "link_processor", handlerFile: "link-processor", expectedInSchedule: true },
  { id: "memory-embeddings", name: "Memory Embeddings", kind: "internal", handler: "memory_embeddings", handlerFile: "memory-embeddings", expectedInSchedule: true, note: "event-triggered; cron is safety net" },
  { id: "memory-reindex", name: "Memory Reindex", kind: "internal", handler: "memory_reindex", handlerFile: "memory-reindex", expectedInSchedule: true, note: "event-triggered; cron is safety net" },
  { id: "nightly-code-push", name: "Nightly Code Push", kind: "internal", handler: "nightly_code_push", handlerFile: "nightly-code-push", expectedInSchedule: true, note: "to become preview-before-act in Phase 1.4" },
  { id: "nightly-memory", name: "Nightly Memory", kind: "internal", handler: "nightly_memory", handlerFile: "nightly-memory", expectedInSchedule: true },
  { id: "outcome-tracker", name: "Outcome Tracker", kind: "internal", handler: "outcome_tracker", handlerFile: "outcome-tracker", expectedInSchedule: true },
  { id: "overnight-youtube", name: "Overnight YouTube", kind: "internal", handler: "overnight_youtube", handlerFile: "overnight-youtube", expectedInSchedule: true },
  { id: "planning-reminder", name: "Planning Reminder", kind: "internal", handler: "planning_reminder", handlerFile: "planning-reminder", expectedInSchedule: true, note: "to retire in Phase 4 — morning-review subsumes" },
  { id: "session-harvester", name: "Session Harvester", kind: "internal", handler: "session_harvester", handlerFile: "session-harvester", expectedInSchedule: true },
];

/**
 * Scheduled jobs whose IDs ALIAS a handler file with a different name.
 * These are the sources of taxonomy drift Codex's review flagged.
 */
const SCHEDULED_WITH_ALIASED_HANDLER_FILE: JobEntry[] = [
  { id: "context-bridge-refresh", name: "Context Bridge Refresh", kind: "internal", handler: "context_bridge", handlerFile: "context-bridge", expectedInSchedule: true, note: "alias: schedule id is context-bridge-refresh, file is context-bridge" },
  { id: "job-hunt-weekly-report", name: "Job Hunt Weekly Report", kind: "internal", handler: "job_hunt_weekly_report", handlerFile: "job-hunt-report", expectedInSchedule: true, note: "alias: schedule id is job-hunt-weekly-report, file is job-hunt-report" },
  { id: "weekly-memory-cleanup", name: "Weekly Memory Cleanup", kind: "internal", handler: "memory_cleanup", handlerFile: "memory-cleanup", expectedInSchedule: true, note: "alias + disabled — will merge into weekly-memory-maintenance (Phase 4)" },
  { id: "weekly-memory-consolidation", name: "Weekly Memory Consolidation", kind: "internal", handler: "weekly_consolidation", handlerFile: "weekly-consolidation", expectedInSchedule: true, note: "alias: schedule id prefixes 'weekly-memory-'" },
];

/**
 * Scheduled jobs implemented inline in internal-handlers.ts — no separate file.
 */
const SCHEDULED_INLINE_ONLY: JobEntry[] = [
  { id: "candidate-expiry", name: "Candidate Expiry", kind: "internal", handler: "candidate_expiry", expectedInSchedule: false, note: "inline helper triggered by other jobs" },
  { id: "daemon-cleanup", name: "Daemon Cleanup", kind: "internal", handler: "daemon_cleanup", expectedInSchedule: true },
  { id: "daily-ideas-review", name: "Daily Ideas Review", kind: "internal", handler: "ideas_review", expectedInSchedule: true, note: "disabled" },
  { id: "health-check", name: "Health Check", kind: "internal", handler: "health_check", expectedInSchedule: true },
  { id: "idea-dedup", name: "Idea Dedup", kind: "internal", handler: "idea_dedup", expectedInSchedule: true },
  { id: "idea-ingest", name: "Idea Ingest", kind: "internal", handler: "idea_ingest", expectedInSchedule: true },
  { id: "job-hunt-daily-approval", name: "Job Hunt Daily Approval", kind: "internal", handler: "job_hunt_daily_approval", expectedInSchedule: true, note: "disabled" },
  { id: "job-hunt-stalled-check", name: "Job Hunt Stalled Check", kind: "internal", handler: "job_hunt_stalled_check", expectedInSchedule: true, note: "disabled" },
  { id: "morning-review", name: "Morning Review", kind: "internal", handler: "morning_review", expectedInSchedule: true },
  { id: "overnight-review", name: "Overnight Review", kind: "internal", handler: "overnight_review", expectedInSchedule: true, note: "disabled" },
  { id: "reminder-check", name: "Reminder Check", kind: "internal", handler: "reminder_check", expectedInSchedule: true },
  { id: "session-maintenance", name: "Session Maintenance", kind: "internal", handler: "session_maintenance", expectedInSchedule: true },
  { id: "weekly-memory-audit", name: "Weekly Memory Audit", kind: "internal", handler: "weekly_memory_audit", expectedInSchedule: true },
];

/**
 * Jobs dispatched via external CLI (no internal handler needed).
 */
const SCHEDULED_CLI_JOBS: JobEntry[] = [
  { id: "morning-brief", name: "Morning Brief", kind: "cli", handler: "claude", expectedInSchedule: true },
  { id: "trading-service-start", name: "Trading Service Start", kind: "cli", handler: "bash", expectedInSchedule: true, note: "disabled" },
  { id: "trading-service-stop", name: "Trading Service Stop", kind: "cli", handler: "bash", expectedInSchedule: true, note: "disabled" },
  { id: "trading-fast-signals", name: "Trading Fast Signals", kind: "cli", handler: "bash", expectedInSchedule: true, note: "disabled" },
  { id: "trading-slow-signals", name: "Trading Slow Signals", kind: "cli", handler: "bash", expectedInSchedule: true, note: "disabled" },
  { id: "trading-daily-summary", name: "Trading Daily Summary", kind: "cli", handler: "claude", expectedInSchedule: true, note: "disabled" },
];

/**
 * Handler files that exist but are NOT directly scheduled.
 * Either event-triggered, callable via internal-handlers as a routine, or pending wiring.
 */
const UNSCHEDULED_HANDLER_FILES: JobEntry[] = [
  { id: "architecture-updater", name: "Architecture Updater", kind: "event", handler: "architecture_updater", handlerFile: "architecture-updater", expectedInSchedule: false, note: "event-triggered by commits/diffs" },
  { id: "decision-journal", name: "Decision Journal", kind: "event", handler: "decision_journal", handlerFile: "decision-journal", expectedInSchedule: false, note: "event-triggered from session-summaries" },
  { id: "memory-git-commit", name: "Memory Git Commit", kind: "event", handler: "memory_git_commit", handlerFile: "memory-git-commit", expectedInSchedule: false, note: "disabled by rule (see handler); retire in Phase 4" },
  { id: "preference-updater", name: "Preference Updater", kind: "event", handler: "preference_updater", handlerFile: "preference-updater", expectedInSchedule: false, note: "event-triggered from nightly-memory" },
  { id: "session-summaries", name: "Session Summaries", kind: "event", handler: "session_summaries", handlerFile: "session-summaries", expectedInSchedule: false, note: "event-triggered from session-harvester" },
  { id: "artifact-store", name: "Artifact Store (helper)", kind: "helper", handlerFile: "artifact-store", expectedInSchedule: false, note: "helper module, NOT a job — retire from portfolio vocabulary in Phase 4" },
];

export const JOB_REGISTRY: readonly JobEntry[] = Object.freeze([
  ...SCHEDULED_WITH_HANDLER_FILE,
  ...SCHEDULED_WITH_ALIASED_HANDLER_FILE,
  ...SCHEDULED_INLINE_ONLY,
  ...SCHEDULED_CLI_JOBS,
  ...UNSCHEDULED_HANDLER_FILES,
]);

// ── Lookup helpers ──────────────────────────────────────────

export function getJobEntry(id: string): JobEntry | undefined {
  return JOB_REGISTRY.find((e) => e.id === id);
}

export function getJobEntryByHandler(handler: string): JobEntry | undefined {
  return JOB_REGISTRY.find((e) => e.handler === handler);
}

// ── Validation ──────────────────────────────────────────────

export interface RegistryDriftReport {
  clean: boolean;
  scheduledNotInRegistry: string[];
  registryExpectedInScheduleButMissing: string[];
  handlerFilesNotInRegistry: string[];
  registryReferencesMissingHandlerFile: string[];
}

/**
 * Validate against the union of all scheduled job IDs the scheduler actually
 * loaded at runtime (across every SCHEDULE_LOCATIONS source), rather than
 * re-reading just `~/memory/schedule.json`. Callers pass the loaded job IDs
 * so this always sees the same universe the live scheduler sees.
 */
export function validateRegistry(opts: {
  loadedScheduledIds: string[];
  jobsDir: string;
}): RegistryDriftReport {
  const report: RegistryDriftReport = {
    clean: true,
    scheduledNotInRegistry: [],
    registryExpectedInScheduleButMissing: [],
    handlerFilesNotInRegistry: [],
    registryReferencesMissingHandlerFile: [],
  };

  const scheduleIds = new Set(opts.loadedScheduledIds);

  // Pull handler files from jobs dir
  let handlerFiles: Set<string> = new Set();
  try {
    for (const f of readdirSync(opts.jobsDir)) {
      if (f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith(".")) {
        handlerFiles.add(f.replace(/\.ts$/, ""));
      }
    }
  } catch (err) {
    logger.warn({ err, path: opts.jobsDir }, "Registry validator: could not list jobs dir");
  }

  const registryIds = new Set(JOB_REGISTRY.map((e) => e.id));
  const registryHandlerFiles = new Set(
    JOB_REGISTRY.map((e) => e.handlerFile).filter((f): f is string => Boolean(f))
  );

  // Drift detection
  for (const id of scheduleIds) {
    if (!registryIds.has(id)) report.scheduledNotInRegistry.push(id);
  }
  for (const entry of JOB_REGISTRY) {
    if (entry.expectedInSchedule && !scheduleIds.has(entry.id)) {
      report.registryExpectedInScheduleButMissing.push(entry.id);
    }
    if (entry.handlerFile && !handlerFiles.has(entry.handlerFile)) {
      report.registryReferencesMissingHandlerFile.push(
        `${entry.id} -> jobs/${entry.handlerFile}.ts`
      );
    }
  }
  for (const file of handlerFiles) {
    if (!registryHandlerFiles.has(file)) report.handlerFilesNotInRegistry.push(file);
  }

  report.clean =
    report.scheduledNotInRegistry.length === 0 &&
    report.registryExpectedInScheduleButMissing.length === 0 &&
    report.handlerFilesNotInRegistry.length === 0 &&
    report.registryReferencesMissingHandlerFile.length === 0;

  return report;
}

/**
 * Call at daemon startup with the list of job IDs the scheduler actually loaded
 * (across all SCHEDULE_LOCATIONS). Fatal cases THROW; cosmetic drift warns.
 *
 * Fatal: a handler file referenced by the registry is missing on disk, OR a
 * registry entry's handlerFile is referenced but the file doesn't exist.
 * (These are always bugs; bootprofile shouldn't proceed.)
 *
 * Warn-only: scheduledNotInRegistry, registryExpectedInScheduleButMissing,
 * handlerFilesNotInRegistry (unknown handler files can be helpers, WIP, or
 * event-only; warn is the right level until the plan is tighter).
 */
export function validateAndLogRegistry(opts: {
  loadedScheduledIds: string[];
  jobsDir?: string;
}): RegistryDriftReport {
  const runtimeJobsDir =
    opts.jobsDir ?? resolve(import.meta.dirname ?? process.cwd(), "jobs");

  const report = validateRegistry({
    loadedScheduledIds: opts.loadedScheduledIds,
    jobsDir: runtimeJobsDir,
  });

  if (report.clean) {
    logger.info({ entryCount: JOB_REGISTRY.length }, "Job registry validated — no drift");
    return report;
  }

  // Fatal: a registry entry points at a handler file that doesn't exist.
  if (report.registryReferencesMissingHandlerFile.length > 0) {
    logger.fatal(
      { missingFiles: report.registryReferencesMissingHandlerFile },
      "Job registry points at nonexistent handler files — refusing to start"
    );
    throw new Error(
      `Job registry drift (fatal): registry references missing handler files: ${report.registryReferencesMissingHandlerFile.join(", ")}`
    );
  }

  // Everything else: warn loudly but continue.
  logger.warn(
    {
      scheduledNotInRegistry: report.scheduledNotInRegistry,
      registryExpectedInScheduleButMissing: report.registryExpectedInScheduleButMissing,
      handlerFilesNotInRegistry: report.handlerFilesNotInRegistry,
    },
    "Job registry drift detected (non-fatal)"
  );

  return report;
}
