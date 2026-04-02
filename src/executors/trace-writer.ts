/**
 * Unified execution trace writer.
 *
 * Records every sub-agent invocation across scheduler and router paths.
 * Each row = one attempt in a fallback chain. chain_id groups attempts.
 */

// @ts-ignore
import type Database from "better-sqlite3";
import { logger } from "../utils/logger.js";
import type {
  FallbackRunResult,
  ExecutorAttemptResult,
  ExecutorKind,
} from "./fallback-orchestrator.js";
import { setHealthState, FAILURE_DISABLE_THRESHOLD, DISABLE_MS } from "./fallback-orchestrator.js";

// ── State ──

let _db: Database.Database | null = null;
let _insertStmt: Database.Statement | null = null;

export function initTraceWriter(db: Database.Database): void {
  _db = db;
  _insertStmt = db.prepare(`
    INSERT INTO execution_traces
      (id, chain_id, attempt_number, job_id, source, executor, model,
       success, duration_ms, exit_code, error_type, error_summary, fallback_used,
       scheduled_run_id, trace_kind, step_name, prompt_hash, git_commit, harness_version_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
}

let _gitCommit: string | null = null;

/** Cache the current git commit hash at startup */
export function setGitCommit(commit: string): void {
  _gitCommit = commit;
}

function traceId(): string {
  return `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Write ──

export interface TraceJobContext {
  jobId: string;
  source: "scheduler" | "router" | "runtime" | "queue";
  scheduledRunId?: number;
}

export function writeChainTrace<T extends ExecutorAttemptResult>(
  fallbackResult: FallbackRunResult<T>,
  ctx: TraceJobContext,
): void {
  if (!_db || !_insertStmt) return;

  try {
    const chainId = `chain_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const { attempts, result, executorUsed, fallbackUsed, failed } = fallbackResult;

    // Write failed attempts (already in attempts array)
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i]!;
      _insertStmt.run(
        traceId(), chainId, i + 1, ctx.jobId, ctx.source,
        a.executor, null, 0, a.durationMs, a.exitCode,
        a.errorType, (a.errorSummary ?? "").slice(0, 500) || null,
        i > 0 ? 1 : 0, ctx.scheduledRunId ?? null,
        "chain", null, null, _gitCommit, null,
      );
    }

    // Write the final successful attempt (failed attempts already in the loop above)
    if (result && !failed) {
      _insertStmt.run(
        traceId(), chainId, attempts.length + 1, ctx.jobId, ctx.source,
        executorUsed, null, 1, result.duration, result.exitCode,
        null, null, fallbackUsed ? 1 : 0, ctx.scheduledRunId ?? null,
        "chain", null, null, _gitCommit, null,
      );
    }
  } catch (err) {
    logger.warn({ error: err, jobId: ctx.jobId }, "Failed to write execution trace");
  }
}

// ── Internal job traces ──

export interface InternalTraceData {
  jobId: string;
  jobName: string;
  executor: string;
  model?: string;
  success: boolean;
  durationMs: number;
  exitCode: number;
  error?: string;
  scheduledRunId?: number;
  harnessVersionId?: string;
}

export function writeInternalTrace(data: InternalTraceData): void {
  if (!_db || !_insertStmt) return;

  try {
    const chainId = `int_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    _insertStmt.run(
      traceId(), chainId, 1, data.jobId, "scheduler",
      data.executor, data.model ?? null, data.success ? 1 : 0, data.durationMs, data.exitCode,
      data.success ? null : "internal", data.error ? data.error.slice(0, 500) : null,
      0, data.scheduledRunId ?? null,
      "job", null, null, _gitCommit, data.harnessVersionId ?? null,
    );
  } catch (err) {
    logger.warn({ error: err, jobId: data.jobId }, "Failed to write internal execution trace");
  }
}

// ── Per-step traces (for instrumented pipelines like idea-synthesizer) ──

export interface StepTraceData {
  jobId: string;
  chainId: string;         // parent chain_id to group steps under one run
  stepName: string;        // e.g. "triage", "synthesize", "critique", "enrich"
  executor: string;        // e.g. "claude", "gemini-api"
  model?: string;          // e.g. "sonnet", "opus", "flash"
  success: boolean;
  durationMs: number;
  promptHash?: string;
  scheduledRunId?: number;
  harnessVersionId?: string;
  error?: string;
}

export function writeStepTrace(data: StepTraceData): void {
  if (!_db || !_insertStmt) return;

  try {
    _insertStmt.run(
      traceId(), data.chainId, 1, data.jobId, "scheduler",
      data.executor, data.model ?? null, data.success ? 1 : 0, data.durationMs, 0,
      data.success ? null : "step_failure", data.error ? data.error.slice(0, 500) : null,
      0, data.scheduledRunId ?? null,
      "step", data.stepName, data.promptHash ?? null, _gitCommit, data.harnessVersionId ?? null,
    );
  } catch (err) {
    logger.warn({ error: err, jobId: data.jobId, step: data.stepName }, "Failed to write step trace");
  }
}

// ── HEALTH rehydration ──

export function rehydrateHealth(db: Database.Database): void {
  try {
    const cutoffMs = DISABLE_MS; // 30 minutes
    const cutoff = new Date(Date.now() - cutoffMs).toISOString().replace("T", " ").slice(0, 19);

    // Find executors whose last N traces in the window are all failures
    const rows = db.prepare(`
      WITH recent AS (
        SELECT executor, success,
               ROW_NUMBER() OVER (PARTITION BY executor ORDER BY created_at DESC) as rn
        FROM execution_traces
        WHERE created_at > ?
      )
      SELECT executor, MAX(created_at) as last_fail
      FROM execution_traces
      WHERE success = 0 AND created_at > ?
        AND executor IN (
          SELECT executor FROM recent
          WHERE rn <= ? AND success = 0
          GROUP BY executor
          HAVING COUNT(*) = ?
        )
      GROUP BY executor
    `).all(cutoff, cutoff, FAILURE_DISABLE_THRESHOLD, FAILURE_DISABLE_THRESHOLD) as Array<{
      executor: string;
      last_fail: string;
    }>;

    for (const row of rows) {
      const lastFailTime = new Date(row.last_fail.replace(" ", "T") + "Z").getTime();
      const disableUntil = lastFailTime + cutoffMs;
      if (disableUntil > Date.now()) {
        setHealthState(row.executor as ExecutorKind, {
          consecutiveFailures: FAILURE_DISABLE_THRESHOLD,
          disabledUntil: disableUntil,
        });
        logger.info(
          { executor: row.executor, disableUntil: new Date(disableUntil).toISOString() },
          "Rehydrated executor health state from traces",
        );
      }
    }
  } catch (err) {
    logger.warn({ error: err }, "Failed to rehydrate health from traces");
  }
}

// ── Retention ──

export function purgeOldTraces(db?: Database.Database): number {
  const d = db ?? _db;
  if (!d) return 0;
  try {
    const result = d.prepare(
      `DELETE FROM execution_traces WHERE created_at < datetime('now', '-90 days')`,
    ).run();
    return result.changes;
  } catch {
    return 0;
  }
}

// ── Query helpers (for future MCP tool / self-correcting harness) ──

export function getTraceStats(
  db: Database.Database,
  days = 7,
): Array<{ executor: string; total: number; successes: number; avg_duration_ms: number }> {
  try {
    return db.prepare(`
      SELECT
        executor,
        COUNT(*) as total,
        SUM(success) as successes,
        ROUND(AVG(duration_ms)) as avg_duration_ms
      FROM execution_traces
      WHERE created_at > datetime('now', ?)
      GROUP BY executor
      ORDER BY total DESC
    `).all(`-${days} days`) as Array<{
      executor: string;
      total: number;
      successes: number;
      avg_duration_ms: number;
    }>;
  } catch {
    return [];
  }
}
