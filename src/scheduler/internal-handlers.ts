import type { Bot } from "grammy";
import type { RegisteredJob, JobExecutionResult } from "./types.js";
import { DEFAULT_JOB_TIMEOUT } from "./types.js";
import type { StateManager } from "../state/manager.js";
import { sendBatchIdeasForReview } from "../bot/handlers/approval.js";
import { NightSupervisor } from "../night/supervisor.js";
import { sendMilestoneNotification, presentOvernightSummaries } from "../bot/handlers/overnight.js";
import { ingestIdeasFromLegacy } from "../ideas/ingest.js";
import { dedupeIdeasDir } from "../ideas/dedup.js";
import { runSessionSummary } from "./jobs/session-summaries.js";
import { runWeeklyConsolidation } from "./jobs/weekly-consolidation.js";
import { runWeeklyMemoryCleanup } from "./jobs/memory-cleanup.js";
import { runMigrations } from "../state/migrations/index.js";
import { logger } from "../utils/logger.js";
import { CronUtils } from "../utils/cron.js";
import { getClaudeAuthStatus } from "../utils/claude-auth.js";
import { checkGeminiAPIHealth } from "../executors/gemini.js";
import { readFileSync, existsSync } from "fs";
import { createHash } from "crypto";

interface InternalJobContext {
  stateManager: StateManager;
  bot: Bot;
  chatId: number;
  jobRunId?: number;
}

interface HealthAlertState {
  active_fingerprint: string | null;
  active_issues: string | null;
  first_detected_at: string | null;
  last_sent_fingerprint: string | null;
  last_sent_at: string | null;
  send_failures: number;
  retry_after: string | null;
  last_recovery_sent_at: string | null;
}

const HEALTH_ALERT_REMINDER_MS = 6 * 60 * 60 * 1000; // 6h
const HEALTH_ALERT_RETRY_BASE_MS = 60 * 1000; // 1m
const HEALTH_ALERT_RETRY_MAX_MS = 30 * 60 * 1000; // 30m
const HEALTH_ALERT_SEND_ATTEMPTS = 2;

function toMillis(value: string | null | undefined): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function fingerprintIssues(issues: string[]): string {
  const normalized = [...issues]
    .map((item) => item.replace(/\s+/g, " ").trim())
    .sort()
    .join("\n");
  return createHash("sha256").update(normalized).digest("hex");
}

function ensureHealthAlertTable(db: ReturnType<StateManager["getDb"]>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS health_check_alert_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active_fingerprint TEXT,
      active_issues TEXT,
      first_detected_at TEXT,
      last_sent_fingerprint TEXT,
      last_sent_at TEXT,
      send_failures INTEGER NOT NULL DEFAULT 0,
      retry_after TEXT,
      last_recovery_sent_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function loadHealthAlertState(db: ReturnType<StateManager["getDb"]>): HealthAlertState {
  const row = db.prepare(`
    SELECT
      active_fingerprint,
      active_issues,
      first_detected_at,
      last_sent_fingerprint,
      last_sent_at,
      send_failures,
      retry_after,
      last_recovery_sent_at
    FROM health_check_alert_state
    WHERE id = 1
  `).get() as HealthAlertState | undefined;

  return row ?? {
    active_fingerprint: null,
    active_issues: null,
    first_detected_at: null,
    last_sent_fingerprint: null,
    last_sent_at: null,
    send_failures: 0,
    retry_after: null,
    last_recovery_sent_at: null,
  };
}

function saveHealthAlertState(db: ReturnType<StateManager["getDb"]>, state: HealthAlertState): void {
  db.prepare(`
    INSERT INTO health_check_alert_state (
      id,
      active_fingerprint,
      active_issues,
      first_detected_at,
      last_sent_fingerprint,
      last_sent_at,
      send_failures,
      retry_after,
      last_recovery_sent_at,
      updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      active_fingerprint = excluded.active_fingerprint,
      active_issues = excluded.active_issues,
      first_detected_at = excluded.first_detected_at,
      last_sent_fingerprint = excluded.last_sent_fingerprint,
      last_sent_at = excluded.last_sent_at,
      send_failures = excluded.send_failures,
      retry_after = excluded.retry_after,
      last_recovery_sent_at = excluded.last_recovery_sent_at,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    state.active_fingerprint,
    state.active_issues,
    state.first_detected_at,
    state.last_sent_fingerprint,
    state.last_sent_at,
    state.send_failures,
    state.retry_after,
    state.last_recovery_sent_at
  );
}

async function sendHealthMessage(ctx: InternalJobContext, message: string): Promise<boolean> {
  for (let attempt = 1; attempt <= HEALTH_ALERT_SEND_ATTEMPTS; attempt++) {
    try {
      await ctx.bot.api.sendMessage(ctx.chatId, message, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      return true;
    } catch (error) {
      logger.error({ error, attempt }, "Failed to send health check notification");
      if (attempt < HEALTH_ALERT_SEND_ATTEMPTS) {
        const waitMs = attempt * 2000;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }
  return false;
}

// Handlers safe to retry (idempotent, no user-facing side effects)
const RETRYABLE_HANDLERS = new Set([
  "ideas_explore", "nightly_memory", "session_harvester", "memory_embeddings", "memory_reindex",
  "learning_engine", "homer_improvements", "session_summaries", "weekly_consolidation",
  "memory_cleanup", "planning_reminder", "content_scraper", "outcome_tracker",
  "preference_updater", "idea_dedup", "memory_git_commit", "nightly_code_push", "db_backup",
  "idea_synthesizer", "archive_verify", "health_check",
]);

const TRANSIENT_PATTERNS = [
  "fetch failed", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND",
  "rate limit", "429", "503", "timeout", "socket hang up", "network", "EPIPE",
  "SQLITE_BUSY", "database is locked",
];

function isTransientError(error?: string): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return TRANSIENT_PATTERNS.some(p => lower.includes(p.toLowerCase()));
}

function buildResult(
  job: RegisteredJob,
  startedAt: Date,
  success: boolean,
  output: string,
  error?: string
): JobExecutionResult {
  const completedAt = new Date();
  return {
    jobId: job.config.id,
    jobName: job.config.name,
    sourceFile: job.sourceFile,
    startedAt,
    completedAt,
    success,
    output,
    error,
    exitCode: success ? 0 : 1,
    duration: completedAt.getTime() - startedAt.getTime(),
  };
}

function isJobHuntPaused(ctx: InternalJobContext): boolean {
  try {
    const row = ctx.stateManager.getDb().prepare(
      "SELECT state FROM circuit_breaker_state WHERE name = 'job_hunt_global'"
    ).get() as { state: string } | undefined;
    return row?.state === "open";
  } catch {
    return false;
  }
}

async function runHealthCheck(
  ctx: InternalJobContext
): Promise<{ success: boolean; output: string; error?: string }> {
  const now = Date.now();
  const db = ctx.stateManager.getDb();
  const issues: string[] = [];

  ensureHealthAlertTable(db);

  // Load all job configs from schedule files
  const { loadAllSchedules, getAllJobs } = await import("./loader.js");
  const schedules = await loadAllSchedules();
  const allJobs = getAllJobs(schedules);

  for (const jobConfig of allJobs) {
    if (!jobConfig.enabled) continue;
    const timeoutMs = jobConfig.timeout ?? DEFAULT_JOB_TIMEOUT;

    // Check stuck
    const runningRow = db.prepare(
      "SELECT is_running FROM scheduled_job_state WHERE job_id = ?"
    ).get(jobConfig.id) as { is_running: number } | undefined;

    if (runningRow?.is_running === 1) {
      const latestRun = ctx.stateManager.getRecentScheduledJobRuns(jobConfig.id, 1);
      if (latestRun.length > 0 && latestRun[0]!.startedAt) {
        const elapsed = now - new Date(latestRun[0]!.startedAt).getTime();
        if (elapsed > timeoutMs) {
          const mins = Math.round(elapsed / 60000);
          issues.push(`🔴 <b>${jobConfig.id}</b> stuck (running ${mins}m, timeout ${Math.round(timeoutMs / 60000)}m)`);
        }
      }
    }

    // Check consecutive failures
    const state = ctx.stateManager.getScheduledJobState(jobConfig.id);
    const failures = state?.consecutiveFailures ?? 0;
    if (failures >= 3) {
      issues.push(`🟡 <b>${jobConfig.id}</b> failing (${failures} consecutive failures)`);
    }

    // Check overdue (skip for running jobs to avoid false positives)
    if (!runningRow?.is_running) {
      const lastSuccessAt = state?.lastSuccessAt;
      if (lastSuccessAt) {
        const nextTwo = CronUtils.getNextRuns(jobConfig.cron, 2);
        if (nextTwo.length === 2) {
          const intervalMs = nextTwo[1]!.getTime() - nextTwo[0]!.getTime();
          if ((now - new Date(lastSuccessAt).getTime()) > intervalMs * 2) {
            issues.push(`🟡 <b>${jobConfig.id}</b> overdue (last success: ${lastSuccessAt})`);
          }
        }
      } else if (state?.lastRunAt) {
        // Never succeeded but has run — check if it's been too long
        const nextTwo = CronUtils.getNextRuns(jobConfig.cron, 2);
        if (nextTwo.length === 2) {
          const intervalMs = nextTwo[1]!.getTime() - nextTwo[0]!.getTime();
          if ((now - new Date(state.lastRunAt).getTime()) > intervalMs * 2) {
            issues.push(`🟡 <b>${jobConfig.id}</b> overdue (last run: ${state.lastRunAt}, never succeeded)`);
          }
        }
      }
    }
  }

  // Credential checks
  try {
    const gmailTokenPath = "/Users/yj/job-hunt/gmail/token.json";
    if (existsSync(gmailTokenPath)) {
      const tokenData = JSON.parse(readFileSync(gmailTokenPath, "utf-8"));
      if (!tokenData.refresh_token) {
        issues.push("🟡 Gmail: missing refresh_token");
      }
    } else {
      issues.push("🔴 Gmail: token file not found");
    }
  } catch {
    issues.push("🔴 Gmail: failed to read token");
  }

  const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!ghToken) {
    issues.push("🟡 GitHub: GH_TOKEN not set");
  }

  try {
    const claudeStatus = await getClaudeAuthStatus();
    if (!claudeStatus.keychainItemFound || !claudeStatus.claudeBinaryExists) {
      issues.push("🔴 Claude: auth/binary missing");
    }
  } catch {
    issues.push("🔴 Claude: auth check failed");
  }

  try {
    const geminiOk = await checkGeminiAPIHealth();
    if (!geminiOk) {
      issues.push("🔴 Gemini API: health check failed (flash3 / gemini-3-flash-preview)");
    }
  } catch {
    issues.push("🔴 Gemini API: health check threw");
  }

  if (issues.length === 0) {
    const state = loadHealthAlertState(db);
    let output = "All systems healthy";

    if (state.active_fingerprint) {
      const recovery = `✅ <b>Health Check</b>\n\nRecovered from previous alert:\n${state.active_issues ?? "Unknown issue"}`;
      const recoverySent = await sendHealthMessage(ctx, recovery);
      if (recoverySent) {
        output = "All systems healthy, recovery alert sent";
        state.last_recovery_sent_at = new Date(now).toISOString();
      } else {
        output = "All systems healthy, recovery alert FAILED to send";
      }
    }

    state.active_fingerprint = null;
    state.active_issues = null;
    state.first_detected_at = null;
    state.send_failures = 0;
    state.retry_after = null;
    saveHealthAlertState(db, state);

    return { success: true, output };
  }

  // Send alert — use bot.api directly so errors propagate (sendNotification swallows them)
  const hasCritical = issues.some(i => i.startsWith("🔴"));
  const statusEmoji = hasCritical ? "🚨" : "⚠️";
  const message = `${statusEmoji} <b>Health Check</b>\n\n${issues.join("\n")}`;
  const issueFingerprint = fingerprintIssues(issues);
  const state = loadHealthAlertState(db);
  const nowIso = new Date(now).toISOString();

  if (state.active_fingerprint !== issueFingerprint) {
    state.first_detected_at = nowIso;
  }
  state.active_fingerprint = issueFingerprint;
  state.active_issues = issues.join("\n");

  const lastSentMs = toMillis(state.last_sent_at);
  const retryAfterMs = toMillis(state.retry_after);
  const sameAsLastSent = state.last_sent_fingerprint === issueFingerprint;
  const reminderDue = lastSentMs === null || (now - lastSentMs) >= HEALTH_ALERT_REMINDER_MS;
  const retryDue = state.send_failures > 0 && (retryAfterMs === null || now >= retryAfterMs);
  const shouldSend = !sameAsLastSent || reminderDue || retryDue;

  if (!shouldSend) {
    saveHealthAlertState(db, state);
    return {
      success: true,
      output: `${issues.length} issue(s) found, duplicate alert suppressed`,
    };
  }

  const alertSent = await sendHealthMessage(ctx, message);
  if (alertSent) {
    state.last_sent_fingerprint = issueFingerprint;
    state.last_sent_at = nowIso;
    state.send_failures = 0;
    state.retry_after = null;
    saveHealthAlertState(db, state);
  } else {
    const failures = Math.max(0, state.send_failures) + 1;
    const delay = Math.min(HEALTH_ALERT_RETRY_BASE_MS * (2 ** (failures - 1)), HEALTH_ALERT_RETRY_MAX_MS);
    state.send_failures = failures;
    state.retry_after = new Date(now + delay).toISOString();
    saveHealthAlertState(db, state);
  }

  return {
    success: true,
    output: `${issues.length} issue(s) found${alertSent ? ", alert sent" : ", alert FAILED to send; retry scheduled"}`,
  };
}

async function runHandler(
  job: RegisteredJob,
  ctx: InternalJobContext,
  startedAt: Date
): Promise<JobExecutionResult> {
  try {
    switch (job.config.handler) {
      case "ideas_review": {
        const count = await sendBatchIdeasForReview(ctx.bot, ctx.chatId);
        return buildResult(
          job,
          startedAt,
          true,
          count > 0 ? `Sent ${count} ideas for review` : "No new ideas to review"
        );
      }
      case "night_supervisor": {
        const supervisor = new NightSupervisor({}, {
          db: ctx.stateManager.getDb(),
          jobRunId: ctx.jobRunId,
          onOvernightMilestone: async (chatId, milestone, message) => {
            await sendMilestoneNotification(ctx.bot, chatId, milestone, message);
          },
        });
        const session = await supervisor.run(false);
        const durationMin = (session.totalDuration / 1000 / 60).toFixed(1);
        const findingsSnippet = session.findings.length > 0
          ? "\n" + session.findings.slice(0, 10).join("\n")
          : "";
        const summary = `Night supervisor completed in ${durationMin}m. Jobs: ${session.jobsCompleted} ok, ${session.jobsFailed} failed.${findingsSnippet}`;
        const success = !(session.jobsCompleted === 0 && session.jobsFailed > 0);
        const error = !success ? `All ${session.jobsFailed} jobs failed` : undefined;
        return buildResult(job, startedAt, success, summary, error);
      }
      case "overnight_review": {
        const count = await presentOvernightSummaries(ctx.bot, ctx.stateManager, ctx.chatId);
        const output = count > 0
          ? `Presented ${count} overnight task summaries`
          : "No overnight tasks ready for review";
        return buildResult(job, startedAt, true, output);
      }
      case "idea_ingest": {
        const result = await ingestIdeasFromLegacy(ctx.stateManager.getDb());
        const parts: string[] = [];
        if (result.ingested > 0) {
          parts.push(`Ingested ${result.ingested} ideas`);
          if (result.fromTwitter > 0) parts.push(`${result.fromTwitter} from X`);
          if (result.enriched > 0) parts.push(`${result.enriched} enriched`);
        }
        if (result.archivedToDeny > 0) parts.push(`${result.archivedToDeny} archived to deny-history`);
        if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
        const output = parts.length > 0 ? parts.join(", ") : "No new ideas found";
        return buildResult(job, startedAt, true, output);
      }
      case "idea_dedup": {
        const result = await dedupeIdeasDir(ctx.stateManager.getDb(), ctx.jobRunId);
        const output = result.deleted > 0
          ? `Dedup complete: ${result.deleted} duplicates deleted, ${result.kept} ideas retained`
          : `No duplicates found (${result.kept} ideas checked)`;
        return buildResult(job, startedAt, true, output);
      }
      case "session_summaries": {
        const result = await runSessionSummary(undefined, ctx.stateManager);
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "weekly_consolidation": {
        const result = await runWeeklyConsolidation();
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "memory_cleanup": {
        const result = await runWeeklyMemoryCleanup(ctx.stateManager);
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "ideas_explore": {
        const { runIdeasExplore } = await import("./jobs/ideas-explore.js");
        const result = await runIdeasExplore(ctx.stateManager.getDb());
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "nightly_memory": {
        const { runNightlyMemory } = await import("./jobs/nightly-memory.js");
        const result = await runNightlyMemory(ctx.stateManager);
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "homer_improvements": {
        const { runHomerImprovements } = await import("./jobs/homer-improvements.js");
        const result = await runHomerImprovements(ctx.stateManager.getDb(), ctx.jobRunId);
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "learning_engine": {
        const { runLearningEngine } = await import("./jobs/learning-engine.js");
        const result = await runLearningEngine(ctx.stateManager.getDb(), ctx.jobRunId);
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "session_harvester": {
        const { runSessionHarvester } = await import("./jobs/session-harvester.js");
        const result = await runSessionHarvester(ctx.stateManager.getDb());
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "memory_embeddings": {
        const { runMemoryEmbeddings } = await import("./jobs/memory-embeddings.js");
        const result = await runMemoryEmbeddings();
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "memory_reindex": {
        const { runMemoryReindex } = await import("./jobs/memory-reindex.js");
        const result = await runMemoryReindex();
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "planning_reminder": {
        const { runPlanningReminder } = await import("./jobs/planning-reminder.js");
        const result = await runPlanningReminder();
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "job_hunt_discover": {
        const { runJobHuntDiscover } = await import("./jobs/job-hunt-discover.js");
        const result = await runJobHuntDiscover(ctx.stateManager.getDb());
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "job_hunt_daily_approval": {
        const { expireStaleApprovals, getHeldJobsToResurface } = await import("../bot/handlers/job-approval.js");
        const { processApprovalQueue } = await import("../job-hunt/apply-engine.js");
        const db = ctx.stateManager.getDb();

        // Expire stale approvals
        const expired = expireStaleApprovals(db);

        // Resurface held jobs
        const resurfaced = getHeldJobsToResurface(db).slice(0, 2);
        for (const held of resurfaced) {
          db.prepare("UPDATE approval_queue SET decision = 'pending', decided_at = NULL, telegram_message_id = NULL WHERE id = ?").run(held.queue_id);
        }

        // Auto-apply to queued jobs
        const applyResult = await processApprovalQueue(db, ctx.bot, ctx.chatId);

        const parts: string[] = [];
        if (applyResult.applied > 0) parts.push(`${applyResult.applied} applied`);
        if (applyResult.failed > 0) parts.push(`${applyResult.failed} failed`);
        if (applyResult.skipped > 0) parts.push(`${applyResult.skipped} escalated`);
        if (expired > 0) parts.push(`${expired} expired`);
        if (resurfaced.length > 0) parts.push(`${resurfaced.length} resurfaced from hold`);
        return buildResult(job, startedAt, true, parts.join(", ") || "No jobs pending in queue");
      }
      case "job_hunt_weekly_report": {
        const { runJobHuntWeeklyReport } = await import("./jobs/job-hunt-report.js");
        const result = await runJobHuntWeeklyReport(ctx.stateManager.getDb());
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "job_hunt_email_monitor": {
        const { runJobHuntEmailMonitor } = await import("./jobs/job-hunt-email-monitor.js");
        const result = await runJobHuntEmailMonitor(ctx.stateManager.getDb());
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "job_hunt_followup": {
        const { runJobHuntFollowup } = await import("./jobs/job-hunt-followup.js");
        const result = await runJobHuntFollowup(ctx.stateManager.getDb(), ctx.bot, ctx.chatId);
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "job_hunt_stalled_check": {
        const db = ctx.stateManager.getDb();
        const stalled = db.prepare(`
          SELECT a.id, a.job_id, jp.company, jp.title, a.status, a.updated_at
          FROM applications a JOIN job_postings jp ON a.job_id = jp.id
          WHERE a.status = 'applying' AND datetime(a.updated_at) < datetime('now', '-24 hours')
        `).all() as Array<{ id: string; job_id: string; company: string; title: string; status: string; updated_at: string }>;
        if (stalled.length > 0) {
          for (const app of stalled) {
            db.prepare("UPDATE applications SET status = 'stalled', updated_at = datetime('now') WHERE id = ?").run(app.id);
          }
          const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const lines = stalled.map(a => `${esc(a.company)} — ${esc(a.title)}`).join("\n");
          try {
            await ctx.bot.api.sendMessage(ctx.chatId, `⚠️ <b>Stalled Applications</b>\n\n${lines}\n\nThese were stuck in "applying" for 24h+ and have been flagged.`, { parse_mode: "HTML" });
          } catch { /* notification best-effort */ }
        }
        return buildResult(job, startedAt, true, stalled.length > 0 ? `${stalled.length} stalled applications flagged` : "No stalled applications");
      }
      case "outcome_tracker": {
        const { runOutcomeTracker } = await import("./jobs/outcome-tracker.js");
        const result = await runOutcomeTracker(ctx.stateManager.getDb(), ctx.bot, ctx.chatId);
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "preference_updater": {
        const { runPreferenceUpdater } = await import("./jobs/preference-updater.js");
        const result = await runPreferenceUpdater(ctx.stateManager.getDb());
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "memory_git_commit": {
        const { runMemoryGitCommit } = await import("./jobs/memory-git-commit.js");
        const result = await runMemoryGitCommit();
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "nightly_code_push": {
        const { runNightlyCodePush } = await import("./jobs/nightly-code-push.js");
        const result = await runNightlyCodePush();
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "db_backup": {
        const { runDbBackup } = await import("./jobs/db-backup.js");
        const result = await runDbBackup();
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "content_scraper": {
        const { runContentScraper } = await import("./jobs/content-scraper.js");
        const result = await runContentScraper(ctx.stateManager.getDb());
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "idea_synthesizer": {
        const { runIdeaSynthesizer } = await import("./jobs/idea-synthesizer.js");
        const result = await runIdeaSynthesizer(ctx.stateManager.getDb(), ctx.jobRunId);
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "archive_verify": {
        const { runArchiveVerify } = await import("./jobs/archive-verify.js");
        const result = await runArchiveVerify(ctx.stateManager.getDb());
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "health_check": {
        const result = await runHealthCheck(ctx);
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      default: {
        return buildResult(job, startedAt, false, "", `Unknown internal handler: ${job.config.handler}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return buildResult(job, startedAt, false, "", message);
  }
}

export async function executeInternalJob(
  job: RegisteredJob,
  ctx: InternalJobContext
): Promise<JobExecutionResult> {
  const startedAt = new Date();

  // Guard: apply any pending migrations before running job handlers.
  // Dynamic imports can load new code from disk mid-process, but migrations
  // only run at daemon startup. This prevents code/schema mismatch.
  try {
    runMigrations(ctx.stateManager.getDb());
  } catch (migErr) {
    logger.error({ error: migErr, jobId: job.config.id }, "Migration guard failed");
    return buildResult(job, startedAt, false, "", `Migration failed: ${migErr}`);
  }

  // Check global pause for job_hunt handlers
  if (job.config.handler?.startsWith("job_hunt_") && isJobHuntPaused(ctx)) {
    return buildResult(job, startedAt, true, "Skipped — job hunt is paused");
  }

  const result = await runHandler(job, ctx, startedAt);

  // Retry once for retryable handlers on transient errors
  const handler = job.config.handler ?? "";
  if (!result.success && RETRYABLE_HANDLERS.has(handler) && isTransientError(result.error)) {
    logger.warn({ jobId: job.config.id, error: result.error }, "Transient error detected, retrying in 10s");
    await new Promise(resolve => setTimeout(resolve, 10_000));

    const retryStartedAt = new Date();
    const retryResult = await runHandler(job, ctx, retryStartedAt);

    if (retryResult.success) {
      logger.info({ jobId: job.config.id }, "Retry succeeded");
    } else {
      logger.error({ jobId: job.config.id, error: retryResult.error }, "Retry also failed");
    }
    return retryResult;
  }

  return result;
}
