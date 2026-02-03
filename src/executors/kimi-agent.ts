import { executeKimiCommand } from "./kimi.js";
import { logger } from "../utils/logger.js";
import type { ExecutorResult } from "./types.js";

/**
 * Kimi Agent Wrapper for Claude Code Integration
 *
 * Provides a Claude Code-compatible subagent interface for Kimi K2.5
 * Enables parallel execution alongside gemini and codex subagents
 *
 * Usage patterns:
 * - Research tasks requiring parallel web scraping
 * - Long-context document analysis (256k tokens)
 * - Visual UI analysis (MoonViT vision capabilities)
 * - Front-end design research
 * - Cost-optimized bulk processing
 */

export interface KimiAgentOptions {
  /** Use NVIDIA NIM (free tier) or Moonshot direct API */
  provider?: "nvidia" | "moonshot";
  /** Task type for model selection */
  taskType?: "research" | "design" | "code" | "vision" | "summarize";
  /** Temperature for creativity (0.0-1.0) */
  temperature?: number;
  /** Max output tokens */
  maxTokens?: number;
  /** Enable thinking mode for complex reasoning */
  thinkingMode?: boolean;
}

export interface KimiAgentResult extends ExecutorResult {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

/**
 * Task-specific system prompts optimized for Kimi K2.5's strengths
 */
const TASK_PROMPTS = {
  research: `You are a research specialist using Kimi K2.5's parallel agent swarm capabilities.
Your strength is spawning multiple sub-agents to research topics in parallel.
For multi-source research, break down the task and process sources concurrently.
Return structured, comprehensive findings with citations.`,

  design: `You are a front-end design specialist with visual understanding capabilities.
You excel at analyzing UI/UX patterns, design systems, and component architectures.
When given screenshots or wireframes, describe layouts precisely and suggest implementation approaches.
Focus on modern web standards (React, Tailwind, TypeScript).`,

  code: `You are a coding assistant specializing in parallel code analysis and generation.
You can analyze multiple code files simultaneously and identify patterns across large codebases.
Provide clean, production-ready code with clear explanations.
Prefer functional patterns and type safety.`,

  vision: `You are a vision specialist using Kimi K2.5's native MoonViT capabilities.
You can analyze screenshots, diagrams, wireframes, and UI mockups.
Convert visual designs to functional code (HTML/CSS/React).
Describe layouts, components, and styling with precision.`,

  summarize: `You are a summarization expert optimized for long-context analysis (256k tokens).
Extract key insights, decisions, and actionable items from large documents.
Be thorough but concise. Structure your output with clear sections.
Identify patterns and trends across the content.`,
} as const;

/**
 * Task-specific model configurations
 */
const TASK_CONFIGS = {
  research: {
    temperature: 0.3,
    maxTokens: 8192,
    model: "moonshotai/kimi-k2-instruct", // Standard for parallel agent spawning
  },
  design: {
    temperature: 0.5,
    maxTokens: 6144,
    model: "moonshotai/kimi-k2-instruct",
  },
  code: {
    temperature: 0.2,
    maxTokens: 8192,
    model: "moonshotai/kimi-k2-instruct",
  },
  vision: {
    temperature: 0.3,
    maxTokens: 4096,
    model: "moonshotai/kimi-k2.5", // Vision-enabled model
  },
  summarize: {
    temperature: 0.2,
    maxTokens: 8192,
    model: "moonshotai/kimi-k2-instruct", // Long-context optimized
  },
} as const;

/**
 * Execute a task using Kimi K2.5 as a Claude Code subagent
 *
 * @param query - The task/question to process
 * @param options - Agent configuration options
 * @returns Execution result with output and metadata
 */
export async function executeKimiAgent(
  query: string,
  options: KimiAgentOptions = {}
): Promise<KimiAgentResult> {
  const startTime = Date.now();
  const {
    provider = "nvidia", // Prefer NVIDIA free tier
    taskType = "research",
    temperature,
    maxTokens,
    thinkingMode = false,
  } = options;

  // Get task-specific configuration
  const taskConfig = TASK_CONFIGS[taskType];
  const systemPrompt = TASK_PROMPTS[taskType];

  // Override with user-provided values
  const finalTemp = temperature ?? taskConfig.temperature;
  const finalMaxTokens = maxTokens ?? taskConfig.maxTokens;

  // Select model based on task and thinking mode
  let model: string = taskConfig.model;
  if (thinkingMode) {
    model = "moonshotai/kimi-k2-thinking"; // Use thinking mode model
  }

  logger.info({
    provider,
    taskType,
    model,
    temperature: finalTemp,
    maxTokens: finalMaxTokens,
    thinkingMode,
    queryLength: query.length,
  }, "Executing Kimi agent task");

  try {
    const result = await executeKimiCommand(query, {
      provider,
      model,
      systemPrompt,
      temperature: finalTemp,
      maxTokens: finalMaxTokens,
    });

    // Calculate estimated cost (Moonshot pricing)
    const cost = calculateCost(result.inputTokens, result.outputTokens, provider);

    const duration = Date.now() - startTime;
    logger.info({
      provider,
      model,
      taskType,
      duration,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cost,
      exitCode: result.exitCode,
    }, "Kimi agent task completed");

    return {
      output: result.output,
      exitCode: result.exitCode,
      duration,
      executor: "kimi-agent",
      provider,
      model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cost,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);

    logger.error({
      error: message,
      provider,
      taskType,
      model,
      duration,
    }, "Kimi agent task failed");

    return {
      output: `Kimi agent error: ${message}`,
      exitCode: 1,
      duration,
      executor: "kimi-agent",
      provider,
      model,
    };
  }
}

/**
 * Calculate estimated API cost
 *
 * Pricing (per 1M tokens):
 * - Moonshot: $0.60 input (cache miss), $0.10 (cache hit), $3.00 output
 * - NVIDIA NIM: Free tier (40 RPM limit)
 */
function calculateCost(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  provider: string
): number | undefined {
  if (!inputTokens || !outputTokens) return undefined;
  if (provider === "nvidia") return 0; // Free tier

  // Moonshot pricing (assume cache miss for conservative estimate)
  const inputCost = (inputTokens / 1_000_000) * 0.60;
  const outputCost = (outputTokens / 1_000_000) * 3.00;

  return inputCost + outputCost;
}

/**
 * Convenience wrapper for research tasks
 * Optimized for parallel multi-source research
 */
export async function kimiResearch(
  query: string,
  options: Omit<KimiAgentOptions, "taskType"> = {}
): Promise<KimiAgentResult> {
  return executeKimiAgent(query, { ...options, taskType: "research" });
}

/**
 * Convenience wrapper for front-end design tasks
 * Optimized for UI/UX analysis and component design
 */
export async function kimiDesign(
  query: string,
  options: Omit<KimiAgentOptions, "taskType"> = {}
): Promise<KimiAgentResult> {
  return executeKimiAgent(query, { ...options, taskType: "design" });
}

/**
 * Convenience wrapper for vision tasks
 * Uses MoonViT for screenshot/wireframe analysis
 */
export async function kimiVision(
  query: string,
  options: Omit<KimiAgentOptions, "taskType"> = {}
): Promise<KimiAgentResult> {
  return executeKimiAgent(query, { ...options, taskType: "vision" });
}

/**
 * Convenience wrapper for long-context summarization
 * Optimized for 256k token documents
 */
export async function kimiSummarize(
  query: string,
  options: Omit<KimiAgentOptions, "taskType"> = {}
): Promise<KimiAgentResult> {
  return executeKimiAgent(query, { ...options, taskType: "summarize" });
}
