import type { Bot } from "grammy";
import type { RegisteredJob, JobExecutionResult } from "./types.js";
import { DEFAULT_JOB_TIMEOUT } from "./types.js";
import type { StateManager } from "../state/manager.js";
import { writeInternalTrace } from "../executors/trace-writer.js";
import { sendBatchIdeasForReview } from "../bot/handlers/approval.js";
import { ingestIdeasFromLegacy } from "../ideas/ingest.js";
import { expireStaleIdeas, expireStalePackets } from "../ideas/dedup.js";
import { runWeeklyConsolidation } from "./jobs/weekly-consolidation.js";
import { runMigrations } from "../state/migrations/index.js";
import { logger } from "../utils/logger.js";
import { CronUtils } from "../utils/cron.js";
import { loadAllSchedules, getAllJobs } from "./loader.js";
import { JOB_REGISTRY } from "./registry.js";
import { getClaudeAuthStatus } from "../utils/claude-auth.js";
import { buildInfoMatches, describeBuildInfo, getRuntimeBuildInfo, readDiskBuildInfo } from "../utils/build-info.js";
import { checkGeminiAPIHealth } from "../executors/gemini.js";
import {
  formatScheduledTelegramHtml,
  routeTelegramNotification,
  sendChunkedTelegramMessage,
} from "../notifications/telegram-router.js";
import type { NotificationIntent } from "../notifications/types.js";
import { createHash } from "crypto";
import { execFile } from "child_process";
import { promisify } from "node:util";
import path from "node:path";
import { getConnectivityMonitor } from "../heartbeat/index.js";
import { processRegistry } from "../process/registry.js";
import { cleanupScheduler } from "../process/cleanup-scheduler.js";
import { checkAndFlushExpiringSessions } from "../memory/flush.js";
import { config } from "../config/index.js";
import { runInternalJobHarness } from "./executor.js";

interface InternalJobContext {
  stateManager: StateManager;
  bot: Bot | null;
  chatId: number;
  jobRunId?: number;
  /** AbortSignal from the scheduler hang-watchdog. Pass to LLM calls and batch loops. */
  signal?: AbortSignal;
  /** Runtime disable: stops the cron task and persists to DB. Provided by Scheduler. */
  disableScheduledJob?: (jobId: string) => boolean;
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

interface BuildResultOptions {
  notificationIntent?: NotificationIntent;
  sideEffectDelivered?: boolean;
}

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

async function sendHealthMessage(
  ctx: InternalJobContext,
  message: string,
  options: { intent: NotificationIntent; sourceId: string }
): Promise<boolean> {
  const formattedMessage = formatScheduledTelegramHtml(message);
  const bot = ctx.bot;
  const result = await routeTelegramNotification({
    db: ctx.stateManager.getDb(),
    sourceType: "scheduler_job",
    sourceId: options.sourceId,
    jobRunId: ctx.jobRunId,
    intent: options.intent,
    title: "Health Check",
    messageText: formattedMessage,
    deliver: bot ? async () => {
      let lastError: unknown;

      for (let attempt = 1; attempt <= HEALTH_ALERT_SEND_ATTEMPTS; attempt++) {
        try {
          return await sendChunkedTelegramMessage({
            bot,
            chatId: ctx.chatId,
            message: formattedMessage,
            parseMode: "HTML",
            enableLinkPreview: false,
          });
        } catch (error) {
          lastError = error;
          logger.error({ error, attempt }, "Failed to send health check notification");
          if (attempt < HEALTH_ALERT_SEND_ATTEMPTS) {
            const waitMs = attempt * 2000;
            await new Promise((resolve) => setTimeout(resolve, waitMs));
          }
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new Error("Failed to send health check notification");
    } : undefined,
  });

  return result.decision === "sent";
}

// Handlers safe to retry (idempotent, no user-facing side effects)
const RETRYABLE_HANDLERS = new Set([
  "ideas_explore", "nightly_memory", "session_harvester", "memory_embeddings", "memory_reindex", "morning_review",
  "weekly_consolidation",
  "content_scraper", "outcome_tracker",
  "preference_updater", "idea_expiry", "nightly_code_push", "db_backup",
  "idea_synthesizer", "link_processor", "archive_verify", "health_check",
  "architecture_updater", "daemon_cleanup", "session_maintenance", "reminder_check",
  "candidate_expiry",
  "docker_restart",
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

function getHealthResultOptions(output: string): BuildResultOptions {
  if (output.includes("recovery alert sent")) {
    return {
      notificationIntent: "user_info",
      sideEffectDelivered: true,
    };
  }

  if (output.includes("alert sent")) {
    return {
      notificationIntent: "failure_alert",
      sideEffectDelivered: true,
    };
  }

  if (output.includes("FAILED to send")) {
    return {
      notificationIntent: "failure_alert",
    };
  }

  return {
    notificationIntent: "operational_status",
  };
}


function buildResult(
  job: RegisteredJob,
  startedAt: Date,
  success: boolean,
  output: string,
  error?: string,
  options: BuildResultOptions = {}
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
    notificationIntent: options.notificationIntent,
    sideEffectDelivered: options.sideEffectDelivered,
  };
}



async function runHealthCheck(
  ctx: InternalJobContext,
  job: RegisteredJob,
  startedAt: Date,
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
  // (Gmail credential check removed — job-hunt was archived/disabled and its
  // token path /Users/yj/job-hunt/gmail/token.json no longer exists.)
  const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!ghToken) {
    issues.push("🟡 GitHub: GH_TOKEN not set");
  }

  try {
    const claudeStatus = await getClaudeAuthStatus();
    if (!claudeStatus.claudeBinaryExists) {
      issues.push(`🔴 Claude: binary missing (${claudeStatus.claudePath})`);
    }
    if (!claudeStatus.authAvailable) {
      issues.push(`🔴 Claude: auth missing (no keychain item or token file at ${claudeStatus.tokenFilePath})`);
    }
  } catch {
    issues.push("🔴 Claude: auth check failed");
  }

  try {
    const gemini = await checkGeminiAPIHealth();
    // Mute transient 503/overload (degraded) — not actionable and not a key/auth fault.
    if (!gemini.ok && !gemini.degraded) {
      issues.push(`🔴 Gemini API: health check failed — ${gemini.detail}`);
    } else if (gemini.degraded) {
      logger.warn({ detail: gemini.detail }, "Gemini API degraded (transient overload) — alert muted");
    }
  } catch {
    issues.push("🔴 Gemini API: health check threw");
  }

  // Connectivity check (absorbed from standalone ConnectivityMonitor timer)
  try {
    const connectivityMonitor = getConnectivityMonitor();
    if (connectivityMonitor) {
      const statuses = await connectivityMonitor.checkAll();
      for (const status of statuses) {
        if (!status.healthy) {
          issues.push(`🔴 Connectivity: ${status.name} unreachable${status.error ? ` (${status.error})` : ""}`);
        }
      }
    }
  } catch (err) {
    logger.warn({ error: err }, "Connectivity check in health handler failed");
  }

  // Process monitoring: check for active process count and long-running processes
  try {
    const activeProcesses = processRegistry.getActive();
    if (activeProcesses.length > 5) {
      issues.push(`🟡 Process count high: ${activeProcesses.length} active processes`);
    }
    // chrome-cdp is the long-lived scraping browser; its lifecycle is owned by
    // cleanup-scheduler's idle-teardown reaper (which spares in-flight scrapes by
    // design), so the health monitor must not second-guess it. Also honor
    // extendedUntil, which triage sets to grant a process more time.
    const SELF_MANAGED_COMMANDS = new Set(["chrome-cdp"]);
    for (const proc of activeProcesses) {
      if (proc.settled) continue;
      if (SELF_MANAGED_COMMANDS.has(proc.command)) continue;
      if (proc.extendedUntil && now < proc.extendedUntil) continue;
      const ageMs = now - proc.spawnedAt;
      if (ageMs > 30 * 60 * 1000) {
        const ageMin = Math.round(ageMs / 60000);
        issues.push(`🟡 Long process: PID ${proc.pid} (${proc.command.slice(0, 50)}) running ${ageMin}m`);
      }
    }
  } catch (err) {
    logger.warn({ error: err }, "Process monitoring in health handler failed");
  }

  // In production Homer must remain a child of the resident supervisor. If the
  // parent dies macOS reparents Homer to PID 1, making supervisor loss visible.
  if (process.env.NODE_ENV === "production" &&
      (process.env.HOMER_SUPERVISED !== "1" || process.ppid === 1)) {
    issues.push("🔴 Homer is not owned by its supervisor");
  }

  // Build drift: a fresh dist exists but the running process is still on an old
  // build — a restart that failed, was bypassed, or never happened. The freshness
  // gate PREVENTS shipping stale src; this DETECTS a landed build that didn't
  // take. Detection only — never auto-restart from the health handler.
  try {
    const runtimeBuild = getRuntimeBuildInfo();
    const diskBuild = readDiskBuildInfo();
    if (runtimeBuild && diskBuild && !buildInfoMatches(runtimeBuild, diskBuild)) {
      issues.push(
        `🟡 Build drift: running ${describeBuildInfo(runtimeBuild)} but dist is ${describeBuildInfo(diskBuild)} — deploy required`,
      );
    }
  } catch (err) {
    logger.warn({ error: err }, "Build-drift check in health handler failed");
  }

  if (issues.length === 0) {
    const state = loadHealthAlertState(db);
    let output = "All systems healthy";

    if (state.active_fingerprint) {
      const recovery = `✅ <b>Health Check</b>\n\nRecovered from previous alert:\n${state.active_issues ?? "Unknown issue"}`;
      const recoverySent = await sendHealthMessage(ctx, recovery, {
        intent: "user_info",
        sourceId: "health_check:recovery",
      });
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

  const alertSent = await sendHealthMessage(ctx, message, {
    intent: "failure_alert",
    sourceId: `health_check:${issueFingerprint.slice(0, 16)}`,
  });
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

  // LLM triage for recurring health issues (circuit breaker: max 5 per day)
  let triageOutput = "";
  try {
    const triageCountRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM process_cleanup_runs WHERE trigger = 'health-triage' AND datetime(run_at) > datetime('now', '-24 hours')"
    ).get() as { cnt: number } | undefined;
    const triageCount = triageCountRow?.cnt ?? 0;

    // Only triage if: issues are critical, alert was sent, and under daily limit
    if (hasCritical && alertSent && triageCount < 5) {
      const triageResult = await runHealthLLMTriage(issues, ctx, job, startedAt);
      if (triageResult) {
        triageOutput = `, triage: ${triageResult.action}`;
        // Log triage to audit table
        db.prepare(
          `INSERT INTO process_cleanup_runs (trigger, processes_scanned, processes_killed, processes_spared, details)
           VALUES ('health-triage', ?, 0, 0, ?)`
        ).run(issues.length, JSON.stringify({ action: triageResult.action, reason: triageResult.reason, issues }));

        // Execute triage decision
        if (triageResult.action === "restart_job" && triageResult.jobId) {
          try {
            const resetStmt = db.prepare(
              "UPDATE scheduled_job_state SET is_running = 0, consecutive_failures = 0 WHERE job_id = ?"
            );
            resetStmt.run(triageResult.jobId);
            logger.info({ jobId: triageResult.jobId }, "Health triage: reset job state");
          } catch (resetErr) {
            logger.warn({ error: resetErr, jobId: triageResult.jobId }, "Health triage: failed to reset job");
          }
        } else if (triageResult.action === "disable_job" && triageResult.jobId) {
          try {
            // Use the runtime callback to stop the live cron task AND persist to DB
            const disabled = ctx.disableScheduledJob?.(triageResult.jobId) ?? false;
            if (!disabled) {
              // Fallback: persist to DB only (cron task stays until restart)
              db.prepare(
                "UPDATE scheduled_job_state SET enabled = 0, updated_at = ? WHERE job_id = ?"
              ).run(new Date().toISOString(), triageResult.jobId);
            }
            // Also reset stuck state and mark consecutive failures high
            db.prepare(
              "UPDATE scheduled_job_state SET is_running = 0, consecutive_failures = 999, updated_at = ? WHERE job_id = ?"
            ).run(new Date().toISOString(), triageResult.jobId);
            triageOutput += ` (disabled ${triageResult.jobId}${disabled ? ", cron stopped" : ", DB only"})`;
            logger.warn({ jobId: triageResult.jobId, reason: triageResult.reason, runtimeDisabled: disabled }, "Health triage: disabled job");
          } catch (disableErr) {
            logger.warn({ error: disableErr, jobId: triageResult.jobId }, "Health triage: failed to disable job");
          }
        }
      }
    }
  } catch (triageErr) {
    logger.warn({ error: triageErr }, "Health check LLM triage failed");
  }

  return {
    success: true,
    output: `${issues.length} issue(s) found${alertSent ? ", alert sent" : ", alert FAILED to send; retry scheduled"}${triageOutput}`,
  };
}

interface HealthTriageResult {
  action: "restart_job" | "disable_job" | "escalate";
  reason: string;
  jobId?: string;
}

async function runHealthLLMTriage(
  issues: string[],
  ctx: InternalJobContext,
  job: RegisteredJob,
  startedAt: Date,
): Promise<HealthTriageResult | null> {
  const prompt = `Homer health check found these issues:

${issues.join("\n")}

Decide ONE action. Return ONLY a raw JSON object (no markdown, no explanation):
{"action": "escalate", "reason": "...", "jobId": "optional-job-id"}

Valid actions:
- "restart_job" — Reset a specific stuck/failing job's state so it runs next cycle. Include "jobId".
- "disable_job" — Disable a specific job that keeps failing. Include "jobId".
- "escalate" — Send Telegram alert only (already done). Use when uncertain or issue is external.

Rules:
- Prefer "escalate" for credential issues (user must fix manually)
- Prefer "restart_job" for stuck jobs with < 5 consecutive failures
- Prefer "escalate" for connectivity issues (transient)
- Default to "escalate" if uncertain`;

  const result = await runInternalJobHarness(job, prompt, {
    stage: "triage",
    startedAt,
    emitCompletedEvent: false,
    signal: ctx.signal,
  });
  if (!result.success || !result.output) return null;

  try {
    const match = result.output.match(/\{[^{}]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as HealthTriageResult;
      if (["restart_job", "disable_job", "escalate"].includes(parsed.action)) {
        return parsed;
      }
    }
  } catch {
    // Parse failed
  }

  return null;
}

async function runHandler(
  job: RegisteredJob,
  ctx: InternalJobContext,
  startedAt: Date
): Promise<JobExecutionResult> {
  try {
    switch (job.config.handler) {
      case "idea_ingest": {
        const result = await ingestIdeasFromLegacy(ctx.stateManager.getDb());
        const parts: string[] = [];
        if (result.ingested > 0) {
          parts.push(`Ingested ${result.ingested} ideas`);
          if (result.fromTwitter > 0) parts.push(`${result.fromTwitter} from X`);
          if (result.enriched > 0) parts.push(`${result.enriched} enriched`);
        }
        if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
        const output = parts.length > 0 ? parts.join(", ") : "No new ideas found";
        return buildResult(
          job,
          startedAt,
          true,
          output,
          undefined,
          { notificationIntent: "operational_status" }
        );
      }
      case "idea_expiry": {
        const db = ctx.stateManager.getDb();
        const result = expireStaleIdeas(db, 70);
        const packetResult = expireStalePackets(db, 70);

        // High-volume rescue alert: >5 archives in one run gets a Telegram with row IDs.
        // <=5 is silent — the run log is enough. Honesty contract: cite IDs, not just titles.
        if (result.archived.length > 5 && ctx.bot && ctx.chatId) {
          const visible = result.archived.slice(0, 25);
          const lines = visible
            .map((idea) => `- ${idea.id}: ${idea.title}`)
            .join("\n");
          const overflow = result.archived.length > visible.length
            ? `\n…and ${result.archived.length - visible.length} more.`
            : "";
          const messageText =
            `Idea auto-expiry archived ${result.archived.length} ideas (>70d untouched).\n` +
            `Reversible: set status back to draft to revive.\n\n` +
            `${lines}${overflow}`;

          await routeTelegramNotification({
            db,
            sourceType: "scheduler_job",
            sourceId: job.config.id,
            jobRunId: ctx.jobRunId,
            intent: "decision_request",
            title: "Idea auto-expiry review",
            messageText,
            deliver: ctx.bot ? async () => {
              return ctx.bot!.api.sendMessage(ctx.chatId!, messageText);
            } : undefined,
          });
        }

        // Same rescue alert for packets: >5 review-stage packets archived in one run.
        if (packetResult.archived.length > 5 && ctx.bot && ctx.chatId) {
          const visible = packetResult.archived.slice(0, 25);
          const lines = visible
            .map((packet) => `- ${packet.id}: ${packet.title ?? "(untitled)"}`)
            .join("\n");
          const overflow = packetResult.archived.length > visible.length
            ? `\n…and ${packetResult.archived.length - visible.length} more.`
            : "";
          const messageText =
            `Packet auto-expiry archived ${packetResult.archived.length} source packets (>70d in review).\n` +
            `Reversible: set status back to review to revive.\n\n` +
            `${lines}${overflow}`;

          await routeTelegramNotification({
            db,
            sourceType: "scheduler_job",
            sourceId: job.config.id,
            jobRunId: ctx.jobRunId,
            intent: "decision_request",
            title: "Packet auto-expiry review",
            messageText,
            deliver: ctx.bot ? async () => {
              return ctx.bot!.api.sendMessage(ctx.chatId!, messageText);
            } : undefined,
          });
        }

        return buildResult(
          job,
          startedAt,
          true,
          `${result.output} ${packetResult.output}`,
          undefined,
          { notificationIntent: "operational_status" }
        );
      }
      case "weekly_consolidation": {
        const result = await runWeeklyConsolidation(job, startedAt, 7, ctx.stateManager);

        // Lint findings are now surfaced in the nightly Memory Review batch (stale claims
        // flagged by flagClaimsStale() will be picked up by getStaleClaims() in the nightly handler)
        if (result.success && result.lintFindings && result.lintFindings.length > 0) {
          logger.info({ count: result.lintFindings.length }, "Lint findings flagged as stale — will appear in next nightly Memory Review");
        }

        return buildResult(
          job,
          startedAt,
          result.success,
          result.output,
          result.error,
          result.success ? { notificationIntent: "user_info" } : {}
        );
      }
      case "ideas_explore": {
        const { runIdeasExplore } = await import("./jobs/ideas-explore.js");
        const result = await runIdeasExplore(ctx.stateManager.getDb(), job, startedAt);
        return buildResult(
          job,
          startedAt,
          result.success,
          result.output,
          result.error,
          result.success ? { notificationIntent: "operational_status" } : {}
        );
      }
      case "nightly_memory": {
        const { runNightlyMemory } = await import("./jobs/nightly-memory.js");
        const result = await runNightlyMemory(ctx.stateManager, job, startedAt);

        // Memory review delivery deferred to 9 AM morning review job.
        // Claims accumulate silently overnight; morning-review handler sends them all at once.
        if (result.success) {
          const { getPendingCandidates } = await import("../memory/claims.js");
          const db = ctx.stateManager.getDb();
          const pending = getPendingCandidates(db, 1).length;
          logger.info({ pending }, "Nightly memory complete — candidates queued for 9 AM morning review");
        }

        return buildResult(
          job,
          startedAt,
          result.success,
          result.output,
          result.error,
          result.success ? { notificationIntent: "operational_status" } : {}
        );
      }
      case "candidate_expiry": {
        try {
          const { expireStaleCandidates, getClaimMetrics } = await import("../memory/claims.js");
          const db = ctx.stateManager.getDb();
          const expired = expireStaleCandidates(db, 7);
          const metrics = getClaimMetrics(db);
          const output = `Expired ${expired} stale candidates. Queue: ${metrics.candidate} pending, ${metrics.approved} approved, ${metrics.rejected} rejected.`;
          return buildResult(job, startedAt, true, output, undefined, { notificationIntent: "operational_status" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return buildResult(job, startedAt, false, "", msg);
        }
      }
      case "session_harvester": {
        const { runSessionHarvester } = await import("./jobs/session-harvester.js");
        const result = await runSessionHarvester(ctx.stateManager, ctx.signal);
        return buildResult(
          job,
          startedAt,
          result.success,
          result.output,
          result.error,
          result.success ? { notificationIntent: "operational_status" } : {}
        );
      }
      case "memory_embeddings": {
        const { runMemoryEmbeddings } = await import("./jobs/memory-embeddings.js");
        const result = await runMemoryEmbeddings(ctx.stateManager);
        return buildResult(
          job,
          startedAt,
          result.success,
          result.output,
          result.error,
          result.success ? { notificationIntent: "operational_status" } : {}
        );
      }
      case "memory_reindex": {
        const { runMemoryReindex } = await import("./jobs/memory-reindex.js");
        const result = await runMemoryReindex(ctx.stateManager);
        return buildResult(
          job,
          startedAt,
          result.success,
          result.output,
          result.error,
          result.success ? { notificationIntent: "operational_status" } : {}
        );
      }
      case "telegram_registry_cleanup": {
        const { runTelegramRegistryCleanup } = await import("./jobs/telegram-registry-cleanup.js");
        const result = await runTelegramRegistryCleanup(ctx.stateManager);
        return buildResult(
          job,
          startedAt,
          result.success,
          result.output,
          result.error,
          result.success ? { notificationIntent: "operational_status" } : {}
        );
      }
      case "morning_review": {
        if (!ctx.bot) {
          return buildResult(
            job,
            startedAt,
            true,
            "Telegram disabled; morning review skipped",
            undefined,
            { notificationIntent: "operational_status" }
          );
        }
        // Consolidated 9 AM morning review — memory candidates, ideas, cleanup proposals, skills
        let parts: string[] = [];

        // 1. Send morning review summary (memory + cleanup + skills)
        const { sendMorningReview } = await import("../bot/handlers/morning-review.js");
        let morningReviewSent = false;
        let morningReviewError: string | undefined;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            await sendMorningReview(ctx.bot, ctx.chatId, ctx.stateManager);
            morningReviewSent = true;
            parts.push("morning review sent");
            break;
          } catch (err) {
            morningReviewError = err instanceof Error ? err.message : String(err);
            logger.error({ error: err, attempt }, "Morning review summary failed");
            if (attempt < 2) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }
        if (!morningReviewSent) {
          return buildResult(
            job,
            startedAt,
            false,
            "Morning review summary failed",
            morningReviewError,
            { notificationIntent: "failure_alert" }
          );
        }

        // 2. Send ideas for review (previously at 7 AM, now consolidated)
        // Gated to every other day — scrapers keep running daily, but the
        // 新发现审阅 digest only fires on even-parity days-since-epoch.
        // Set HOMER_PACKET_REVIEW_FORCE=1 to override (manual trigger / testing).
        const daysSinceEpoch = Math.floor(Date.now() / 86_400_000);
        const isPacketReviewDay = daysSinceEpoch % 2 === 0;
        if (isPacketReviewDay || process.env.HOMER_PACKET_REVIEW_FORCE === "1") {
          try {
            const ideaCount = await sendBatchIdeasForReview(ctx.bot, ctx.chatId);
            if (ideaCount > 0) parts.push(`${ideaCount} ideas sent`);
          } catch (err) {
            logger.debug({ error: err }, "Ideas review skipped");
          }
        } else {
          parts.push("packet review skipped (off-day)");
        }

        const output = parts.length > 0
          ? `Morning review: ${parts.join(", ")}`
          : "Morning review: nothing pending";

        return buildResult(job, startedAt, true, output, undefined,
          parts.length > 0
            ? { notificationIntent: "decision_request", sideEffectDelivered: true }
            : { notificationIntent: "operational_status" }
        );
      }

      case "outcome_tracker": {
        const { runOutcomeTracker } = await import("./jobs/outcome-tracker.js");
        const result = await runOutcomeTracker(ctx.stateManager.getDb(), ctx.bot ?? undefined, ctx.chatId, ctx.signal, job, startedAt);
        return buildResult(
          job,
          startedAt,
          result.success,
          result.output,
          result.error,
          result.success
            ? result.errors > 0
              ? { notificationIntent: "failure_alert" }
              : result.sentToTelegram > 0
                ? {
                    notificationIntent: "decision_request",
                    sideEffectDelivered: true,
                  }
                : {
                    notificationIntent: "operational_status",
                  }
            : {}
        );
      }
      case "preference_updater": {
        const { runPreferenceUpdater } = await import("./jobs/preference-updater.js");
        const result = await runPreferenceUpdater(ctx.stateManager.getDb());
        return buildResult(
          job,
          startedAt,
          result.success,
          result.output,
          result.error,
          result.success ? { notificationIntent: "operational_status" } : {}
        );
      }
      case "nightly_code_push": {
        const { runNightlyCodePush } = await import("./jobs/nightly-code-push.js");
        const result = await runNightlyCodePush({
          bot: ctx.bot ?? undefined,
          chatId: ctx.chatId,
          stateManager: ctx.stateManager,
          job,
          startedAt,
        });
        return buildResult(
          job,
          startedAt,
          result.success,
          result.output,
          result.error,
          result.success ? { notificationIntent: "operational_status" } : {}
        );
      }
      case "db_backup": {
        const { runDbBackup } = await import("./jobs/db-backup.js");
        const result = await runDbBackup();
        return buildResult(
          job,
          startedAt,
          result.success,
          result.output,
          result.error,
          result.success ? { notificationIntent: "operational_status" } : {}
        );
      }
      case "content_scraper": {
        const { runContentScraper } = await import("./jobs/content-scraper.js");
        const result = await runContentScraper(ctx.stateManager.getDb(), job, startedAt);
        return buildResult(
          job,
          startedAt,
          result.success,
          result.output,
          result.error,
          result.success ? { notificationIntent: "operational_status" } : {}
        );
      }
      case "abvp_refresh": {
        const { runAbvpRefresh } = await import("./jobs/abvp-refresh.js");
        const result = await runAbvpRefresh({
          db: ctx.stateManager.getDb(),
          bot: ctx.bot,
          chatId: ctx.chatId,
          jobRunId: ctx.jobRunId,
          signal: ctx.signal,
          job,
          startedAt,
        });
        return buildResult(
          job,
          startedAt,
          result.success,
          result.output,
          result.error,
          {
            notificationIntent: result.notificationIntent,
            sideEffectDelivered: result.sideEffectDelivered,
          },
        );
      }
      case "idea_synthesizer": {
        const { runIdeaSynthesizer } = await import("./jobs/idea-synthesizer.js");
        const result = await runIdeaSynthesizer(ctx.stateManager.getDb(), ctx.jobRunId, ctx.signal, job, startedAt);
        return buildResult(
          job,
          startedAt,
          result.success,
          result.output,
          result.error,
          result.success ? { notificationIntent: "operational_status" } : {}
        );
      }
      case "link_processor": {
        const { runLinkProcessor } = await import("./jobs/link-processor.js");
        const result = await runLinkProcessor(ctx.stateManager, ctx.jobRunId, job, startedAt);
        return buildResult(
          job,
          startedAt,
          result.success,
          result.output,
          result.error,
          result.success ? { notificationIntent: "operational_status" } : {}
        );
      }
      case "archive_verify": {
        const { runArchiveVerify } = await import("./jobs/archive-verify.js");
        const result = await runArchiveVerify(ctx.stateManager.getDb());
        return buildResult(
          job,
          startedAt,
          result.success,
          result.output,
          result.error,
          result.success ? { notificationIntent: "operational_status" } : {}
        );
      }
      case "health_check": {
        const result = await runHealthCheck(ctx, job, startedAt);
        return buildResult(
          job,
          startedAt,
          result.success,
          result.output,
          result.error,
          result.success ? getHealthResultOptions(result.output) : {}
        );
      }
      case "architecture_updater": {
        const { runArchitectureUpdater } = await import("./jobs/architecture-updater.js");
        const result = await runArchitectureUpdater();
        return buildResult(
          job,
          startedAt,
          result.success,
          result.output,
          result.error,
          result.success ? { notificationIntent: "operational_status" } : {}
        );
      }
      case "daemon_cleanup": {
        const cleanup = await cleanupScheduler.run("scheduled");
        const cleanedRuns = ctx.stateManager.cleanupScheduledJobRunsOlderThan(60);
        const schedules = await loadAllSchedules();
        const activeJobIds = new Set([
          ...getAllJobs(schedules).map((scheduledJob) => scheduledJob.id),
          ...JOB_REGISTRY.map((entry) => entry.id),
        ]);
        const prunedStateRows = ctx.stateManager.pruneScheduledJobStateExcept([...activeJobIds]);
        if (cleanedRuns > 0 || prunedStateRows.length > 0) {
          logger.info(
            { cleanedRuns, prunedStateRows },
            "Daemon cleanup pruned scheduler history/state",
          );
        }
        const outputParts = ["Daemon cleanup completed"];
        const logParts: string[] = [];
        if (cleanup.logMaintenance.rotated > 0) logParts.push(`rotated ${cleanup.logMaintenance.rotated} log(s)`);
        if (cleanup.logMaintenance.pruned > 0) logParts.push(`pruned ${cleanup.logMaintenance.pruned} retained log(s)`);
        if (cleanup.logMaintenance.errors.length > 0) {
          logParts.push(`${cleanup.logMaintenance.errors.length} log maintenance error(s)`);
        }
        if (logParts.length > 0) outputParts.push(logParts.join(", "));
        if (cleanedRuns > 0) outputParts.push(`pruned ${cleanedRuns} run rows older than 60d`);
        if (prunedStateRows.length > 0) outputParts.push(`pruned state rows: ${prunedStateRows.join(", ")}`);
        return buildResult(
          job,
          startedAt,
          true,
          outputParts.join("; "),
          undefined,
          { notificationIntent: "operational_status" }
        );
      }
      case "docker_restart": {
        // Weekly restart of Docker Desktop to reclaim leaked engine memory, then
        // bring yanqing.app backend containers back so portfolio-api stays reachable.
        // Quitting Docker Desktop alone leaves portfolio-backend/redis down until a
        // later monitor cycle (~4h), so this handler waits for the daemon and runs
        // `docker compose up -d` before reporting success.
        const exec = promisify(execFile);
        const { getRuntimePaths } = await import("../utils/runtime-paths.js");
        const portfolioDir = path.join(getRuntimePaths().homeDir, "ai-portfolio");
        const localHealth = "http://localhost:8100/health";
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const dockerReady = async (): Promise<boolean> => {
          try {
            await exec("docker", ["info"], { timeout: 10_000 });
            return true;
          } catch {
            return false;
          }
        };
        const waitUntil = async (
          label: string,
          check: () => Promise<boolean>,
          attempts: number,
          delayMs: number,
        ): Promise<boolean> => {
          for (let i = 0; i < attempts; i++) {
            if (ctx.signal?.aborted) {
              throw new Error(`aborted while waiting for ${label}`);
            }
            if (await check()) return true;
            await sleep(delayMs);
          }
          return false;
        };
        const healthOk = async (url: string): Promise<boolean> => {
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) return false;
            const body = await res.text();
            return /"status"\s*:\s*"ok"/.test(body);
          } catch {
            return false;
          }
        };
        const steps: string[] = [];
        try {
          await exec("osascript", ["-e", 'quit app "Docker"'], { timeout: 30_000 });
          steps.push("quit Docker Desktop");
          // Wait until the engine is actually gone before relaunching.
          await waitUntil("docker exit", async () => !(await dockerReady()), 20, 2_000);
          await exec("open", ["-ga", "Docker"], { timeout: 30_000 });
          steps.push("relaunch Docker Desktop");

          const engineUp = await waitUntil("docker daemon", dockerReady, 60, 5_000);
          if (!engineUp) {
            return buildResult(
              job,
              startedAt,
              false,
              steps.join("; "),
              "Docker Desktop relaunched but daemon never became ready",
              { notificationIntent: "operational_status" },
            );
          }
          steps.push("docker daemon ready");

          try {
            await exec("docker", ["compose", "up", "-d"], {
              cwd: portfolioDir,
              timeout: 180_000,
            });
            steps.push(`compose up -d (${portfolioDir})`);
          } catch (composeErr) {
            const composeMsg = composeErr instanceof Error ? composeErr.message : String(composeErr);
            return buildResult(
              job,
              startedAt,
              false,
              steps.join("; "),
              `docker compose up -d failed: ${composeMsg}`,
              { notificationIntent: "operational_status" },
            );
          }

          const backendUp = await waitUntil(
            "portfolio-backend health",
            () => healthOk(localHealth),
            24,
            5_000,
          );
          if (!backendUp) {
            return buildResult(
              job,
              startedAt,
              false,
              steps.join("; "),
              `containers started but ${localHealth} never returned status:ok`,
              { notificationIntent: "operational_status" },
            );
          }
          steps.push("portfolio-backend healthy");

          return buildResult(
            job,
            startedAt,
            true,
            `Docker Desktop restarted; yanqing.app backend restored (${steps.join(" → ")})`,
            undefined,
            { notificationIntent: "operational_status" },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return buildResult(
            job,
            startedAt,
            false,
            steps.length > 0 ? steps.join("; ") : "",
            `Docker restart failed: ${msg}`,
            { notificationIntent: "operational_status" },
          );
        }
      }
      case "session_maintenance": {
        const errors: string[] = [];
        let cleanedNotificationEvents = 0;
        const steps: [string, () => void | Promise<void>][] = [
          ["cleanupExpiredSessions", () => ctx.stateManager.cleanupExpiredSessions()],
          ["cleanupOldJobs", () => ctx.stateManager.cleanupOldJobs()],
          ["cleanupOldReminders", () => ctx.stateManager.cleanupOldReminders()],
          ["cleanupOldScheduledJobRuns", () => { cleanedRuns = ctx.stateManager.cleanupOldScheduledJobRuns(); }],
          ["cleanupNotificationEvents", () => { cleanedNotificationEvents = ctx.stateManager.cleanupNotificationEvents().total; }],
          ["runDatabaseMaintenance", () => ctx.stateManager.runDatabaseMaintenance()],
          ["checkAndFlushExpiringSessions", async () => {
            const ttlMs = config.session.ttlHours * 60 * 60 * 1000;
            await checkAndFlushExpiringSessions(ctx.stateManager, ttlMs);
          }],
        ];
        let cleanedRuns = 0;
        for (const [name, fn] of steps) {
          try {
            await fn();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error({ err, step: name }, `session_maintenance step failed: ${name}`);
            errors.push(`${name}: ${msg}`);
          }
        }
        const parts: string[] = ["Session maintenance done"];
        if (cleanedRuns > 0) parts.push(`cleaned ${cleanedRuns} old runs`);
        if (cleanedNotificationEvents > 0) {
          parts.push(`cleaned ${cleanedNotificationEvents} notification events`);
        }
        if (errors.length > 0) parts.push(`${errors.length} step(s) failed: ${errors.join("; ")}`);
        return buildResult(
          job,
          startedAt,
          errors.length === 0,
          parts.join(", "),
          errors.length > 0 ? errors.join("\n") : undefined,
          { notificationIntent: "operational_status" }
        );
      }
      case "reminder_check": {
        const { getReminderManager } = await import("../bot/index.js");
        const reminderManager = getReminderManager();
        if (!reminderManager) {
          return buildResult(
            job,
            startedAt,
            true,
            "Reminder manager not initialized",
            undefined,
            { notificationIntent: "operational_status" }
          );
        }
        const pending = reminderManager.getPendingDue();
        if (!ctx.bot) {
          return buildResult(
            job,
            startedAt,
            true,
            pending.length > 0
              ? `Telegram disabled; ${pending.length} due reminder(s) left pending`
              : "No due reminders",
            undefined,
            { notificationIntent: "operational_status" }
          );
        }
        let sent = 0;
        const failures: string[] = [];
        for (const reminder of pending) {
          try {
            await ctx.bot.api.sendMessage(
              reminder.chatId,
              `⏰ *Reminder*\n\n${reminder.message}`,
              { parse_mode: "Markdown" }
            );
            reminderManager.markSent(reminder.id);
            sent++;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failures.push(`${reminder.id}: ${message}`);
            logger.error(
              { error, reminderId: reminder.id },
              "Failed to send reminder; leaving pending for retry"
            );
          }
        }
        const outputParts: string[] = [];
        if (sent > 0) outputParts.push(`Sent ${sent} reminder${sent === 1 ? "" : "s"}`);
        if (failures.length > 0) {
          outputParts.push(`${failures.length} reminder${failures.length === 1 ? "" : "s"} failed; left pending for retry`);
          outputParts.push(failures.join("; "));
        }
        return buildResult(
          job,
          startedAt,
          true,
          outputParts.length > 0 ? outputParts.join("; ") : "No pending reminders",
          undefined,
          failures.length > 0
            ? {
                notificationIntent: "failure_alert",
              }
            : sent > 0
            ? {
                notificationIntent: "user_info",
                sideEffectDelivered: true,
              }
            : {
                notificationIntent: "operational_status",
              }
        );
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

  let result = await runHandler(job, ctx, startedAt);

  // Retry once for retryable handlers on transient errors
  const handler = job.config.handler ?? "";
  if (!result.success && RETRYABLE_HANDLERS.has(handler) && isTransientError(result.error)) {
    // Skip retry if the job was aborted by the hang watchdog
    if (ctx.signal?.aborted) {
      logger.warn({ jobId: job.config.id }, "Job aborted by timeout, skipping retry");
      writeInternalTrace({
        jobId: job.config.id,
        jobName: job.config.name,
        executor: "internal",
        success: false,
        durationMs: result.duration,
        exitCode: result.exitCode,
        error: result.error,
        scheduledRunId: ctx.jobRunId,
      });
      return result;
    }

    logger.warn({ jobId: job.config.id, error: result.error }, "Transient error detected, retrying in 10s");

    // Wait 10s before retry, but bail early if aborted
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      ctx.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });

    if (ctx.signal?.aborted) {
      logger.warn({ jobId: job.config.id }, "Job aborted during retry wait, skipping retry");
      writeInternalTrace({
        jobId: job.config.id,
        jobName: job.config.name,
        executor: "internal",
        success: false,
        durationMs: result.duration,
        exitCode: result.exitCode,
        error: result.error,
        scheduledRunId: ctx.jobRunId,
      });
      return result;
    }

    const retryStartedAt = new Date();
    result = await runHandler(job, ctx, retryStartedAt);

    if (result.success) {
      logger.info({ jobId: job.config.id }, "Retry succeeded");
    } else {
      logger.error({ jobId: job.config.id, error: result.error }, "Retry also failed");
    }
  }

  // Write execution trace for every internal job completion
  writeInternalTrace({
    jobId: job.config.id,
    jobName: job.config.name,
    executor: job.config.handler ?? "internal",
    success: result.success,
    durationMs: result.duration,
    exitCode: result.exitCode,
    error: result.error,
    scheduledRunId: ctx.jobRunId,
  });

  return result;
}
