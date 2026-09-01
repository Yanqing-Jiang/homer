/**
 * Single Job Registry — SSoT (Phase 0.8)
 *
 * Three sources currently describe the scheduler universe:
 *   1. `~/memory/schedule.json`         — cron entries
 *   2. `src/scheduler/jobs/*.ts`         — handler files
 *   3. `src/scheduler/internal-handlers.ts` — switch/case on handler name
 *
 * A private overlay (src/private-overlay.ts) may contribute further entries
 * through its manifest; they are merged into JOB_REGISTRY below and their
 * handler files are expected under src/private/scheduler/jobs/.
 *
 * They drift. This module declares one authoritative registry and validates it
 * against the three sources at daemon startup. On mismatch we emit a structured
 * warning so the drift is visible instead of silent.
 *
 * We deliberately WARN rather than THROW for now. Throwing would refuse to start
 * a daemon that has been happily running for months; the value of this module is
 * surfacing drift, not enforcing perfection on first run.
 */

import { existsSync, readdirSync } from "fs";
import { resolve } from "path";
import { logger } from "../utils/logger.js";
import { getPrivateOverlay } from "../private-overlay.js";

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
  /** Source file (relative to the repo root) for failure-takeover diagnostics. */
  sourceFile?: string;
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
  { id: "document-ingest", name: "Document Ingest", kind: "internal", handler: "document_ingest", handlerFile: "document-ingest", expectedInSchedule: true, note: "every 15 min; also called inline at the start of link-processor" },
  { id: "ideas-explore", name: "Ideas Explore", kind: "internal", handler: "ideas_explore", handlerFile: "ideas-explore", expectedInSchedule: true },
  { id: "link-processor", name: "Link Processor", kind: "internal", handler: "link_processor", handlerFile: "link-processor", expectedInSchedule: true },
  { id: "memory-embeddings", name: "Memory Embeddings", kind: "internal", handler: "memory_embeddings", handlerFile: "memory-embeddings", expectedInSchedule: true, note: "event-triggered; cron is safety net" },
  { id: "memory-reindex", name: "Memory Search Reindex", kind: "internal", handler: "memory_reindex", handlerFile: "memory-reindex", expectedInSchedule: true, note: "DB documents + allow-listed files; event-triggered, cron is safety net" },
  { id: "nightly-code-push", name: "Nightly Code Push", kind: "internal", handler: "nightly_code_push", handlerFile: "nightly-code-push", expectedInSchedule: true, note: "preview-before-act (Phase 1.4)" },
  { id: "nightly-memory", name: "Nightly Memory", kind: "internal", handler: "nightly_memory", handlerFile: "nightly-memory", expectedInSchedule: true },
  { id: "outcome-tracker", name: "Outcome Tracker", kind: "internal", handler: "outcome_tracker", handlerFile: "outcome-tracker", expectedInSchedule: true },
  { id: "session-harvester", name: "Session Harvester", kind: "internal", handler: "session_harvester", handlerFile: "session-harvester", expectedInSchedule: true },
  { id: "telegram-registry-cleanup", name: "Telegram Registry Cleanup", kind: "internal", handler: "telegram_registry_cleanup", handlerFile: "telegram-registry-cleanup", expectedInSchedule: true, note: "prunes expired rows from telegram_messages replyable registry" },
];

/**
 * Scheduled jobs whose IDs ALIAS a handler file with a different name.
 * These are the sources of taxonomy drift Codex's review flagged.
 */
const SCHEDULED_WITH_ALIASED_HANDLER_FILE: JobEntry[] = [
  { id: "weekly-memory-consolidation", name: "Weekly Memory Synthesis", kind: "internal", handler: "weekly_consolidation", handlerFile: "weekly-consolidation", expectedInSchedule: true, note: "retains narrative + passive cross-day claims; lint is advisory-only" },
];

/**
 * Scheduled jobs implemented inline in internal-handlers.ts — no separate file.
 */
const SCHEDULED_INLINE_ONLY: JobEntry[] = [
  { id: "daemon-cleanup", name: "Daemon Cleanup", kind: "internal", handler: "daemon_cleanup", expectedInSchedule: true },
  { id: "docker-restart-weekly", name: "Weekly Docker Desktop Restart", kind: "internal", handler: "docker_restart", expectedInSchedule: true, note: "Tue 5 AM — restarts Docker Desktop, then compose-up HOMER_DOCKER_COMPOSE_DIR (when set) and waits for HOMER_DOCKER_HEALTH_URL" },
  { id: "health-check", name: "Health Check", kind: "internal", handler: "health_check", expectedInSchedule: true },
  { id: "bookmark-ingest", name: "Bookmark Ingest", kind: "internal", handler: "bookmark_ingest", expectedInSchedule: true },
  { id: "morning-review", name: "Morning Review", kind: "internal", handler: "morning_review", expectedInSchedule: true },
  { id: "reminder-check", name: "Reminder Check", kind: "internal", handler: "reminder_check", expectedInSchedule: true },
  { id: "session-maintenance", name: "Session Maintenance", kind: "internal", handler: "session_maintenance", expectedInSchedule: true },
];

/**
 * Jobs dispatched via external CLI (no internal handler needed).
 */
const SCHEDULED_CLI_JOBS: JobEntry[] = [
  { id: "morning-brief", name: "Morning Brief", kind: "cli", handler: "claude", expectedInSchedule: true },
  { id: "morning-reads", name: "Morning Reads", kind: "cli", handler: "claude", expectedInSchedule: true },
  { id: "home-cleanup", name: "Home Cleanup", kind: "cli", handler: "claude", expectedInSchedule: true },
];

/**
 * Handler files that exist but are NOT directly scheduled.
 * Either event-triggered, callable via internal-handlers as a routine, or pending wiring.
 */
const UNSCHEDULED_HANDLER_FILES: JobEntry[] = [
  { id: "architecture-updater", name: "Architecture Updater", kind: "event", handler: "architecture_updater", handlerFile: "architecture-updater", expectedInSchedule: false, note: "event-triggered by commits/diffs" },
  { id: "preference-updater", name: "Preference Updater", kind: "event", handler: "preference_updater", handlerFile: "preference-updater", expectedInSchedule: false, note: "event-triggered from nightly-memory" },
  { id: "artifact-store", name: "Artifact Store (helper)", kind: "helper", handlerFile: "artifact-store", expectedInSchedule: false, note: "helper module, NOT a job — retire from portfolio vocabulary in Phase 4" },
];

/** Entries contributed by the private overlay manifest (empty without an overlay). */
function privateJobEntries(): JobEntry[] {
  return (getPrivateOverlay()?.manifest.jobs ?? []).map((entry) => ({ ...entry }));
}

export const JOB_REGISTRY: readonly JobEntry[] = Object.freeze([
  ...SCHEDULED_WITH_HANDLER_FILE,
  ...SCHEDULED_WITH_ALIASED_HANDLER_FILE,
  ...SCHEDULED_INLINE_ONLY,
  ...SCHEDULED_CLI_JOBS,
  ...UNSCHEDULED_HANDLER_FILES,
  ...privateJobEntries(),
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

  // Pull handler files from jobs dir. Accept `<name>.ts` (dev) or `<name>.js`
  // (prod — daemon runs from dist/scheduler/jobs/). Explicitly exclude
  // declaration files, source maps, tests, and dotfiles.
  // The private overlay's handler files sit beside ours under private/scheduler/jobs
  // (src/ or dist/ layout is identical), so scan that directory too when it exists.
  const privateJobsDir = resolve(opts.jobsDir, "..", "..", "private", "scheduler", "jobs");
  const jobsDirs = existsSync(privateJobsDir) ? [opts.jobsDir, privateJobsDir] : [opts.jobsDir];
  let handlerFiles: Set<string> = new Set();
  for (const dir of jobsDirs) {
    try {
      for (const f of readdirSync(dir)) {
        if (f.startsWith(".")) continue;
        if (f.endsWith(".d.ts") || f.endsWith(".d.ts.map") || f.endsWith(".js.map")) continue;
        if (f.endsWith(".test.ts") || f.endsWith(".test.js")) continue;
        if (f.endsWith(".ts")) handlerFiles.add(f.replace(/\.ts$/, ""));
        else if (f.endsWith(".js")) handlerFiles.add(f.replace(/\.js$/, ""));
      }
    } catch (err) {
      logger.warn({ err, path: dir }, "Registry validator: could not list jobs dir");
    }
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
