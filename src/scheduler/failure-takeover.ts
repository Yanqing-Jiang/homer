import { readFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { logger } from "../utils/logger.js";
import { executeClaudeCommand } from "../executors/claude.js";
import { executeInternalJob } from "./internal-handlers.js";
import { executeScheduledJob } from "./executor.js";
import type { RegisteredJob, JobExecutionResult } from "./types.js";
import type { StateManager } from "../state/manager.js";
import type { Bot } from "grammy";

// ============================================
// Types
// ============================================

export interface TakeoverDecision {
  action: "retry" | "fix_and_retry" | "report";
  diagnosis: string;
  fixDescription?: string;
  retryModifications?: string;
  reportMessage?: string;
  confidence: number;
}

export interface TakeoverResult {
  decision: TakeoverDecision;
  takeoverSessionOutput: string;
  retryResult?: JobExecutionResult;
  finalSuccess: boolean;
  duration: number;
}

// ============================================
// Guards (module-level state)
// ============================================

const activeTakeovers = new Set<string>();
let takeoverCountToday = 0;
let lastCountResetDate = "";
let activeTakeoverCount = 0;
const perJobCountToday = new Map<string, number>();
const DAILY_LIMIT = 10;
const CONCURRENT_LIMIT = 2;
const MAX_PER_JOB_DAILY = 2;

/** Minimum backoff delay (ms) before retrying a job that has failed recently */
const BASE_BACKOFF_MS = 30_000; // 30 seconds

/** StateManager ref for recovering takeover counts from DB */
let _stateManagerRef: StateManager | null = null;

function resetDailyCountIfNeeded(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastCountResetDate) {
    takeoverCountToday = 0;
    perJobCountToday.clear();
    lastCountResetDate = today;

    // Recover today's counts from DB (survives daemon restart)
    if (_stateManagerRef) {
      try {
        const db = _stateManagerRef.getDb();
        const rows = db.prepare(
          `SELECT job_id, COUNT(*) as cnt FROM failure_takeover_runs
           WHERE date(created_at) = ?
           GROUP BY job_id`
        ).all(today) as Array<{ job_id: string; cnt: number }>;
        for (const row of rows) {
          perJobCountToday.set(row.job_id, row.cnt);
          takeoverCountToday += row.cnt;
        }
        if (takeoverCountToday > 0) {
          logger.info({ takeoverCountToday }, "Recovered takeover counts from DB");
        }
      } catch {
        // Best effort — start from 0 if DB query fails (table may not exist yet)
      }
    }
  }
}

// ============================================
// Handler → source file map
// ============================================

const HANDLER_SOURCE_MAP: Record<string, string> = {
  ideas_explore: "src/scheduler/jobs/ideas-explore.ts",
  nightly_memory: "src/scheduler/jobs/nightly-memory.ts",
  session_harvester: "src/scheduler/jobs/session-harvester.ts",
  homer_improvements: "src/scheduler/jobs/homer-improvements.ts",
  learning_engine: "src/scheduler/jobs/learning-engine.ts",
  session_summaries: "src/scheduler/jobs/session-summaries.ts",
  memory_embeddings: "src/scheduler/jobs/memory-embeddings.ts",
  memory_reindex: "src/scheduler/jobs/memory-reindex.ts",
  weekly_consolidation: "src/scheduler/jobs/weekly-consolidation.ts",
  memory_cleanup: "src/scheduler/jobs/memory-cleanup.ts",
  planning_reminder: "src/scheduler/jobs/planning-reminder.ts",
  job_hunt_discover: "src/scheduler/jobs/job-hunt-discover.ts",
  job_hunt_weekly_report: "src/scheduler/jobs/job-hunt-report.ts",
  job_hunt_email_monitor: "src/scheduler/jobs/job-hunt-email-monitor.ts",
  job_hunt_followup: "src/scheduler/jobs/job-hunt-followup.ts",
  idea_ingest: "src/ideas/ingest.ts",
  idea_dedup: "src/ideas/dedup.ts",
  ideas_review: "src/bot/handlers/approval.ts",
  overnight_review: "src/bot/handlers/overnight.ts",
  outcome_tracker: "src/scheduler/jobs/outcome-tracker.ts",
  preference_updater: "src/scheduler/jobs/preference-updater.ts",
  memory_git_commit: "src/scheduler/jobs/memory-git-commit.ts",
  nightly_code_push: "src/scheduler/jobs/nightly-code-push.ts",
  db_backup: "src/scheduler/jobs/db-backup.ts",
  content_scraper: "src/scheduler/jobs/content-scraper.ts",
};

// ============================================
// Context gathering
// ============================================

function truncate(text: string, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "\n...(truncated)" : text;
}

function getRecentRuns(stateManager: StateManager, jobId: string): string {
  const runs = stateManager.getRecentScheduledJobRuns(jobId, 5);
  if (runs.length === 0) return "(no recent runs)";

  return runs.map(r => {
    const status = r.success ? "SUCCESS" : "FAIL";
    const errSnippet = r.error ? ` | ${truncate(r.error, 200)}` : "";
    return `- [${status}] ${r.startedAt}${errSnippet}`;
  }).join("\n");
}

function getHandlerSource(handler: string): string | null {
  const relativePath = HANDLER_SOURCE_MAP[handler];
  if (!relativePath) return null;

  const fullPath = join(process.env.HOME ?? "/Users/yj", "homer", relativePath);
  if (!existsSync(fullPath)) return null;

  try {
    return readFileSync(fullPath, "utf-8");
  } catch {
    return null;
  }
}

function getDependencySource(handlerSource: string): string | null {
  // Check for model-swarm import
  const swarmImport = handlerSource.match(/from\s+["'].*model-swarm["']/);
  if (swarmImport) {
    const swarmPath = join(process.env.HOME ?? "/Users/yj", "homer", "src/executors/model-swarm.ts");
    if (existsSync(swarmPath)) {
      try {
        return readFileSync(swarmPath, "utf-8");
      } catch { /* ignore */ }
    }
  }
  return null;
}

function getFallbackLogs(jobId: string): string {
  const logDir = join(process.env.HOME ?? "/Users/yj", "homer", "logs", "fallback");
  if (!existsSync(logDir)) return "(no fallback logs)";

  try {
    const files = readdirSync(logDir)
      .filter(f => f.startsWith(jobId))
      .sort()
      .slice(-3); // last 3 logs

    if (files.length === 0) return "(no fallback logs for this job)";

    return files.map(f => {
      try {
        const content = readFileSync(join(logDir, f), "utf-8");
        return `--- ${f} ---\n${truncate(content, 1000)}`;
      } catch {
        return `--- ${f} --- (read error)`;
      }
    }).join("\n\n");
  } catch {
    return "(error reading fallback logs)";
  }
}

// ============================================
// Prompt builder
// ============================================

function buildTakeoverPrompt(params: {
  job: RegisteredJob;
  failedResult: JobExecutionResult;
  recentRuns: string;
  jobState: { consecutiveFailures: number; lastSuccessAt: string | null };
  handlerSource?: string | null;
  dependencySource?: string | null;
  fallbackLogs?: string;
  allowAutoFix: boolean;
}): string {
  const { job, failedResult, recentRuns, jobState, handlerSource, dependencySource, fallbackLogs, allowAutoFix } = params;

  let prompt = `<takeover_context>
<role>
You are a failure recovery agent for Homer's scheduler. A job just failed.
Diagnose why, and decide the best course of action.
</role>

<failed_job>
  <id>${job.config.id}</id>
  <name>${job.config.name}</name>
  <executor>${job.config.executor ?? "claude"}</executor>
  <handler>${job.config.handler ?? "N/A"}</handler>
  <cron>${job.config.cron}</cron>
  <query>${truncate(job.config.query, 2000)}</query>
</failed_job>

<failure_details>
  <exit_code>${failedResult.exitCode}</exit_code>
  <error>${truncate(failedResult.error ?? "", 3000)}</error>
  <output>${truncate(failedResult.output, 3000)}</output>
  <duration_ms>${failedResult.duration}</duration_ms>
</failure_details>

<job_state>
  <consecutive_failures>${jobState.consecutiveFailures}</consecutive_failures>
  <last_success_at>${jobState.lastSuccessAt ?? "never"}</last_success_at>
</job_state>

<recent_runs>
${recentRuns}
</recent_runs>`;

  if (handlerSource) {
    prompt += `\n\n<handler_source>\n${truncate(handlerSource, 8000)}\n</handler_source>`;
  }

  if (dependencySource) {
    prompt += `\n\n<dependency_source>\n${truncate(dependencySource, 4000)}\n</dependency_source>`;
  }

  if (fallbackLogs) {
    prompt += `\n\n<fallback_logs>\n${truncate(fallbackLogs, 2000)}\n</fallback_logs>`;
  }

  const fixInstructions = allowAutoFix
    ? `ALLOWED: Edit files in ~/homer/src/scheduler/jobs/, ~/homer/data/, ~/memory/
FORBIDDEN: index.ts, manager.ts, executor.ts, types.ts, internal-handlers.ts
FORBIDDEN: npm run deploy, npm run build, launchctl, schedule.json`
    : `READ-ONLY mode. You may only clear stale DB state (stuck is_running flags).`;

  prompt += `

<instructions>
Diagnose the root cause. Check if transient (timeout, rate limit) or persistent (code bug).

${fixInstructions}

Return a fenced JSON decision block:
\`\`\`json
{
  "action": "retry | fix_and_retry | report",
  "diagnosis": "1-3 sentence root cause",
  "fixDescription": "what you fixed (fix_and_retry only)",
  "retryModifications": "state cleared, params changed",
  "reportMessage": "human-readable diagnostic for user (report only)",
  "confidence": 0.0-1.0
}
\`\`\`

Rules:
- "retry" for transient failures (timeout, rate limit, network)
- "fix_and_retry" ONLY if allowAutoFix and you actually edited something
- "report" if systemic, unfixable, or confidence < 0.5
- If consecutive_failures >= 3, prefer "report" unless you have a clear fix
</instructions>
</takeover_context>`;

  return prompt;
}

// ============================================
// Decision parser
// ============================================

function parseDecision(output: string): TakeoverDecision | null {
  const fenced = output.match(/```json\n?([\s\S]*?)\n?```/);
  const jsonText = fenced?.[1] ?? output.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) return null;

  try {
    const parsed = JSON.parse(jsonText);
    const action = parsed.action as TakeoverDecision["action"];
    if (!action || !["retry", "fix_and_retry", "report"].includes(action)) return null;

    return {
      action,
      diagnosis: typeof parsed.diagnosis === "string" ? parsed.diagnosis : "Unknown",
      fixDescription: typeof parsed.fixDescription === "string" ? parsed.fixDescription : undefined,
      retryModifications: typeof parsed.retryModifications === "string" ? parsed.retryModifications : undefined,
      reportMessage: typeof parsed.reportMessage === "string" ? parsed.reportMessage : undefined,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    };
  } catch {
    return null;
  }
}

// ============================================
// Main takeover function
// ============================================

export async function runFailureTakeover(params: {
  job: RegisteredJob;
  failedResult: JobExecutionResult;
  runId: number;
  stateManager: StateManager;
  bot: Bot;
  chatId: number;
}): Promise<TakeoverResult | null> {
  const { job, failedResult, runId, stateManager, bot, chatId } = params;
  _stateManagerRef = stateManager;
  const jobId = job.config.id;
  const startTime = Date.now();

  // Guard: recursion prevention
  if (activeTakeovers.has(jobId)) {
    logger.info({ jobId }, "Takeover already active for this job, skipping");
    return null;
  }

  // Guard: daily limit
  resetDailyCountIfNeeded();
  if (takeoverCountToday >= DAILY_LIMIT) {
    logger.info({ jobId, takeoverCountToday }, "Daily takeover limit reached, skipping");
    return null;
  }

  // Guard: concurrent limit
  if (activeTakeoverCount >= CONCURRENT_LIMIT) {
    logger.info({ jobId, activeTakeoverCount }, "Concurrent takeover limit reached, skipping");
    return null;
  }

  // Guard: consecutive failure ceiling
  const jobState = stateManager.getScheduledJobState(jobId);
  const consecutiveFailures = (jobState?.consecutiveFailures ?? 0) + 1; // +1 for current failure
  if (consecutiveFailures >= 5) {
    logger.info({ jobId, consecutiveFailures }, "Too many consecutive failures, skipping takeover");
    return null;
  }

  // Guard: per-job daily limit
  const jobTakeoverCount = perJobCountToday.get(jobId) ?? 0;
  if (jobTakeoverCount >= MAX_PER_JOB_DAILY) {
    logger.info({ jobId, jobTakeoverCount, MAX_PER_JOB_DAILY }, "Per-job daily takeover limit reached, skipping");
    return null;
  }

  // Guard: exponential backoff — wait longer between retries for repeatedly-failing jobs
  if (consecutiveFailures >= 2) {
    const backoffMs = BASE_BACKOFF_MS * Math.pow(2, consecutiveFailures - 2); // 30s, 60s, 120s, 240s
    logger.info({ jobId, consecutiveFailures, backoffMs }, "Applying exponential backoff before takeover");
    await new Promise(resolve => setTimeout(resolve, Math.min(backoffMs, 300_000))); // cap at 5 min
  }

  // Acquire guards
  activeTakeovers.add(jobId);
  activeTakeoverCount += 1;
  takeoverCountToday += 1;
  perJobCountToday.set(jobId, (perJobCountToday.get(jobId) ?? 0) + 1);

  try {
    logger.info({ jobId, runId, consecutiveFailures }, "Starting failure takeover");

    // Gather context
    const recentRuns = getRecentRuns(stateManager, jobId);
    const isInternal = job.config.executor === "internal" || !!job.config.handler;
    const allowAutoFix = job.config.allowAutoFix === true;

    let handlerSource: string | null = null;
    let dependencySource: string | null = null;
    let fallbackLogs: string | undefined;

    if (isInternal && job.config.handler) {
      handlerSource = getHandlerSource(job.config.handler);
      if (handlerSource) {
        dependencySource = getDependencySource(handlerSource);
      }
    } else {
      fallbackLogs = getFallbackLogs(jobId);
    }

    // Build prompt
    const prompt = buildTakeoverPrompt({
      job,
      failedResult,
      recentRuns,
      jobState: {
        consecutiveFailures,
        lastSuccessAt: jobState?.lastSuccessAt ?? null,
      },
      handlerSource,
      dependencySource,
      fallbackLogs,
      allowAutoFix,
    });

    // Ensure CWD exists
    const cwd = "/tmp/homer-takeover";
    mkdirSync(cwd, { recursive: true });

    // Spawn Claude Code session
    let claudeOutput: string;
    try {
      const result = await executeClaudeCommand(prompt, {
        cwd,
        model: "opus",
      });
      claudeOutput = result.output;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ jobId, error: msg }, "Takeover Claude session failed");
      return null;
    }

    // Parse decision
    const decision = parseDecision(claudeOutput);
    if (!decision) {
      logger.warn({ jobId, outputLength: claudeOutput.length }, "Could not parse takeover decision");
      // Record the failed parse attempt
      recordTakeoverRun(stateManager, {
        jobRunId: runId,
        jobId,
        decision: "report",
        diagnosis: "Takeover session did not produce a parseable decision",
        takeoverOutput: truncate(claudeOutput, 10000),
        retrySuccess: null,
        durationMs: Date.now() - startTime,
      });
      return {
        decision: {
          action: "report",
          diagnosis: "Takeover session did not produce a parseable decision",
          reportMessage: "Claude Code takeover ran but could not produce a structured decision.",
          confidence: 0,
        },
        takeoverSessionOutput: claudeOutput,
        finalSuccess: false,
        duration: Date.now() - startTime,
      };
    }

    logger.info({ jobId, action: decision.action, confidence: decision.confidence, diagnosis: decision.diagnosis }, "Takeover decision");

    // Execute decision
    let retryResult: JobExecutionResult | undefined;
    let finalSuccess = false;

    if (decision.action === "retry" || decision.action === "fix_and_retry") {
      try {
        if (isInternal) {
          retryResult = await executeInternalJob(job, {
            stateManager,
            bot,
            chatId,
            jobRunId: runId,
          });
        } else {
          retryResult = await executeScheduledJob(job, undefined, {
            singleExecutor: "claude",
          });
        }
        finalSuccess = retryResult.success;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ jobId, error: msg }, "Takeover retry execution failed");
        retryResult = {
          jobId,
          jobName: job.config.name,
          sourceFile: job.sourceFile,
          startedAt: new Date(),
          completedAt: new Date(),
          success: false,
          output: "",
          error: msg,
          exitCode: 1,
          duration: 0,
        };
      } finally {
        // Always release is_running lock after takeover retry
        try {
          stateManager.getDb().prepare(
            "UPDATE scheduled_job_state SET is_running = 0 WHERE job_id = ?"
          ).run(jobId);
        } catch {
          // Table may not exist or job state row may be missing
        }
      }
    }

    const durationMs = Date.now() - startTime;

    // Record in failure_takeover_runs
    recordTakeoverRun(stateManager, {
      jobRunId: runId,
      jobId,
      decision: decision.action,
      diagnosis: decision.diagnosis,
      fixDescription: decision.fixDescription,
      takeoverOutput: truncate(claudeOutput, 10000),
      retrySuccess: decision.action === "report" ? null : (finalSuccess ? 1 : 0),
      durationMs,
    });

    return {
      decision,
      takeoverSessionOutput: claudeOutput,
      retryResult,
      finalSuccess,
      duration: durationMs,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ jobId, error: msg }, "Failure takeover crashed");
    return null;
  } finally {
    activeTakeovers.delete(jobId);
    activeTakeoverCount -= 1;
  }
}

// ============================================
// DB recording
// ============================================

function recordTakeoverRun(stateManager: StateManager, params: {
  jobRunId: number;
  jobId: string;
  decision: string;
  diagnosis: string;
  fixDescription?: string;
  takeoverOutput: string;
  retrySuccess: number | null;
  durationMs: number;
}): void {
  try {
    stateManager.getDb().prepare(`
      INSERT INTO failure_takeover_runs
        (job_run_id, job_id, decision, diagnosis, fix_description, takeover_output, retry_success, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.jobRunId,
      params.jobId,
      params.decision,
      params.diagnosis,
      params.fixDescription ?? null,
      params.takeoverOutput,
      params.retrySuccess,
      params.durationMs,
    );
  } catch (error) {
    // Table may not exist yet if migration hasn't run
    logger.warn({ error, jobId: params.jobId }, "Failed to record takeover run (migration may be pending)");
  }
}
