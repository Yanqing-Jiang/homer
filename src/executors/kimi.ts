/**
 * Kimi Executor — CLI-based
 *
 * All Kimi execution routes through the Kimi CLI (v1.8.0+) which has
 * built-in tools (Grep, Glob, Shell, FetchURL, SearchWeb, etc).
 *
 * NVIDIA NIM API is disabled — it's a raw chat completion endpoint
 * with no tooling. Use the CLI for everything.
 */

import { executeKimiCLI, type KimiCLIOptions } from "./kimi-cli.js";
import type { ExecutorResult } from "./types.js";
import { logger } from "../utils/logger.js";

// Re-export types for backwards compatibility
export interface KimiExecutorOptions {
  provider?: string; // Ignored — always uses CLI
  model?: string;
  modelSize?: string; // Ignored — CLI uses config default
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface KimiExecutorResult extends ExecutorResult {
  model: string;
  provider: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Execute a Kimi command via CLI.
 *
 * Previously used NVIDIA NIM / Moonshot API directly.
 * Now delegates to Kimi CLI which has full tool access
 * (web search, file ops, shell, etc).
 */
export async function executeKimiCommand(
  query: string,
  options: KimiExecutorOptions = {}
): Promise<KimiExecutorResult> {
  const { systemPrompt, model } = options;

  // Prepend system prompt as context if provided
  const fullQuery = systemPrompt
    ? `Instructions: ${systemPrompt}\n\n---\n\n${query}`
    : query;

  logger.debug(
    { model, queryLength: query.length, hasSystemPrompt: !!systemPrompt },
    "Executing Kimi via CLI (not API)"
  );

  const cliOptions: KimiCLIOptions = {
    model,
    timeout: 1200000, // 20 minutes
    yolo: true,
    workDir: process.env.HOME ?? "/Users/yj",
  };

  const result = await executeKimiCLI(fullQuery, "", cliOptions);

  return {
    ...result,
    provider: "cli",
    model: model ?? "moonshot-ai/kimi-k2.5",
    inputTokens: undefined, // CLI doesn't report token counts
    outputTokens: undefined,
  };
}

/**
 * Long-context summarization via Kimi CLI.
 */
export async function summarizeWithKimi(
  content: string,
  instruction: string
): Promise<string> {
  const result = await executeKimiCommand(
    `${instruction}\n\n---\n\n${content}`,
    {
      systemPrompt:
        "You are an expert at analyzing and summarizing content. Extract key insights, decisions, and actionable items. Be thorough but concise.",
    }
  );

  if (result.exitCode !== 0) {
    throw new Error(result.output);
  }

  return result.output;
}

/**
 * Memory extraction from daily logs via Kimi CLI.
 */
export async function extractMemoryFacts(
  dailyLogContent: string
): Promise<{
  promotions: Array<{
    content: string;
    file: "me" | "work" | "life" | "preferences" | "tools";
    section?: string;
  }>;
  summary: string;
}> {
  const result = await executeKimiCommand(
    `Analyze this daily log and extract facts that should be saved to permanent memory.

Categories:
- me: Identity, personal goals, HOMER config
- work: Career, projects, contacts, professional context
- life: Life context, routines, personal relationships
- preferences: Communication style, technical preferences
- tools: Tool configurations, workflows, integrations

For each fact, provide:
1. The content to save (concise, standalone statement)
2. Which file it belongs to
3. Optional section header if it fits under a specific topic

Also provide a brief summary of the day's key activities.

Return as JSON:
{
  "promotions": [
    {"content": "...", "file": "work", "section": "Projects"}
  ],
  "summary": "..."
}

---

${dailyLogContent}`,
    {
      systemPrompt:
        "You are a memory curator. Extract lasting facts from daily logs. Only include information worth remembering long-term. Be selective - not everything needs to be saved. Return valid JSON only.",
    }
  );

  if (result.exitCode !== 0) {
    throw new Error(result.output);
  }

  try {
    const jsonMatch = result.output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }
    return JSON.parse(jsonMatch[0]);
  } catch (parseError) {
    logger.error({ error: parseError, output: result.output }, "Failed to parse Kimi response");
    throw new Error("Failed to parse memory extraction response");
  }
}
