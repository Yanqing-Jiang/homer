import { readFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { logger } from "../utils/logger.js";
import { executeResolvedHarness } from "../harness/dispatch.js";
import type { CapabilityRequirement } from "../harness/types.js";
import { executeInternalJob } from "./internal-handlers.js";
import { executeScheduledJob } from "./executor.js";
import type { RegisteredJob, JobExecutionResult } from "./types.js";
import type { StateManager } from "../state/manager.js";
import type { Bot } from "grammy";
import { PATHS } from "../config/paths.js";

// ============================================
// Types
// ============================================

export interface TakeoverDecision {
  // retry/fix_and_retry/report are emitted during the retry loop.
  // abandon/switch_harness are emitted only in escalation mode (after retries exhaust).
  action: "retry" | "fix_and_retry" | "report" | "abandon" | "switch_harness";
  diagnosis: string;
  fixDescription?: string;
  retryModifications?: string;
  reportMessage?: string;
  /** Escalation only: harness the LLM suggests switching to (advisory). */
  suggestedHarness?: string;
  confidence: number;
}

export interface TakeoverResult {
  decision: TakeoverDecision;
  takeoverSessionOutput: string;
  retryResult?: JobExecutionResult;
  finalSuccess: boolean;
  duration: number;
  /** Number of LLM-owned retries actually attempted (0-3). */
  retriesAttempted: number;
  /** Escalation-mode decision (abandon | switch_harness) when retries were exhausted. */
  escalation?: TakeoverDecision;
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

/** Hard cap on LLM-owned retries within a single takeover cycle. */
const MAX_TAKEOVER_RETRIES = 3;

/** Wall-clock ceiling for the whole retry loop — retries run outside executeJob's hang watchdog. */
const TAKEOVER_WALL_CLOCK_MS = 30 * 60 * 1000; // 30 minutes

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
        // Count DISTINCT job_run_id: one takeover cycle now writes multiple rows
        // (one per retry + one escalation), but the guards count cycles, not rows.
        const rows = db.prepare(
          `SELECT job_id, COUNT(DISTINCT job_run_id) as cnt FROM failure_takeover_runs
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
  memory_embeddings: "src/scheduler/jobs/memory-embeddings.ts",
  memory_reindex: "src/scheduler/jobs/memory-reindex.ts",
  weekly_consolidation: "src/scheduler/jobs/weekly-consolidation.ts",
  idea_ingest: "src/ideas/ingest.ts",
  outcome_tracker: "src/scheduler/jobs/outcome-tracker.ts",
  preference_updater: "src/scheduler/jobs/preference-updater.ts",
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

  const fullPath = join(PATHS.homerRoot, relativePath);
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
    const swarmPath = join(PATHS.homerRoot, "src/executors/model-swarm.ts");
    if (existsSync(swarmPath)) {
      try {
        return readFileSync(swarmPath, "utf-8");
      } catch { /* ignore */ }
    }
  }
  return null;
}

function getFallbackLogs(jobId: string): string {
  const logDir = join(PATHS.homerRoot, "logs", "fallback");
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
  /** 1-based retry attempt info shown to the LLM during the retry loop. */
  retryAttempt?: { current: number; max: number };
  /** When set, ask the LLM to escalate (abandon vs switch_harness) instead of retrying. */
  escalationMode?: boolean;
  /** Harnesses the LLM may suggest switching to (escalation mode). */
  availableHarnesses?: string[];
}): string {
  const { job, failedResult, recentRuns, jobState, handlerSource, dependencySource, fallbackLogs, allowAutoFix, retryAttempt, escalationMode, availableHarnesses } = params;

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

  if (retryAttempt) {
    prompt += `\n\n<retry_attempt>${retryAttempt.current} of ${retryAttempt.max}</retry_attempt>`;
  }

  if (escalationMode) {
    // Retries are exhausted (or the LLM chose to stop). Decide how to escalate.
    const harnessList = (availableHarnesses && availableHarnesses.length > 0)
      ? availableHarnesses.join(", ")
      : "claude, codex, gemini, kimi, opencode";
    prompt += `

<instructions>
The retry budget for this job is exhausted; it still fails. Do NOT retry again.
Decide how to escalate. A Telegram alert with the raw error will be sent regardless.

Available harnesses to suggest: ${harnessList}

Return a fenced JSON decision block:
\`\`\`json
{
  "action": "abandon | switch_harness",
  "diagnosis": "1-3 sentence root cause",
  "suggestedHarness": "one of the available harnesses (switch_harness only)",
  "reportMessage": "human-readable recommendation for the user",
  "confidence": 0.0-1.0
}
\`\`\`

Rules:
- "switch_harness" ONLY if the failure looks harness-specific (a different CLI would plausibly succeed); name the target in suggestedHarness. This is advisory — a human applies it via the job harness override.
- "abandon" if the failure is systemic/data/config and no harness would help.
</instructions>
</takeover_context>`;
    return prompt;
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
- "report" to stop retrying and hand off to escalation (systemic, unfixable, non-idempotent job, or confidence < 0.5)
- If consecutive_failures >= 3, prefer "report" unless you have a clear fix
- Prefer "report" early for jobs whose handler is NOT idempotent (re-running repeats side effects)
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

  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText);
      const action = parsed.action as TakeoverDecision["action"];
      if (action && ["retry", "fix_and_retry", "report", "abandon", "switch_harness"].includes(action)) {
        return {
          action,
          diagnosis: typeof parsed.diagnosis === "string" ? parsed.diagnosis : "Unknown",
          fixDescription: typeof parsed.fixDescription === "string" ? parsed.fixDescription : undefined,
          retryModifications: typeof parsed.retryModifications === "string" ? parsed.retryModifications : undefined,
          reportMessage: typeof parsed.reportMessage === "string" ? parsed.reportMessage : undefined,
          suggestedHarness: typeof parsed.suggestedHarness === "string" ? parsed.suggestedHarness : undefined,
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
        };
      }
    } catch {
      // Fall through to text-based extraction
    }
  }

  // Fallback: extract intent from plain text when LLM didn't return structured JSON
  return parseDecisionFromText(output);
}

function parseDecisionFromText(output: string): TakeoverDecision | null {
  const lower = output.toLowerCase();
  if (!lower || lower.length < 10) return null;

  // Detect action from keywords
  let action: TakeoverDecision["action"];
  if (/\b(switch(?:ing)?\s+(?:to\s+)?(?:harness|another|a different)|different harness|another harness)\b/.test(lower)) {
    action = "switch_harness";
  } else if (/\b(abandon|disable this job|give up on this job)\b/.test(lower)) {
    action = "abandon";
  } else if (/\b(fix(?:ed)?(?:\s+and)?\s+retr|edited|patched|modified the)\b/.test(lower)) {
    action = "fix_and_retry";
  } else if (/\b(retr(?:y|ied)|re-run|rerun|cleared.*is_running|recommend(?:ed)?\s+retry)\b/.test(lower)) {
    action = "retry";
  } else if (/\b(report|unfixable|systemic|manual|cannot|give up)\b/.test(lower)) {
    action = "report";
  } else {
    return null; // Can't determine intent
  }

  // Extract confidence if mentioned
  const confMatch = lower.match(/confidence[:\s]+(\d+(?:\.\d+)?)/);
  const confidence = confMatch?.[1] ? Math.min(parseFloat(confMatch[1]), 1.0) : 0.5;

  // Use the full output as diagnosis (truncated)
  const diagnosis = output.length > 300 ? output.slice(0, 297) + "..." : output;

  logger.info({ action, confidence }, "Parsed takeover decision from plain text (JSON fallback)");

  return { action, diagnosis, confidence };
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
  disableScheduledJob?: (jobId: string) => boolean;
}): Promise<TakeoverResult | null> {
  const { job, failedResult, runId, stateManager, bot, chatId, disableScheduledJob } = params;
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

    // Ensure CWD exists for takeover sessions
    const cwd = "/tmp/homer-takeover";
    mkdirSync(cwd, { recursive: true });

    // Run one LLM decision session. Pinned to Codex; falls back to Claude if Codex is down.
    const runDecisionSession = async (decisionPrompt: string, needsAutoFix: boolean): Promise<string | null> => {
      const requiredCapabilities: CapabilityRequirement[] = needsAutoFix
        ? [
            { capability: "code.edit", required: true, reason: "auto-fix failing job" },
            { capability: "tools.files.write", required: true, reason: "edit source files" },
            { capability: "tools.shell", required: true, reason: "run build/retry" },
          ]
        : [{ capability: "text.generate", required: true, reason: "diagnose-only report" }];
      for (const harness of ["codex", "claude"] as const) {
        try {
          const result = await executeResolvedHarness({
            source: "scheduler",
            mode: "scheduler-job",
            prompt: decisionPrompt,
            scope: { jobId },
            cwd,
            explicit: { harness },
            requiredCapabilities,
          });
          return result.output;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.error({ jobId, harness, error: msg }, "Takeover decision session failed");
        }
      }
      return null;
    };

    // Re-run the failing job once; always releases the is_running lock afterwards.
    const runJobRetry = async (): Promise<JobExecutionResult> => {
      try {
        return isInternal
          ? await executeInternalJob(job, { stateManager, bot, chatId, jobRunId: runId, disableScheduledJob })
          : await executeScheduledJob(job);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ jobId, error: msg }, "Takeover retry execution failed");
        return {
          jobId, jobName: job.config.name, sourceFile: job.sourceFile,
          startedAt: new Date(), completedAt: new Date(),
          success: false, output: "", error: msg, exitCode: 1, duration: 0,
        };
      } finally {
        try {
          stateManager.getDb().prepare(
            "UPDATE scheduled_job_state SET is_running = 0 WHERE job_id = ?"
          ).run(jobId);
        } catch {
          // Table may not exist or job state row may be missing
        }
      }
    };

    // ---- Retry loop: the LLM decides retry vs. stop, hard-capped at MAX_TAKEOVER_RETRIES ----
    let currentFailed = failedResult;
    let lastDecision: TakeoverDecision | undefined;
    let lastOutput = "";
    let retryResult: JobExecutionResult | undefined;
    let retriesAttempted = 0;

    for (let attempt = 1; attempt <= MAX_TAKEOVER_RETRIES; attempt++) {
      // Wall-clock guard — takeover retries run outside executeJob's hang watchdog.
      if (Date.now() - startTime > TAKEOVER_WALL_CLOCK_MS) {
        logger.warn({ jobId, attempt }, "Takeover wall-clock cap reached, escalating");
        break;
      }

      const prompt = buildTakeoverPrompt({
        job,
        failedResult: currentFailed,
        recentRuns,
        jobState: { consecutiveFailures, lastSuccessAt: jobState?.lastSuccessAt ?? null },
        handlerSource,
        dependencySource,
        fallbackLogs,
        allowAutoFix,
        retryAttempt: { current: attempt, max: MAX_TAKEOVER_RETRIES },
      });

      const output = await runDecisionSession(prompt, allowAutoFix);
      if (output === null) {
        logger.error({ jobId, attempt }, "Takeover decision session unavailable (codex + claude both failed)");
        break; // fall through to escalation
      }
      lastOutput = output;

      const decision = parseDecision(output);
      if (!decision) {
        logger.warn({ jobId, attempt, outputLength: output.length }, "Could not parse takeover decision");
        break;
      }
      lastDecision = decision;
      logger.info({ jobId, attempt, action: decision.action, confidence: decision.confidence, diagnosis: decision.diagnosis }, "Takeover decision");

      // LLM chose to stop retrying → escalate
      if (decision.action !== "retry" && decision.action !== "fix_and_retry") {
        break;
      }

      // Inter-retry backoff before the 2nd/3rd attempt (30s, 60s)
      if (attempt > 1) {
        const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt - 2), 120_000);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }

      retriesAttempted += 1;
      retryResult = await runJobRetry();
      recordTakeoverRun(stateManager, {
        jobRunId: runId,
        jobId,
        decision: decision.action,
        diagnosis: decision.diagnosis,
        fixDescription: decision.fixDescription,
        takeoverOutput: truncate(output, 10000),
        retrySuccess: retryResult.success ? 1 : 0,
        attemptNumber: attempt,
        durationMs: Date.now() - startTime,
      });

      if (retryResult.success) {
        return {
          decision,
          takeoverSessionOutput: output,
          retryResult,
          finalSuccess: true,
          duration: Date.now() - startTime,
          retriesAttempted,
        };
      }

      currentFailed = retryResult; // feed the latest failure into the next iteration
    }

    // ---- Escalation: retries exhausted or LLM stopped. Caller ALWAYS alerts. ----
    const escalationPrompt = buildTakeoverPrompt({
      job,
      failedResult: currentFailed,
      recentRuns,
      jobState: { consecutiveFailures, lastSuccessAt: jobState?.lastSuccessAt ?? null },
      handlerSource,
      dependencySource,
      fallbackLogs,
      allowAutoFix: false,
      escalationMode: true,
      availableHarnesses: ["claude", "codex", "gemini", "kimi", "opencode"],
    });

    const escalationOutput = await runDecisionSession(escalationPrompt, false);
    let escalation: TakeoverDecision | undefined;
    if (escalationOutput) {
      lastOutput = escalationOutput;
      escalation = parseDecision(escalationOutput) ?? undefined;
    }
    if (!escalation) {
      // Both LLMs unavailable/unparseable — synthesize so the caller still alerts with the raw error.
      escalation = {
        action: "abandon",
        diagnosis: lastDecision?.diagnosis ?? "Takeover LLM unavailable; job still failing after retries.",
        reportMessage: "Automatic recovery exhausted its retries and no harness suggestion could be produced.",
        confidence: 0,
      };
    }

    recordTakeoverRun(stateManager, {
      jobRunId: runId,
      jobId,
      decision: escalation.action,
      diagnosis: escalation.diagnosis,
      takeoverOutput: truncate(lastOutput, 10000),
      retrySuccess: null,
      attemptNumber: retriesAttempted + 1,
      durationMs: Date.now() - startTime,
    });

    return {
      decision: lastDecision ?? escalation,
      takeoverSessionOutput: lastOutput,
      retryResult,
      finalSuccess: false,
      duration: Date.now() - startTime,
      retriesAttempted,
      escalation,
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
  attemptNumber?: number;
  durationMs: number;
}): void {
  try {
    stateManager.getDb().prepare(`
      INSERT INTO failure_takeover_runs
        (job_run_id, job_id, decision, diagnosis, fix_description, takeover_output, retry_success, attempt_number, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.jobRunId,
      params.jobId,
      params.decision,
      params.diagnosis,
      params.fixDescription ?? null,
      params.takeoverOutput,
      params.retrySuccess,
      params.attemptNumber ?? 1,
      params.durationMs,
    );
  } catch (error) {
    // Table may not exist yet if migration hasn't run
    logger.warn({ error, jobId: params.jobId }, "Failed to record takeover run (migration may be pending)");
  }
}
