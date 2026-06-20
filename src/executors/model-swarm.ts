/**
 * Model Swarm Utility
 *
 * Parallel multi-model execution using OpenCode CLI (Gemini Flash/Pro),
 * Codex CLI (GPT-5.3), and Claude CLI (Sonnet), with consolidation via Gemini API.
 *
 * Two core functions (no opaque runSwarm wrapper — callers have custom logic):
 * - fanOutAgents: parallel execution of multiple model agents
 * - consolidateResults: merge successful results via Gemini Flash API
 *
 * Plus parseSwarmJSON: robust JSON extraction from LLM output with Zod validation.
 */

import { z } from "zod";
import { executeOpenCodeCLI } from "./opencode-cli.js";
import { executeCodexCLI } from "./codex-cli.js";
import { executeKimiCLI } from "./kimi-cli.js";
import { executeClaudeCommand } from "./claude.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { logger } from "../utils/logger.js";

// ============================================
// TYPES
// ============================================

export type SwarmExecutor = "opencode" | "codex" | "kimi" | "claude";

export interface SwarmAgent {
  id: string;
  executor: SwarmExecutor;
  model?: string;
  prompt: string;
  context?: string;
  timeout?: number;
  required?: boolean;
}

export interface SwarmResult {
  agentId: string;
  output: string;
  success: boolean;
  duration: number;
  executor: string;
  outputFile?: string;
  cancelled?: boolean;
}

export interface FanOutPolicy {
  /** Abort non-required agents immediately if a required agent fails. Default: true */
  abortOnRequiredFailure?: boolean;
  /** Once all required agents succeed + this fraction of total agents are done,
   *  start straggler timer. Default: 0.5 */
  quorumRatio?: number;
  /** Max ms to wait for remaining agents after quorum is met. Default: 120_000 (2min) */
  stragglerTimeoutMs?: number;
}

const DEFAULT_AGENT_TIMEOUT = 900_000;   // 15 min (opencode, sonnet)
const CODEX_AGENT_TIMEOUT = 1_800_000;  // 30 min
const MIN_OUTPUT_LENGTH = 100;
const MAX_OUTPUT_PER_AGENT = 8192; // 8K chars for consolidation input

const SWARM_CWD = "/tmp/homer-swarm";

// ============================================
// FILE OUTPUT HELPER
// ============================================

function writeAgentOutput(outputDir: string, agentId: string, content: string): string {
  mkdirSync(outputDir, { recursive: true });
  const filepath = join(outputDir, `${agentId}.md`);
  writeFileSync(filepath, content, "utf-8");
  return filepath;
}

// ============================================
// PER-AGENT EXECUTOR
// ============================================

async function executeAgent(
  agent: SwarmAgent,
  signal: AbortSignal,
  outputDir?: string,
): Promise<SwarmResult> {
  const agentStart = Date.now();

  try {
    let output: string;
    let success: boolean;

    if (agent.executor === "opencode") {
      const timeout = agent.timeout ?? DEFAULT_AGENT_TIMEOUT;
      const result = await executeOpenCodeCLI(agent.prompt, agent.context ?? "", {
        model: agent.model ?? "google/gemini-3.5-flash",
        forceOpenCode: true,
        timeout,
        researchOnly: true,
        signal,
      });

      output = result.output ?? "";
      success = result.exitCode === 0 && output.length >= MIN_OUTPUT_LENGTH;
    } else if (agent.executor === "codex") {
      const timeout = agent.timeout ?? CODEX_AGENT_TIMEOUT;
      const fullPrompt = agent.context
        ? `${agent.context}\n\n---\n\n${agent.prompt}`
        : agent.prompt;

      const result = await executeCodexCLI(fullPrompt, {
        cwd: SWARM_CWD,
        timeout,
        model: agent.model ?? "gpt-5.5",
        reasoningEffort: "high",
        signal,
      });

      output = result.output ?? "";
      success = result.exitCode === 0 && output.length >= MIN_OUTPUT_LENGTH;
    } else if (agent.executor === "kimi") {
      const timeout = agent.timeout ?? DEFAULT_AGENT_TIMEOUT;

      const result = await executeKimiCLI(agent.prompt, agent.context ?? "", {
        timeout,
        workDir: SWARM_CWD,
        signal,
      });

      output = result.output ?? "";
      success = result.exitCode === 0 && output.length >= MIN_OUTPUT_LENGTH;
    } else if (agent.executor === "claude") {
      const timeout = agent.timeout ?? DEFAULT_AGENT_TIMEOUT;
      const fullPrompt = agent.context
        ? `${agent.context}\n\n---\n\n${agent.prompt}`
        : agent.prompt;

      // executeClaudeCommand rejects on abort/timeout — caught by outer try/catch
      const result = await executeClaudeCommand(fullPrompt, {
        cwd: SWARM_CWD,
        model: agent.model ?? "opus",
        timeout,
        signal,
      });

      output = result.output ?? "";
      success = result.exitCode === 0 && output.length >= MIN_OUTPUT_LENGTH;
    } else {
      throw new Error(`Unknown executor: ${agent.executor}`);
    }

    // Check if we were aborted after the executor returned
    if (signal.aborted) {
      return {
        agentId: agent.id,
        output: output || "Cancelled by quorum policy",
        success: false,
        duration: Date.now() - agentStart,
        executor: agent.executor,
        cancelled: true,
      };
    }

    if (!success && output.length < MIN_OUTPUT_LENGTH) {
      logger.warn({ agentId: agent.id, outputLen: output.length }, "Agent output too short");
    }

    // Write output to file if outputDir is set
    let outputFile: string | undefined;
    if (outputDir && success) {
      try {
        outputFile = writeAgentOutput(outputDir, agent.id, output);
        logger.debug({ agentId: agent.id, outputFile }, "Wrote agent output to file");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ agentId: agent.id, error: msg }, "Failed to write agent output file");
      }
    }

    return {
      agentId: agent.id,
      output,
      success,
      duration: Date.now() - agentStart,
      executor: agent.executor,
      outputFile,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const cancelled = signal.aborted ||
      msg.includes("abort") || msg.includes("ABORT") || msg.includes("cancel");

    if (cancelled) {
      logger.info({ agentId: agent.id, duration: Date.now() - agentStart }, "Agent cancelled");
    } else {
      logger.error({ agentId: agent.id, error: msg }, "Agent execution failed");
    }

    return {
      agentId: agent.id,
      output: cancelled ? "Cancelled by quorum policy" : `Error: ${msg}`,
      success: false,
      duration: Date.now() - agentStart,
      executor: agent.executor,
      cancelled,
    };
  }
}

// ============================================
// ABORT HELPER
// ============================================

function abortRemaining(
  controllers: Map<string, AbortController>,
  settled: Set<string>,
): void {
  for (const [id, ctrl] of controllers) {
    if (!settled.has(id)) {
      ctrl.abort();
    }
  }
}

// ============================================
// FAN OUT AGENTS
// ============================================

export async function fanOutAgents(
  agents: SwarmAgent[],
  outputDir?: string,
  policy?: FanOutPolicy,
): Promise<SwarmResult[]> {
  const startTime = Date.now();

  // Ensure swarm CWD exists for codex/sonnet
  mkdirSync(SWARM_CWD, { recursive: true });

  logger.info(
    { agentCount: agents.length, ids: agents.map((a) => a.id), outputDir, policy },
    "Fanning out swarm agents"
  );

  // No agents → return immediately
  if (agents.length === 0) return [];

  // Policy defaults
  const abortOnRequiredFailure = policy?.abortOnRequiredFailure ?? true;
  const quorumRatio = policy?.quorumRatio ?? 0.5;
  const stragglerTimeoutMs = policy?.stragglerTimeoutMs ?? 120_000;

  const requiredIds = new Set(agents.filter((a) => a.required).map((a) => a.id));
  const controllers = new Map<string, AbortController>();
  const settledIds = new Set<string>();
  const resultMap = new Map<string, SwarmResult>();

  let stragglerTimer: ReturnType<typeof setTimeout> | undefined;
  let quorumStarted = false;
  let requiredFailed = false;

  const results = await new Promise<SwarmResult[]>((resolveAll) => {
    const tryResolve = () => {
      if (settledIds.size < agents.length) return;
      if (stragglerTimer) clearTimeout(stragglerTimer);
      resolveAll(agents.map((a) => resultMap.get(a.id)!));
    };

    const onAgentSettled = (result: SwarmResult) => {
      // Guard against double-settle (abort can race with natural completion)
      if (settledIds.has(result.agentId)) return;
      settledIds.add(result.agentId);
      resultMap.set(result.agentId, result);

      logger.info(
        {
          agentId: result.agentId,
          success: result.success,
          cancelled: result.cancelled,
          duration: result.duration,
          outputLen: result.output.length,
          outputFile: result.outputFile,
          settled: settledIds.size,
          total: agents.length,
        },
        "Swarm agent settled"
      );

      // STOP CONDITION 1: Required agent failed → abort remaining
      if (
        abortOnRequiredFailure &&
        !requiredFailed &&
        requiredIds.has(result.agentId) &&
        !result.success &&
        !result.cancelled
      ) {
        requiredFailed = true;
        logger.warn(
          { agentId: result.agentId },
          "Required agent failed — aborting remaining agents"
        );
        abortRemaining(controllers, settledIds);
        // Don't resolve yet — let aborted agents settle naturally
      }

      // STOP CONDITION 2: Quorum met → start straggler timer
      if (!quorumStarted && !requiredFailed) {
        const allRequiredDone = [...requiredIds].every((id) => settledIds.has(id));
        const allRequiredOk = [...requiredIds].every(
          (id) => resultMap.get(id)?.success
        );
        const ratio = settledIds.size / agents.length;

        if (allRequiredDone && allRequiredOk && ratio >= quorumRatio) {
          quorumStarted = true;
          if (settledIds.size < agents.length) {
            const remaining = agents
              .filter((a) => !settledIds.has(a.id))
              .map((a) => a.id);
            logger.info(
              { quorumRatio, stragglerTimeoutMs, remaining },
              "Quorum met — starting straggler timer"
            );
            stragglerTimer = setTimeout(() => {
              logger.warn(
                {
                  remaining: agents
                    .filter((a) => !settledIds.has(a.id))
                    .map((a) => a.id),
                },
                "Straggler timeout — aborting remaining agents"
              );
              abortRemaining(controllers, settledIds);
            }, stragglerTimeoutMs);
          }
        }
      }

      // STOP CONDITION 3: All done
      tryResolve();
    };

    // Launch all agents with per-agent AbortControllers
    for (const agent of agents) {
      const ctrl = new AbortController();
      controllers.set(agent.id, ctrl);

      executeAgent(agent, ctrl.signal, outputDir)
        .then(onAgentSettled)
        .catch((err) => {
          // Should not happen — executeAgent catches internally — but be safe
          const msg = err instanceof Error ? err.message : String(err);
          onAgentSettled({
            agentId: agent.id,
            output: `Promise rejected: ${msg}`,
            success: false,
            duration: Date.now() - startTime,
            executor: agent.executor,
          });
        });
    }
  });

  // Clean up timer if still pending (safety net)
  if (stragglerTimer) clearTimeout(stragglerTimer);

  // Check required agents — throw if any non-cancelled required agent failed
  for (const reqId of requiredIds) {
    const result = resultMap.get(reqId);
    if (!result?.success) {
      const totalDuration = Date.now() - startTime;
      const error = `Required agent "${reqId}" failed: ${result?.output?.slice(0, 200) ?? "no result"}`;
      logger.error({ agentId: reqId, totalDuration }, error);
      throw new Error(error);
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success && !r.cancelled).length;
  const cancelled = results.filter((r) => r.cancelled).length;

  logger.info(
    {
      totalDuration: Date.now() - startTime,
      succeeded,
      failed,
      cancelled,
    },
    "Swarm fan-out complete"
  );

  return results;
}

// ============================================
// CONSOLIDATE RESULTS
// ============================================

export interface ConsolidateOptions {
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  responseMimeType?: "application/json" | "text/plain";
  reasoningEffort?: "low" | "medium" | "high";
  /** Optional preference context injected before agent results */
  preferenceContext?: string;
}

export async function consolidateResults(
  results: SwarmResult[],
  prompt: string,
  options?: ConsolidateOptions
): Promise<string> {
  const successful = results.filter((r) => r.success);

  if (successful.length === 0) {
    throw new Error("No successful agent results to consolidate");
  }

  // Build consolidation input — prefer file content when available
  const agentSections = successful.map((r) => {
    let content = r.output;
    if (r.outputFile && existsSync(r.outputFile)) {
      try {
        content = readFileSync(r.outputFile, "utf-8");
      } catch {
        // fall back to in-memory output
      }
    }
    const truncated = content.slice(0, MAX_OUTPUT_PER_AGENT) +
      (content.length > MAX_OUTPUT_PER_AGENT ? "\n\n[...truncated]" : "");
    return `## Agent: ${r.agentId}\n\n${truncated}`;
  }).join("\n\n---\n\n");

  const prefSection = options?.preferenceContext
    ? `\n\n## User Preferences\n${options.preferenceContext}\n`
    : "";
  const fullPrompt = `${prompt}${prefSection}\n\n---\n\n# Agent Results\n\n${agentSections}`;

  logger.info(
    { agentCount: successful.length, promptLength: fullPrompt.length },
    "Consolidating swarm results via Gemini API"
  );

  const sysPrompt = options?.systemPrompt ?? "You are a precise consolidation engine. Follow instructions exactly. Output valid JSON when requested.";
  const result = await executeOpenCodeCLI(
    sysPrompt + "\n\n---\n\n" + fullPrompt,
    "",
    { model: "google/gemini-3.5-flash", forceOpenCode: true, researchOnly: false, timeout: 300_000 },
  );

  if (result.exitCode !== 0) {
    throw new Error(`Consolidation API failed: ${result.output}`);
  }

  return result.output;
}

// ============================================
// PARSE SWARM JSON
// ============================================

/**
 * Robust JSON extraction from LLM output with Zod validation.
 * For arrays: validates per-element, skips invalid ones.
 */
export function parseSwarmJSON<T>(raw: string, schema: z.ZodType<T, any, any>): T {
  const { candidates, labels } = extractJSONCandidates(raw);
  const errors: Array<{ strategy: string; error: string }> = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const strategy = labels[i] ?? `strategy-${i}`;
    try {
      const parsed = JSON.parse(candidate);

      // For array schemas: per-element validation
      if (Array.isArray(parsed) && schema instanceof z.ZodArray) {
        return validateArrayElements(parsed, schema) as T;
      }

      const validated = schema.parse(parsed);
      return validated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ strategy, error: msg.slice(0, 200) });
    }
  }

  // All attempts failed — include per-strategy diagnostics
  const diagnostics = errors.map((e) => `  ${e.strategy}: ${e.error}`).join("\n");
  const preview = raw.slice(0, 500);
  throw new Error(
    `Failed to parse JSON from LLM output (${candidates.length} strategies tried).\n${diagnostics}\nPreview: ${preview}`
  );
}

function extractJSONCandidates(raw: string): { candidates: string[]; labels: string[] } {
  const candidates: string[] = [];
  const labels: string[] = [];

  // 1. Direct parse
  candidates.push(raw.trim());
  labels.push("direct");

  // 2. Markdown code fences — try ALL fenced blocks
  const fencePattern = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
  let fenceMatch;
  let fenceIdx = 0;
  while ((fenceMatch = fencePattern.exec(raw)) !== null) {
    if (fenceMatch[1]) {
      candidates.push(fenceMatch[1].trim());
      labels.push(`markdown-fence-${fenceIdx++}`);
    }
  }

  // 3. Find outermost array
  const arrayMatch = raw.match(/(\[[\s\S]*\])/);
  if (arrayMatch?.[1]) {
    candidates.push(arrayMatch[1]);
    labels.push("outermost-array");
  }

  // 4. Find outermost object
  const objectMatch = raw.match(/(\{[\s\S]*\})/);
  if (objectMatch?.[1]) {
    candidates.push(objectMatch[1]);
    labels.push("outermost-object");
  }

  // 5. Strip common LLM preamble/postamble
  const stripped = raw
    .replace(/^[\s\S]*?(?=[\[{])/, "")
    .replace(/(?<=[\]}])[\s\S]*$/, "");
  if (stripped !== raw.trim()) {
    candidates.push(stripped);
    labels.push("stripped-preamble");
  }

  return { candidates, labels };
}

function validateArrayElements<T>(parsed: unknown[], schema: z.ZodType<T, any, any>): T {
  // Get the element schema from the array schema
  const arraySchema = schema as unknown as z.ZodArray<z.ZodTypeAny>;
  const elementSchema = arraySchema.element;

  const valid: unknown[] = [];
  let skipped = 0;
  let firstError: string | undefined;

  for (const element of parsed) {
    const result = elementSchema.safeParse(element);
    if (result.success) {
      valid.push(result.data);
    } else {
      skipped++;
      const errMsg = result.error.issues[0]?.message ?? "unknown";
      if (!firstError) firstError = errMsg;
      logger.warn(
        { error: errMsg, element: JSON.stringify(element).slice(0, 200) },
        "Skipping invalid array element in swarm JSON"
      );
    }
  }

  if (skipped > 0) {
    logger.info({ valid: valid.length, skipped }, "Swarm JSON array: some elements skipped");
  }

  // All elements failed — this is a schema mismatch, not "no results"
  if (parsed.length > 0 && valid.length === 0) {
    throw new Error(
      `All ${parsed.length} array elements failed Zod validation. ` +
      `First error: ${firstError}. This usually means the LLM output format doesn't match the expected schema.`
    );
  }

  // Validate the filtered array against the full schema
  return schema.parse(valid);
}
