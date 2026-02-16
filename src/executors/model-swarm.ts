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

import { z, type ZodSchema } from "zod";
import { executeOpenCodeCLI } from "./opencode-cli.js";
import { executeCodexCLI } from "./codex-cli.js";
import { executeClaudeCommand } from "./claude.js";
import { executeGeminiAPI } from "./gemini.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { logger } from "../utils/logger.js";

// ============================================
// TYPES
// ============================================

export type SwarmExecutor = "opencode" | "codex" | "sonnet";

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
}

const DEFAULT_AGENT_TIMEOUT = 300_000;  // 5 min (opencode)
const CODEX_AGENT_TIMEOUT = 180_000;    // 3 min
const SONNET_AGENT_TIMEOUT = 600_000;   // 10 min
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
// FAN OUT AGENTS
// ============================================

export async function fanOutAgents(
  agents: SwarmAgent[],
  outputDir?: string,
): Promise<SwarmResult[]> {
  const startTime = Date.now();

  // Ensure swarm CWD exists for codex/sonnet
  mkdirSync(SWARM_CWD, { recursive: true });

  logger.info(
    { agentCount: agents.length, ids: agents.map((a) => a.id), outputDir },
    "Fanning out swarm agents"
  );

  const promises = agents.map(async (agent): Promise<SwarmResult> => {
    const agentStart = Date.now();

    try {
      let output: string;
      let success: boolean;

      if (agent.executor === "opencode") {
        const timeout = agent.timeout ?? DEFAULT_AGENT_TIMEOUT;
        const result = await executeOpenCodeCLI(agent.prompt, agent.context ?? "", {
          model: agent.model ?? "google/gemini-3-flash-preview",
          timeout,
          researchOnly: true,
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
          model: agent.model ?? "gpt-5.3-codex",
          reasoningEffort: "high",
        });

        output = result.output ?? "";
        success = result.exitCode === 0 && output.length >= MIN_OUTPUT_LENGTH;
      } else if (agent.executor === "sonnet") {
        const timeout = agent.timeout ?? SONNET_AGENT_TIMEOUT;
        const fullPrompt = agent.context
          ? `${agent.context}\n\n---\n\n${agent.prompt}`
          : agent.prompt;

        const result = await executeClaudeCommand(fullPrompt, {
          cwd: SWARM_CWD,
          model: agent.model ?? "sonnet",
          timeout,
        });

        output = result.output ?? "";
        success = result.exitCode === 0 && output.length >= MIN_OUTPUT_LENGTH;
      } else {
        throw new Error(`Unknown executor: ${agent.executor}`);
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
      logger.error({ agentId: agent.id, error: msg }, "Agent execution failed");
      return {
        agentId: agent.id,
        output: `Error: ${msg}`,
        success: false,
        duration: Date.now() - agentStart,
        executor: agent.executor,
      };
    }
  });

  const settled = await Promise.allSettled(promises);
  const results: SwarmResult[] = settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    return {
      agentId: agents[i]!.id,
      output: `Promise rejected: ${s.reason}`,
      success: false,
      duration: 0,
      executor: agents[i]!.executor,
    };
  });

  // Log per-agent results
  for (const r of results) {
    logger.info(
      { agentId: r.agentId, success: r.success, duration: r.duration, outputLen: r.output.length, outputFile: r.outputFile },
      "Swarm agent completed"
    );
  }

  // Check required agents
  const requiredAgents = agents.filter((a) => a.required);
  for (const req of requiredAgents) {
    const result = results.find((r) => r.agentId === req.id);
    if (!result?.success) {
      const totalDuration = Date.now() - startTime;
      const error = `Required agent "${req.id}" failed: ${result?.output?.slice(0, 200) ?? "no result"}`;
      logger.error({ agentId: req.id, totalDuration }, error);
      throw new Error(error);
    }
  }

  logger.info(
    {
      totalDuration: Date.now() - startTime,
      succeeded: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
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

  const fullPrompt = `${prompt}\n\n---\n\n# Agent Results\n\n${agentSections}`;

  logger.info(
    { agentCount: successful.length, promptLength: fullPrompt.length },
    "Consolidating swarm results via Gemini API"
  );

  const result = await executeGeminiAPI(fullPrompt, {
    model: options?.model ?? "flash3",
    useGrounding: false,
    systemPrompt: options?.systemPrompt ?? "You are a precise consolidation engine. Follow instructions exactly. Output valid JSON when requested.",
    maxTokens: options?.maxTokens ?? 65536,
    reasoningEffort: options?.reasoningEffort,
    temperature: options?.temperature ?? 0.2,
    responseMimeType: options?.responseMimeType ?? "application/json",
  });

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
export function parseSwarmJSON<T>(raw: string, schema: ZodSchema<T>): T {
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

function validateArrayElements<T>(parsed: unknown[], schema: ZodSchema<T>): T {
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
