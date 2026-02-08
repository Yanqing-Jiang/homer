/**
 * Model Swarm Utility
 *
 * Parallel multi-model execution using OpenCode CLI (Gemini Flash/Pro)
 * and Kimi CLI (K2.5), with consolidation via Gemini API.
 *
 * Two core functions (no opaque runSwarm wrapper — callers have custom logic):
 * - fanOutAgents: parallel execution of multiple model agents
 * - consolidateResults: merge successful results via Gemini Flash API
 *
 * Plus parseSwarmJSON: robust JSON extraction from LLM output with Zod validation.
 */

import { z, type ZodSchema } from "zod";
import { executeOpenCodeCLI } from "./opencode-cli.js";
import { executeKimiCLI } from "./kimi-cli.js";
import { executeGeminiAPI } from "./gemini.js";
import { logger } from "../utils/logger.js";

// ============================================
// TYPES
// ============================================

export interface SwarmAgent {
  id: string;
  executor: "opencode" | "kimi";
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
}

const DEFAULT_AGENT_TIMEOUT = 300_000; // 5 min
const MIN_OUTPUT_LENGTH = 100;
const MAX_OUTPUT_PER_AGENT = 8192; // 8K chars for consolidation input

// ============================================
// FAN OUT AGENTS
// ============================================

export async function fanOutAgents(agents: SwarmAgent[]): Promise<SwarmResult[]> {
  const startTime = Date.now();

  logger.info(
    { agentCount: agents.length, ids: agents.map((a) => a.id) },
    "Fanning out swarm agents"
  );

  const promises = agents.map(async (agent): Promise<SwarmResult> => {
    const agentStart = Date.now();
    const timeout = agent.timeout ?? DEFAULT_AGENT_TIMEOUT;

    try {
      if (agent.executor === "opencode") {
        const result = await executeOpenCodeCLI(agent.prompt, agent.context ?? "", {
          model: agent.model ?? "google/gemini-3-flash-preview",
          timeout,
          researchOnly: true,
        });

        const output = result.output ?? "";
        const success = result.exitCode === 0 && output.length >= MIN_OUTPUT_LENGTH;

        if (!success && result.exitCode === 0) {
          logger.warn({ agentId: agent.id, outputLen: output.length }, "Agent output too short");
        }

        return {
          agentId: agent.id,
          output,
          success,
          duration: Date.now() - agentStart,
          executor: "opencode",
        };
      } else {
        const result = await executeKimiCLI(agent.prompt, agent.context ?? "", {
          timeout,
          yolo: true,
        });

        const output = result.output ?? "";
        const success = result.exitCode === 0 && output.length >= MIN_OUTPUT_LENGTH;

        if (!success && result.exitCode === 0) {
          logger.warn({ agentId: agent.id, outputLen: output.length }, "Agent output too short");
        }

        return {
          agentId: agent.id,
          output,
          success,
          duration: Date.now() - agentStart,
          executor: "kimi",
        };
      }
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
      { agentId: r.agentId, success: r.success, duration: r.duration, outputLen: r.output.length },
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

  // Build consolidation input with truncated agent outputs
  const agentSections = successful.map((r) => {
    const truncated = r.output.length > MAX_OUTPUT_PER_AGENT
      ? r.output.slice(0, MAX_OUTPUT_PER_AGENT) + "\n\n[...truncated]"
      : r.output;
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
    maxTokens: options?.maxTokens ?? 8192,
    temperature: options?.temperature ?? 0.2,
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
  const candidates = extractJSONCandidates(raw);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);

      // For array schemas: per-element validation
      if (Array.isArray(parsed) && schema instanceof z.ZodArray) {
        return validateArrayElements(parsed, schema) as T;
      }

      const validated = schema.parse(parsed);
      return validated;
    } catch {
      // Try next candidate
    }
  }

  // All attempts failed
  const preview = raw.slice(0, 500);
  throw new Error(`Failed to parse JSON from LLM output. Preview: ${preview}`);
}

function extractJSONCandidates(raw: string): string[] {
  const candidates: string[] = [];

  // 1. Direct parse
  candidates.push(raw.trim());

  // 2. Markdown code fence
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) {
    candidates.push(fenceMatch[1].trim());
  }

  // 3. Find outermost array
  const arrayMatch = raw.match(/(\[[\s\S]*\])/);
  if (arrayMatch?.[1]) {
    candidates.push(arrayMatch[1]);
  }

  // 4. Find outermost object
  const objectMatch = raw.match(/(\{[\s\S]*\})/);
  if (objectMatch?.[1]) {
    candidates.push(objectMatch[1]);
  }

  // 5. Strip common LLM preamble/postamble
  const stripped = raw
    .replace(/^[\s\S]*?(?=[\[{])/, "")
    .replace(/(?<=[\]}])[\s\S]*$/, "");
  if (stripped !== raw.trim()) {
    candidates.push(stripped);
  }

  return candidates;
}

function validateArrayElements<T>(parsed: unknown[], schema: ZodSchema<T>): T {
  // Get the element schema from the array schema
  const arraySchema = schema as unknown as z.ZodArray<z.ZodTypeAny>;
  const elementSchema = arraySchema.element;

  const valid: unknown[] = [];
  let skipped = 0;

  for (const element of parsed) {
    const result = elementSchema.safeParse(element);
    if (result.success) {
      valid.push(result.data);
    } else {
      skipped++;
      logger.warn(
        { error: result.error.issues[0]?.message, element: JSON.stringify(element).slice(0, 200) },
        "Skipping invalid array element in swarm JSON"
      );
    }
  }

  if (skipped > 0) {
    logger.info({ valid: valid.length, skipped }, "Swarm JSON array: some elements skipped");
  }

  // Validate the filtered array against the full schema
  return schema.parse(valid);
}
