import { readFileSync, existsSync } from "fs";
import { logger } from "../utils/logger.js";
import { withSlot } from "../executors/concurrency.js";
import type { RegisteredJob, JobExecutionResult, ProgressCallback, ProgressEvent } from "./types.js";
import { LANE_CWD, DEFAULT_JOB_TIMEOUT } from "./types.js";
import { executeKimiCLI } from "../executors/kimi-cli.js";
import { executeCodexCLI } from "../executors/codex-cli.js";
import { executeClaudeCommand } from "../executors/claude.js";
import Database from "better-sqlite3";
import { PATHS } from "../config/paths.js";
import type { HarnessExecutor } from "../commands/harness-catalog.js";
import {
  mergeHarnessProfiles,
  requireInternalJobHarnessBaseline,
} from "./harness-baselines.js";

/**
 * Lazy read-only connection to read the global harness default (migration 104) without
 * spinning up a full StateManager (which would re-run migrations). Conservative: any
 * failure → "claude". Connection lives for the daemon lifetime.
 */
let _harnessDb: Database.Database | null = null;
function harnessDefault(): { executor: ExecutorKind; model: string | null } {
  try {
    if (!_harnessDb) _harnessDb = new Database(PATHS.db, { readonly: true });
    const row = _harnessDb
      .prepare("SELECT executor, model FROM harness_default WHERE id = 1")
      .get() as { executor: HarnessExecutor; model: string | null } | undefined;
    if (row?.executor && isExecutorKind(row.executor)) {
      return { executor: row.executor, model: row.model };
    }
    return { executor: "claude", model: "opus[1m]" };
  } catch {
    return { executor: "claude", model: "opus[1m]" };
  }
}

function jobHarnessOverride(jobId: string): HarnessSelection | undefined {
  try {
    if (!_harnessDb) _harnessDb = new Database(PATHS.db, { readonly: true });
    const row = _harnessDb
      .prepare("SELECT executor, model FROM job_harness_override WHERE job_id = ?")
      .get(jobId) as { executor: HarnessExecutor; model: string | null } | undefined;
    if (row?.executor && isExecutorKind(row.executor)) {
      return { executor: row.executor, model: row.model };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
import { RESEARCH_ONLY_PREFIX, executeOpenCodeCLI } from "../executors/opencode-cli.js";
import { resolveHarnessSelection } from "../harness/resolution/resolver.js";
import { createSqliteHarnessSelectionStore, type HarnessSelectionStore } from "../harness/resolution/store.js";
import {
  runWithFallbackChain,
  DEFAULT_FALLBACK_ORDER,
  MEMORY_FALLBACK_ORDER,
  type ExecutorKind,
} from "../executors/fallback-orchestrator.js";
import { negotiateHarnessAttempts } from "../harness/negotiation.js";
import type { ResolvedHarnessPlan } from "../harness/resolution/types.js";
import { writeChainTrace } from "../executors/trace-writer.js";
import { scanContent } from "../skills/guard.js";

export interface HarnessExecutorOptions {
  codex?: {
    reasoningEffort?: string;
  };
  opencode?: {
    forceOpenCode?: boolean;
    researchOnly?: boolean;
    agent?: string;
    yolo?: boolean;
    sandbox?: boolean;
  };
  kimi?: {
    yolo?: boolean;
  };
}

export interface HarnessSelection {
  executor: ExecutorKind;
  model: string | null;
  cwdOverride?: string;
  timeoutOverride?: number;
  fallbackChain?: ExecutorKind[];
  fallbackModels?: Partial<Record<ExecutorKind, string | null>>;
  executorOptions?: HarnessExecutorOptions;
}

export type InternalHarnessCallProfile = Partial<HarnessSelection>;

export interface RunJobHarnessOptions extends InternalHarnessCallProfile {
  startedAt: Date;
  onProgress?: ProgressCallback;
  baseline?: HarnessSelection;
  baselineSource?: "file" | "internal-registry" | "global" | "override";
  emitCompletedEvent?: boolean;
  singleExecutor?: ExecutorKind;
  skipDiagnosis?: boolean;
  scheduledRunId?: number;
  memoryJob?: boolean;
  signal?: AbortSignal;
}

type ExecutorDispatchOptions = {
  queryOverride?: string;
  emitCompletedEvent?: boolean;
  timeoutOverride?: number;
  modelOverride?: string | null;
  cwdOverride?: string;
  signal?: AbortSignal;
  executorOptions?: HarnessExecutorOptions;
};

function isExecutorKind(executor: string): executor is ExecutorKind {
  return executor === "claude" || executor === "gemini" || executor === "codex" || executor === "kimi" || executor === "opencode";
}

/**
 * Load context files and combine into a single string
 */
function loadContextFiles(files: string[]): string {
  const contents: string[] = [];
  for (const file of files) {
    const path = file.startsWith("~") ? file.replace("~", process.env.HOME ?? "") : file;
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        contents.push(`# Context from ${file}\n\n${content}`);
      } catch (err) {
        logger.warn({ file, error: err }, "Failed to read context file");
      }
    } else {
      logger.debug({ file }, "Context file not found, skipping");
    }
  }
  return contents.join("\n\n---\n\n");
}

function isMemoryJob(job: RegisteredJob): boolean {
  const id = job.config.id.toLowerCase();
  const query = job.config.query.toLowerCase();
  return (
    id.includes("memory") ||
    id.includes("daily-log") ||
    query.includes("/nightly-memory") ||
    query.includes("memory/daily")
  );
}

/**
 * Execute a Kimi job via Kimi CLI (long-context, free tier)
 */
async function executeKimiJob(
  job: RegisteredJob,
  startedAt: Date,
  onProgress?: ProgressCallback,
  options?: ExecutorDispatchOptions
): Promise<JobExecutionResult> {
  const { config, sourceFile } = job;
  const timeout = options?.timeoutOverride ?? config.timeout ?? 1200000; // 20 minutes default for kimi
  const cwd = options?.cwdOverride ?? LANE_CWD[config.lane] ?? LANE_CWD.default ?? process.cwd();
  const emitCompleted = options?.emitCompletedEvent !== false;
  const query = options?.queryOverride ?? config.query;

  // Load context files if specified
  const contextPrompt = config.contextFiles?.length
    ? loadContextFiles(config.contextFiles)
    : "";

  logger.info(
    { jobId: config.id, executor: "kimi-cli", queryLength: query.length },
    "Executing Kimi CLI job"
  );

  try {
    const result = await executeKimiCLI(query, contextPrompt, {
      timeout,
      yolo: options?.executorOptions?.kimi?.yolo ?? true,
      workDir: cwd,
      model: options?.modelOverride ?? undefined,
      signal: options?.signal,
    });

    const completedAt = new Date();
    const duration = completedAt.getTime() - startedAt.getTime();
    const success = result.exitCode === 0;

    // Emit completed event
    if (emitCompleted) {
      onProgress?.({
        type: "completed",
        jobId: config.id,
        jobName: config.name,
        timestamp: completedAt,
        message: success
          ? `✅ Completed: ${config.name} (${Math.round(duration / 1000)}s, Kimi CLI)`
          : `❌ Failed: ${config.name}`,
        details: { duration, success },
      });
    }

    logger.info(
      {
        jobId: config.id,
        success,
        duration,
        model: result.model,
      },
      "Kimi CLI job completed"
    );

    return {
      jobId: config.id,
      jobName: config.name,
      sourceFile,
      startedAt,
      completedAt,
      success,
      output: result.output,
      error: success ? undefined : result.output,
      exitCode: result.exitCode,
      duration,
    };
  } catch (error) {
    const completedAt = new Date();
    const duration = completedAt.getTime() - startedAt.getTime();
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (emitCompleted) {
      onProgress?.({
        type: "completed",
        jobId: config.id,
        jobName: config.name,
        timestamp: completedAt,
        message: `❌ Failed: ${config.name}`,
        details: { duration, success: false },
      });
    }

    logger.error({ jobId: config.id, error: errorMessage }, "Kimi CLI job failed");

    return {
      jobId: config.id,
      jobName: config.name,
      sourceFile,
      startedAt,
      completedAt,
      success: false,
      output: "",
      error: errorMessage,
      exitCode: 1,
      duration,
    };
  }
}

/**
 * Execute a Gemini-lane job.
 * Flash- and pro-tagged models run on opencode Gemini 3.5 Flash (High).
 * Non-Gemini models fall back to Claude Sonnet.
 */
async function executeGeminiJob(
  job: RegisteredJob,
  startedAt: Date,
  onProgress?: ProgressCallback,
  options?: ExecutorDispatchOptions
): Promise<JobExecutionResult> {
  const { config, sourceFile } = job;
  const timeout = options?.timeoutOverride ?? config.timeout ?? 1200000;
  const emitCompleted = options?.emitCompletedEvent !== false;
  const query = options?.queryOverride ?? config.query;
  const model = options?.modelOverride ?? config.model ?? "sonnet";
  const isGeminiNative = model.includes("flash") || model.includes("gemini") || model.includes("pro");

  const contextPrompt = config.contextFiles?.length
    ? loadContextFiles(config.contextFiles)
    : "";

  // Both flash- and pro-tagged jobs now run on opencode Gemini 3.5 Flash (High).
  const executorLabel = isGeminiNative ? "gemini-flash" : "claude-sonnet";

  logger.info(
    { jobId: config.id, executor: executorLabel, model, queryLength: query.length },
    `Executing Gemini-lane job via ${executorLabel}`
  );

  try {
    let output: string;
    let exitCode: number;

    if (isGeminiNative) {
      const fullPrompt = contextPrompt
        ? `Context:\n${contextPrompt}\n\n---\n\nTask:\n${query}`
        : query;

      // Both Flash and Pro scheduled jobs run on opencode Flash 3.5 (High).
      // forceOpenCode bypasses the legacy agy redirect inside executeOpenCodeCLI.
      const result = await executeOpenCodeCLI(fullPrompt, "", {
        model: "google/gemini-3.5-flash",
        timeout,
        forceOpenCode: true,
        researchOnly: true,
        runId: config.id,
        signal: options?.signal,
        cwd: options?.cwdOverride,
      });
      output = result.output;
      exitCode = result.exitCode;
    } else {
      // Non-Gemini models route to Claude Sonnet (existing behavior)
      const cwd = options?.cwdOverride ?? LANE_CWD[config.lane] ?? LANE_CWD.default ?? process.cwd();
      const fullQuery = contextPrompt
        ? RESEARCH_ONLY_PREFIX + `Context:\n${contextPrompt}\n\n---\n\nTask:\n${query}`
        : RESEARCH_ONLY_PREFIX + query;
      const result = await executeClaudeCommand(fullQuery, {
        timeout,
        cwd,
        model: "sonnet",
        signal: options?.signal,
      });
      output = result.output;
      exitCode = result.exitCode;
    }

    const completedAt = new Date();
    const duration = completedAt.getTime() - startedAt.getTime();
    const success = exitCode === 0;

    if (emitCompleted) {
      onProgress?.({
        type: "completed",
        jobId: config.id,
        jobName: config.name,
        timestamp: completedAt,
        message: success
          ? `✅ Completed: ${config.name} (${Math.round(duration / 1000)}s, ${executorLabel})`
          : `❌ Failed: ${config.name}`,
        details: { duration, success },
      });
    }

    logger.info(
      { jobId: config.id, success, duration, exitCode },
      `Gemini-lane job completed via ${executorLabel}`
    );

    return {
      jobId: config.id,
      jobName: config.name,
      sourceFile,
      startedAt,
      completedAt,
      success,
      output: output || "(No output)",
      error: success ? undefined : output,
      exitCode,
      duration,
    };
  } catch (error) {
    const completedAt = new Date();
    const duration = completedAt.getTime() - startedAt.getTime();
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (emitCompleted) {
      onProgress?.({
        type: "completed",
        jobId: config.id,
        jobName: config.name,
        timestamp: completedAt,
        message: `❌ Failed: ${config.name}`,
        details: { duration, success: false },
      });
    }

    logger.error({ jobId: config.id, error: errorMessage }, `Gemini-lane job failed (${executorLabel})`);

    return {
      jobId: config.id,
      jobName: config.name,
      sourceFile,
      startedAt,
      completedAt,
      success: false,
      output: "",
      error: errorMessage,
      exitCode: 1,
      duration,
    };
  }
}

/**
 * Execute a scheduled job on the opencode GLM-5.2 edit harness.
 * Edit-capable (researchOnly:false + build agent + skip-perms), unlike executeGeminiJob
 * which is pinned to the Gemini Flash research path.
 */
async function executeOpenCodeJob(
  job: RegisteredJob,
  startedAt: Date,
  onProgress?: ProgressCallback,
  options?: ExecutorDispatchOptions
): Promise<JobExecutionResult> {
  const { config, sourceFile } = job;
  const timeout = options?.timeoutOverride ?? config.timeout ?? 1200000;
  const emitCompleted = options?.emitCompletedEvent !== false;
  const query = options?.queryOverride ?? config.query;
  const model = options?.modelOverride ?? config.model;
  const contextPrompt = config.contextFiles?.length ? loadContextFiles(config.contextFiles) : "";
  const cwd = options?.cwdOverride ?? LANE_CWD[config.lane] ?? LANE_CWD.default ?? process.cwd();

  logger.info(
    { jobId: config.id, executor: "opencode", model, queryLength: query.length },
    `Executing opencode GLM job`
  );

  try {
    const fullPrompt = contextPrompt
      ? `Context:\n${contextPrompt}\n\n---\n\nTask:\n${query}`
      : query;
    const result = await executeOpenCodeCLI(fullPrompt, "", {
      model,
      timeout,
      forceOpenCode: options?.executorOptions?.opencode?.forceOpenCode ?? true,
      researchOnly: options?.executorOptions?.opencode?.researchOnly ?? false,
      agent: options?.executorOptions?.opencode?.agent ?? "build",
      cwd,
      yolo: options?.executorOptions?.opencode?.yolo ?? true,
      sandbox: options?.executorOptions?.opencode?.sandbox ?? true,
      runId: config.id,
      signal: options?.signal,
    });
    const completedAt = new Date();
    const duration = completedAt.getTime() - startedAt.getTime();
    const success = result.exitCode === 0;

    if (emitCompleted) {
      onProgress?.({
        type: "completed",
        jobId: config.id,
        jobName: config.name,
        timestamp: completedAt,
        message: success
          ? `✅ Completed: ${config.name} (${Math.round(duration / 1000)}s, opencode-glm)`
          : `❌ Failed: ${config.name}`,
        details: { duration, success },
      });
    }

    return {
      jobId: config.id,
      jobName: config.name,
      sourceFile,
      startedAt,
      completedAt,
      success,
      output: result.output || "(No output)",
      error: success ? undefined : result.output,
      exitCode: result.exitCode,
      duration,
    };
  } catch (error) {
    const completedAt = new Date();
    const duration = completedAt.getTime() - startedAt.getTime();
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (emitCompleted) {
      onProgress?.({
        type: "completed",
        jobId: config.id,
        jobName: config.name,
        timestamp: completedAt,
        message: `❌ Failed: ${config.name}`,
        details: { duration, success: false },
      });
    }
    logger.error({ jobId: config.id, error: errorMessage }, `opencode GLM job failed`);
    return {
      jobId: config.id,
      jobName: config.name,
      sourceFile,
      startedAt,
      completedAt,
      success: false,
      output: "",
      error: errorMessage,
      exitCode: 1,
      duration,
    };
  }
}

/**
 * Execute a Codex job via Codex CLI
 */
async function executeCodexJob(
  job: RegisteredJob,
  startedAt: Date,
  onProgress?: ProgressCallback,
  options?: ExecutorDispatchOptions
): Promise<JobExecutionResult> {
  const { config, sourceFile } = job;
  const timeout = options?.timeoutOverride ?? config.timeout ?? 1800000;
  const cwd = options?.cwdOverride ?? LANE_CWD[config.lane] ?? LANE_CWD.default ?? process.cwd();
  const emitCompleted = options?.emitCompletedEvent !== false;
  const query = options?.queryOverride ?? config.query;

  const contextPrompt = config.contextFiles?.length
    ? loadContextFiles(config.contextFiles)
    : "";

  const fullQuery = contextPrompt
    ? `Context:\n${contextPrompt}\n\n---\n\nTask:\n${query}`
    : query;

  logger.info(
    { jobId: config.id, executor: "codex", queryLength: fullQuery.length },
    "Executing Codex job"
  );

  try {
    const result = await executeCodexCLI(fullQuery, {
      cwd,
      timeout,
      model: options?.modelOverride ?? undefined,
      signal: options?.signal,
      reasoningEffort: options?.executorOptions?.codex?.reasoningEffort,
    });
    const completedAt = new Date();
    const duration = completedAt.getTime() - startedAt.getTime();
    const success = result.exitCode === 0;

    if (emitCompleted) {
      onProgress?.({
        type: "completed",
        jobId: config.id,
        jobName: config.name,
        timestamp: completedAt,
        message: success
          ? `✅ Completed: ${config.name} (${Math.round(duration / 1000)}s, Codex)`
          : `❌ Failed: ${config.name}`,
        details: { duration, success },
      });
    }

    return {
      jobId: config.id,
      jobName: config.name,
      sourceFile,
      startedAt,
      completedAt,
      success,
      output: result.output,
      error: success ? undefined : result.output,
      exitCode: result.exitCode,
      duration,
    };
  } catch (error) {
    const completedAt = new Date();
    const duration = completedAt.getTime() - startedAt.getTime();
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (emitCompleted) {
      onProgress?.({
        type: "completed",
        jobId: config.id,
        jobName: config.name,
        timestamp: completedAt,
        message: `❌ Failed: ${config.name}`,
        details: { duration, success: false },
      });
    }

    return {
      jobId: config.id,
      jobName: config.name,
      sourceFile,
      startedAt,
      completedAt,
      success: false,
      output: "",
      error: errorMessage,
      exitCode: 1,
      duration,
    };
  }
}

/**
 * Execute a scheduled job via Claude CLI with optional progress streaming
 */
async function executeClaudeJob(
  job: RegisteredJob,
  startedAt: Date,
  onProgress?: ProgressCallback,
  options?: ExecutorDispatchOptions
): Promise<JobExecutionResult> {
  const { config, sourceFile } = job;
  const timeout = options?.timeoutOverride ?? config.timeout ?? DEFAULT_JOB_TIMEOUT;
  const cwd = options?.cwdOverride ?? LANE_CWD[config.lane] ?? LANE_CWD.default;
  const model = options?.modelOverride ?? config.model ?? "sonnet";
  const emitCompleted = options?.emitCompletedEvent !== false;
  const query = options?.queryOverride ?? config.query;

  logger.info(
    {
      jobId: config.id,
      name: config.name,
      lane: config.lane,
      cwd,
      timeout,
      model,
    },
    "Executing Claude scheduled job"
  );

  // Load context files if specified
  const contextPrompt = config.contextFiles?.length
    ? loadContextFiles(config.contextFiles)
    : "";

  // Delegate to the canonical Claude executor (src/executors/claude.ts) rather
  // than maintaining a divergent spawn/stream-parse copy here. Opt-in flags
  // preserve scheduler semantics: clean output (stderr separated so JSON-parsing
  // stages aren't polluted), prefer-longest-text (the meta-comment guard), and
  // the homer-scheduler entrypoint. This consolidation kills the args/env-drift
  // bug class — the `--`-frontmatter bug lived only in this former duplicate.
  const activeTools = new Set<string>();
  const emitProgress = (event: ProgressEvent) => {
    try {
      onProgress?.(event);
    } catch (err) {
      logger.warn({ error: err }, "Failed to emit progress event");
    }
  };

  try {
    const result = await executeClaudeCommand(query, {
      cwd: cwd ?? process.cwd(),
      model,
      signal: options?.signal,
      timeout,
      appendSystemPrompt: contextPrompt || undefined,
      entrypoint: "homer-scheduler",
      preferLongestText: true,
      cleanOutput: true,
      onEvent: (ev) => {
        // Clear on tool_result so a repeated tool (second Read, second Bash…)
        // re-emits progress later in a long job, matching the former parser.
        if (ev.type === "tool_result") { activeTools.clear(); return; }
        if (ev.type !== "tool_use" || !ev.tool) return;
        if (activeTools.has(ev.tool)) return;
        activeTools.add(ev.tool);
        emitProgress({
          type: ev.tool === "Task" ? "subagent_start" : "tool_use",
          jobId: config.id,
          jobName: config.name,
          timestamp: new Date(),
          message: ev.label,
          details: { tool: ev.tool },
        });
      },
    });

    const completedAt = new Date();
    const duration = completedAt.getTime() - startedAt.getTime();

    // Canonical returns "(No output)" when nothing was produced; normalize to
    // empty so the minOutputLength guard and the orchestrator's fast-empty
    // classification (#5) see a truly empty result.
    let output = (result.output ?? "").trim();
    if (output === "(No output)") output = "";
    const stderrText = (result.stderr ?? "").trim();

    let success = result.exitCode === 0;
    let errorMessage: string | undefined = success ? undefined : `Exit code ${result.exitCode}`;

    // minOutputLength guard: prevents the "meta-comment as deliverable" silent
    // failure. Only flips success→failure; never the reverse.
    const isEmptyState = !!config.emptyStateMarker && output.includes(config.emptyStateMarker);
    let failedMinOutputLength = false;
    if (success && config.minOutputLength && output.length < config.minOutputLength && !isEmptyState) {
      success = false;
      failedMinOutputLength = true;
      errorMessage =
        `Output too short (${output.length} chars, expected ≥ ${config.minOutputLength}). ` +
        `Likely the executor returned a meta-comment instead of the deliverable.`;
      logger.warn(
        { jobId: config.id, outputLength: output.length, minOutputLength: config.minOutputLength, outputPreview: output.slice(0, 200) },
        "Job flagged failed by minOutputLength guard"
      );
    }

    // Keep stderr in the error field (not output) so JSON-parsing stages stay
    // clean, while the fallback orchestrator can still read it to classify.
    if (stderrText) {
      errorMessage = errorMessage ? `${errorMessage}\n\nStderr:\n${stderrText}` : stderrText;
    }

    if (emitCompleted) {
      emitProgress({
        type: "completed",
        jobId: config.id,
        jobName: config.name,
        timestamp: completedAt,
        message: success
          ? `✅ Completed: ${config.name} (${Math.round(duration / 1000)}s)`
          : `❌ Failed: ${config.name}`,
        details: { duration, success },
      });
    }

    logger.info(
      { jobId: config.id, success, duration, exitCode: result.exitCode, outputLength: output.length },
      "Scheduled job completed"
    );

    return {
      jobId: config.id,
      jobName: config.name,
      sourceFile,
      startedAt,
      completedAt,
      success,
      output: output || "(No output)",
      error: errorMessage,
      exitCode: failedMinOutputLength && result.exitCode === 0 ? 1 : result.exitCode ?? 1,
      duration,
    };
  } catch (err) {
    // executeClaudeCommand rejects only on timeout ("...timed out...") or abort
    // ("Cancelled"). Map both to a graceful failed JobExecutionResult.
    const completedAt = new Date();
    const duration = completedAt.getTime() - startedAt.getTime();
    const msg = err instanceof Error ? err.message : String(err);
    const aborted = /cancelled/i.test(msg);
    const timedOut = !aborted && /timed out/i.test(msg);
    const errorMessage = aborted
      ? "Job aborted by signal"
      : timedOut
        ? `Job timed out after ${timeout / 1000}s`
        : msg;

    if (emitCompleted) {
      emitProgress({
        type: "completed",
        jobId: config.id,
        jobName: config.name,
        timestamp: completedAt,
        message: `❌ Failed: ${config.name}`,
        details: { duration, success: false },
      });
    }

    logger.info(
      { jobId: config.id, success: false, duration, exitCode: 1, timedOut, outputLength: 0 },
      "Scheduled job completed"
    );

    return {
      jobId: config.id,
      jobName: config.name,
      sourceFile,
      startedAt,
      completedAt,
      success: false,
      output: "(No output)",
      error: errorMessage,
      exitCode: 1,
      duration,
    };
  }
}

function emitHarnessCompletion(
  job: RegisteredJob,
  result: JobExecutionResult,
  executor: ExecutorKind,
  onProgress?: ProgressCallback,
): void {
  onProgress?.({
    type: "completed",
    jobId: job.config.id,
    jobName: job.config.name,
    timestamp: result.completedAt ?? new Date(),
    message: result.success
      ? `✅ Completed: ${job.config.name} (${Math.round(result.duration / 1000)}s, ${executor})`
      : `❌ Failed: ${job.config.name} (${executor})`,
    details: { duration: result.duration, success: result.success },
  });
}

function mergeExecutorOptions(
  baseline?: HarnessExecutorOptions,
  override?: HarnessExecutorOptions,
): HarnessExecutorOptions | undefined {
  if (!baseline && !override) return undefined;
  return {
    codex: { ...baseline?.codex, ...override?.codex },
    opencode: { ...baseline?.opencode, ...override?.opencode },
    kimi: { ...baseline?.kimi, ...override?.kimi },
  };
}

function buildChain(
  primary: ExecutorKind,
  baseChain: ExecutorKind[],
): ExecutorKind[] {
  return [primary, ...baseChain.filter((executor) => executor !== primary)];
}

let _harnessStore: HarnessSelectionStore | null = null;
function harnessSelectionStore(): HarnessSelectionStore | null {
  try {
    if (!_harnessStore) {
      if (!_harnessDb) _harnessDb = new Database(PATHS.db, { readonly: true });
      _harnessStore = createSqliteHarnessSelectionStore(_harnessDb);
    }
    return _harnessStore;
  } catch {
    return null;
  }
}

/**
 * CUTOVER: scheduler SELECTION (primary harness + pinned model) is now purely DB-driven —
 * the single resolver decides: job row → global → system-default. The code/file baseline is
 * ONLY an executor-agnostic runtime profile (cwd/timeout/executorOptions/fallbackModels); its
 * executor/model no longer select. Deliberate per-job tuning lives as seeded job rows
 * (see harness-baseline-seed.ts), so "switch all → X" moves everything by clearing those rows.
 *
 * The old baseline-as-selector bridge (which made a flip of the global default a no-op for
 * tuned jobs) is deleted. Any resolver/store failure falls back to a legacy physical read so a
 * pre-migration DB or a transient read error can never crash or mis-route a scheduled job.
 */
function resolveSchedulerPrimary(
  jobId: string,
  globalDefault: { executor: ExecutorKind; model: string | null },
): { primary: ExecutorKind; pinnedModel: string | null; modelPinnedExecutor: ExecutorKind | undefined; plan?: ResolvedHarnessPlan } {
  // Legacy safety fallback (store unavailable / pre-108 DB): job override → global → hard claude.
  const legacy = () => {
    const concrete = jobHarnessOverride(jobId) ?? globalDefault;
    const primary = concrete?.executor ?? "claude";
    return {
      primary,
      pinnedModel: concrete?.model ?? null,
      modelPinnedExecutor: concrete ? primary : undefined,
    };
  };

  const store = harnessSelectionStore();
  if (!store) return legacy();

  try {
    const plan = resolveHarnessSelection(
      { requestId: `sched-${jobId}`, source: "scheduler", scope: { jobId } },
      store,
    );
    return {
      primary: plan.selection.harness,
      pinnedModel: plan.selection.model,
      modelPinnedExecutor: plan.selection.harness,
      plan,
    };
  } catch {
    return legacy();
  }
}

/**
 * Build the ordered fallback chain via the capability negotiator (cutover). The negotiator decides
 * the attempt list from the resolved plan + capability descriptors; `compatibilityOrder` only ranks
 * otherwise-equivalent harnesses, preserving today's fallback order. With no required capabilities
 * (the common scheduler case) this reduces to `buildChain(primary, compatibilityOrder)` — so it is
 * behavior-neutral today while routing the live path through the negotiator. Falls back to the plain
 * chain on any negotiator error.
 */
function negotiatedSchedulerChain(
  plan: ResolvedHarnessPlan,
  compatibilityOrder: ExecutorKind[],
  primary: ExecutorKind,
): ExecutorKind[] {
  try {
    const attemptPlan = negotiateHarnessAttempts({
      resolved: plan,
      mode: "scheduler-job",
      compatibilityOrder: compatibilityOrder as ResolvedHarnessPlan["selection"]["harness"][],
      allowDegradation: true,
    });
    const seen = new Set<ExecutorKind>();
    const chain: ExecutorKind[] = [];
    for (const h of [attemptPlan.primary.harness, ...attemptPlan.attempts.map((a) => a.harness)] as ExecutorKind[]) {
      if (!seen.has(h)) { seen.add(h); chain.push(h); }
    }
    return chain.length ? chain : buildChain(primary, compatibilityOrder);
  } catch {
    return buildChain(primary, compatibilityOrder);
  }
}

export async function runJobHarness(
  job: RegisteredJob,
  query: string,
  options: RunJobHarnessOptions,
): Promise<JobExecutionResult> {
  const { config } = job;
  const memoryJob = options.memoryJob ?? isMemoryJob(job);
  const override = jobHarnessOverride(config.id);
  // A DB override swaps executor+model but must PRESERVE the registry/file
  // baseline's executor-agnostic infra (cwdOverride, timeoutOverride,
  // executorOptions, fallbackChain) — otherwise an overridden staged internal
  // job (e.g. nightly-code-push) would lose its cwd=homerRoot. For direct jobs
  // options.baseline is just {executor,model} (or undefined), so this merge is
  // equivalent to a replace.
  const explicitProfile = override
    ? {
        ...options,
        baseline: { ...options.baseline, executor: override.executor, model: override.model },
        baselineSource: "override" as const,
      }
    : options;
  const baseline = explicitProfile.baseline;
  const globalDefault = harnessDefault();

  // CUTOVER: selection is purely DB-driven (job row → global → default). The code/file baseline
  // contributes only its executor-agnostic profile (cwd/timeout/executorOptions/fallbackModels)
  // below — its executor/model no longer select.
  const { primary, pinnedModel, modelPinnedExecutor, plan } = resolveSchedulerPrimary(
    config.id,
    globalDefault,
  );
  // Per-job fallback chain wins; else today's default order (memory jobs keep flash-first). This is
  // the `compatibilityOrder` the negotiator ranks within — not a hardcoded chain.
  const compatibilityOrder = explicitProfile.fallbackChain
    ?? baseline?.fallbackChain
    ?? (memoryJob ? MEMORY_FALLBACK_ORDER : DEFAULT_FALLBACK_ORDER);
  const chain = plan
    ? negotiatedSchedulerChain(plan, compatibilityOrder, primary)
    : buildChain(primary, compatibilityOrder);
  const fallbackModels = {
    ...baseline?.fallbackModels,
    ...explicitProfile.fallbackModels,
  };
  const executorOptions = mergeExecutorOptions(
    baseline?.executorOptions,
    explicitProfile.executorOptions,
  );

  return withSlot(async () => {
    const runExecutor = async (
      executor: ExecutorKind,
      queryOverride?: string,
      modelOverride?: string,
    ): Promise<JobExecutionResult> => {
      const selectedFallbackModel = fallbackModels[executor];
      const effectiveModel = modelOverride
        ?? (modelPinnedExecutor === executor ? pinnedModel : undefined)
        ?? (selectedFallbackModel === null ? undefined : selectedFallbackModel);
      const dispatchOptions: ExecutorDispatchOptions = {
        queryOverride: queryOverride ?? query,
        emitCompletedEvent: false,
        timeoutOverride: explicitProfile.timeoutOverride ?? baseline?.timeoutOverride,
        cwdOverride: explicitProfile.cwdOverride ?? baseline?.cwdOverride,
        signal: explicitProfile.signal,
        modelOverride: effectiveModel,
        executorOptions,
      };

      if (executor === "kimi") return executeKimiJob(job, options.startedAt, options.onProgress, dispatchOptions);
      if (executor === "gemini") return executeGeminiJob(job, options.startedAt, options.onProgress, dispatchOptions);
      if (executor === "opencode") return executeOpenCodeJob(job, options.startedAt, options.onProgress, dispatchOptions);
      if (executor === "codex") return executeCodexJob(job, options.startedAt, options.onProgress, dispatchOptions);
      return executeClaudeJob(job, options.startedAt, options.onProgress, dispatchOptions);
    };

    if (options.singleExecutor) {
      const result = await runExecutor(options.singleExecutor);
      if (options.emitCompletedEvent !== false) {
        emitHarnessCompletion(job, result, options.singleExecutor, options.onProgress);
      }
      return {
        ...result,
        executorUsed: options.singleExecutor,
        fallbackUsed: false,
      } as JobExecutionResult;
    }

    const jobContext = {
      id: config.id,
      name: config.name,
      query,
      lane: config.lane,
      source: "scheduler" as const,
    };

    const notify = async (message: string) => {
      options.onProgress?.({
        type: "thinking",
        jobId: config.id,
        jobName: config.name,
        timestamp: new Date(),
        message,
      });
    };

    const fallbackResult = await runWithFallbackChain({
      primary,
      chain,
      job: jobContext,
      runExecutor,
      notify,
      skipDiagnosis: options.skipDiagnosis,
      jobMeta: { deep: config.deep },
    });

    writeChainTrace(fallbackResult, {
      jobId: config.id,
      source: "scheduler",
      scheduledRunId: options.scheduledRunId,
    });

    const result = fallbackResult.result ?? {
      jobId: config.id,
      jobName: config.name,
      sourceFile: job.sourceFile,
      startedAt: options.startedAt,
      completedAt: new Date(),
      success: false,
      output: "",
      error: "Executor failed with no result",
      exitCode: 1,
      duration: Date.now() - options.startedAt.getTime(),
    };

    if (options.emitCompletedEvent !== false) {
      emitHarnessCompletion(job, result, fallbackResult.executorUsed, options.onProgress);
    }

    return {
      ...result,
      executorUsed: fallbackResult.executorUsed,
      fallbackUsed: fallbackResult.fallbackUsed,
    } as JobExecutionResult;
  });
}

export async function runInternalJobHarness(
  job: RegisteredJob,
  prompt: string,
  options: Omit<RunJobHarnessOptions, "baseline" | "baselineSource" | "memoryJob"> & { stage?: string },
): Promise<JobExecutionResult> {
  const baseline = requireInternalJobHarnessBaseline(job.config.id);
  const stageProfile = options.stage ? baseline.stages?.[options.stage] : undefined;
  const selection = mergeHarnessProfiles(baseline, stageProfile);
  return runJobHarness(job, prompt, {
    ...options,
    baseline: selection,
    baselineSource: "internal-registry",
    memoryJob: isMemoryJob(job),
  });
}

export async function executeScheduledJob(
  job: RegisteredJob,
  onProgress?: ProgressCallback,
  options?: { singleExecutor?: ExecutorKind; skipDiagnosis?: boolean; scheduledRunId?: number }
): Promise<JobExecutionResult> {
  const startedAt = new Date();
  const { config } = job;

  // Phase 0.7: security scan on job prompt before dispatch.
  // Guards against an indirect injection winding up in schedule.json
  // (e.g. via a third-party-authored job spec or accidental paste).
  const scan = scanContent(config.query ?? "");
  if (!scan.clean) {
    const critical = scan.findings.filter((f) => f.severity === "critical");
    if (critical.length > 0) {
      const blockMsg = `Blocked by prompt security scan: ${critical.map((f) => f.patternId).join(", ")}`;
      logger.error(
        { jobId: config.id, findings: critical.map((f) => f.patternId) },
        blockMsg
      );
      return {
        jobId: config.id,
        jobName: config.name,
        sourceFile: job.sourceFile,
        startedAt,
        completedAt: new Date(),
        success: false,
        output: "",
        error: blockMsg,
        exitCode: -1,
        duration: 0,
        notificationIntent: "failure_alert",
      };
    }
  }

  // Emit started event
  onProgress?.({
    type: "started",
    jobId: config.id,
    jobName: config.name,
    timestamp: startedAt,
    message: `🚀 Starting: ${config.name}`,
  });

  const configuredExecutor = config.executor && config.executor !== "internal"
    ? config.executor as ExecutorKind
    : undefined;
  const configuredModel = typeof config.model === "string" && config.model.length > 0
    ? config.model
    : undefined;
  const baseline = configuredExecutor
    ? {
        executor: configuredExecutor,
        model: configuredModel ?? null,
      }
    : undefined;

  return runJobHarness(job, config.query, {
    startedAt,
    onProgress,
    baseline,
    baselineSource: baseline ? "file" : undefined,
    singleExecutor: options?.singleExecutor,
    skipDiagnosis: options?.skipDiagnosis,
    scheduledRunId: options?.scheduledRunId,
    memoryJob: isMemoryJob(job),
  });
}
