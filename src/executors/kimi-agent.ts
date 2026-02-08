/**
 * Kimi Agent Wrapper for Claude Code Integration
 *
 * Routes all execution through Kimi CLI (v1.8.0+) which has
 * built-in tools: Grep, Glob, Shell, FetchURL, SearchWeb, Task (sub-agents).
 *
 * Usage patterns:
 * - Research tasks with web search (SearchWeb + FetchURL)
 * - Long-context document analysis (256k tokens)
 * - Code analysis and generation (Shell, ReadFile, WriteFile)
 * - Multi-agent orchestration (Task tool with sub-agents)
 */

import { executeKimiCLI, type KimiCLIOptions } from "./kimi-cli.js";
import { logger } from "../utils/logger.js";
import type { ExecutorResult } from "./types.js";

export interface KimiAgentOptions {
  /** Task type for prompt optimization */
  taskType?: "research" | "design" | "code" | "vision" | "summarize";
  /** Working directory for file operations */
  workDir?: string;
  /** Timeout in ms (default: 20 minutes) */
  timeout?: number;
  /** Enable thinking mode for complex reasoning */
  thinkingMode?: boolean;
}

export interface KimiAgentResult extends ExecutorResult {
  model: string;
}

/**
 * Task-specific instruction prefixes for the CLI agent
 */
const TASK_INSTRUCTIONS: Record<string, string> = {
  research: `You are performing a research task. Use SearchWeb and FetchURL to find information from multiple sources. Return structured, comprehensive findings with sources cited.`,

  design: `You are performing a front-end design analysis task. Analyze UI/UX patterns, design systems, and component architectures. If given URLs, fetch them for reference. Focus on modern web standards (React, Tailwind, TypeScript).`,

  code: `You are performing a code analysis and generation task. Use ReadFile, Grep, and Glob to explore the codebase. Provide clean, production-ready code with clear explanations.`,

  vision: `You are analyzing visual content. Describe layouts, components, and styling with precision. Convert visual designs to functional code when appropriate.`,

  summarize: `You are summarizing content. Extract key insights, decisions, and actionable items. Be thorough but concise. Structure output with clear sections.`,
};

/**
 * Execute a task using Kimi CLI as an agent
 */
export async function executeKimiAgent(
  query: string,
  options: KimiAgentOptions = {}
): Promise<KimiAgentResult> {
  const startTime = Date.now();
  const {
    taskType = "research",
    workDir,
    timeout = 1200000,
    thinkingMode = false,
  } = options;

  const instruction = TASK_INSTRUCTIONS[taskType] || "";
  const fullQuery = instruction
    ? `${instruction}\n\n---\n\nTask:\n${query}`
    : query;

  logger.info({
    taskType,
    thinkingMode,
    queryLength: query.length,
    workDir,
  }, "Executing Kimi CLI agent task");

  try {
    const cliOptions: KimiCLIOptions = {
      timeout,
      yolo: true,
      workDir: workDir ?? process.env.HOME ?? "/Users/yj",
    };

    const result = await executeKimiCLI(fullQuery, "", cliOptions);

    const duration = Date.now() - startTime;
    logger.info({
      taskType,
      duration,
      exitCode: result.exitCode,
      outputLength: result.output.length,
    }, "Kimi CLI agent task completed");

    return {
      output: result.output,
      exitCode: result.exitCode,
      duration,
      executor: "kimi-agent",
      model: result.model,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);

    logger.error({
      error: message,
      taskType,
      duration,
    }, "Kimi CLI agent task failed");

    return {
      output: `Kimi agent error: ${message}`,
      exitCode: 1,
      duration,
      executor: "kimi-agent",
      model: "moonshot-ai/kimi-k2.5",
    };
  }
}

/** Convenience wrapper for research tasks */
export async function kimiResearch(
  query: string,
  options: Omit<KimiAgentOptions, "taskType"> = {}
): Promise<KimiAgentResult> {
  return executeKimiAgent(query, { ...options, taskType: "research" });
}

/** Convenience wrapper for design tasks */
export async function kimiDesign(
  query: string,
  options: Omit<KimiAgentOptions, "taskType"> = {}
): Promise<KimiAgentResult> {
  return executeKimiAgent(query, { ...options, taskType: "design" });
}

/** Convenience wrapper for summarization tasks */
export async function kimiSummarize(
  query: string,
  options: Omit<KimiAgentOptions, "taskType"> = {}
): Promise<KimiAgentResult> {
  return executeKimiAgent(query, { ...options, taskType: "summarize" });
}
