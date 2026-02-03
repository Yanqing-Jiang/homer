import { executeClaudeCommand } from "./claude.js";
import { executeKimiAgent } from "./kimi-agent.js";
import { logger } from "../utils/logger.js";
import type { ExecutorResult } from "./types.js";

/**
 * Parallel Multi-Agent Execution
 *
 * Orchestrates simultaneous execution across Claude, Gemini, Codex, and Kimi agents
 * Enables high-throughput research and design tasks by leveraging each agent's strengths
 *
 * Patterns:
 * - Claude: Orchestration, quality refinement, user interaction
 * - Gemini: Front-end research, UI/UX patterns
 * - Codex: Backend architecture, deep reasoning
 * - Kimi: Parallel web scraping, visual analysis, cost-optimized bulk processing
 */

export interface ParallelExecutionRequest {
  /** The query/task to execute */
  query: string;
  /** Working directory */
  cwd: string;
  /** Which agents to run in parallel */
  agents: Array<"claude" | "gemini" | "codex" | "kimi">;
  /** Optional Claude session ID for continuity */
  claudeSessionId?: string;
  /** Kimi-specific task type */
  kimiTaskType?: "research" | "design" | "code" | "vision" | "summarize";
}

export interface ParallelExecutionResult {
  /** Results keyed by agent name */
  results: Record<string, ExecutorResult>;
  /** Total execution time (parallel, not cumulative) */
  duration: number;
  /** Success count */
  successCount: number;
  /** Failure count */
  failureCount: number;
  /** Combined output (optional aggregation) */
  combinedOutput?: string;
}

/**
 * Execute a task across multiple agents in parallel
 *
 * @param request - Parallel execution configuration
 * @returns Aggregated results from all agents
 */
export async function executeParallel(
  request: ParallelExecutionRequest
): Promise<ParallelExecutionResult> {
  const { query, cwd, agents, claudeSessionId, kimiTaskType = "research" } = request;
  const startTime = Date.now();

  logger.info({
    agents,
    queryLength: query.length,
    kimiTaskType,
  }, "Starting parallel agent execution");

  // Build parallel execution promises
  const executions: Array<Promise<{ agent: string; result: ExecutorResult }>> = [];

  for (const agent of agents) {
    switch (agent) {
      case "claude":
        executions.push(
          executeClaudeCommand(query, { cwd, claudeSessionId })
            .then((result) => ({ agent: "claude", result }))
            .catch((error) => ({
              agent: "claude",
              result: {
                output: `Claude error: ${error.message}`,
                exitCode: 1,
                duration: 0,
                executor: "claude",
              },
            }))
        );
        break;

      case "gemini":
        executions.push(
          executeClaudeCommand(query, { cwd, claudeSessionId, subagent: "gemini" })
            .then((result) => ({ agent: "gemini", result }))
            .catch((error) => ({
              agent: "gemini",
              result: {
                output: `Gemini error: ${error.message}`,
                exitCode: 1,
                duration: 0,
                executor: "claude",
              },
            }))
        );
        break;

      case "codex":
        executions.push(
          executeClaudeCommand(query, { cwd, claudeSessionId, subagent: "codex" })
            .then((result) => ({ agent: "codex", result }))
            .catch((error) => ({
              agent: "codex",
              result: {
                output: `Codex error: ${error.message}`,
                exitCode: 1,
                duration: 0,
                executor: "claude",
              },
            }))
        );
        break;

      case "kimi":
        executions.push(
          executeKimiAgent(query, { taskType: kimiTaskType })
            .then((result) => ({ agent: "kimi", result }))
            .catch((error) => ({
              agent: "kimi",
              result: {
                output: `Kimi error: ${error.message}`,
                exitCode: 1,
                duration: 0,
                executor: "kimi-agent",
              },
            }))
        );
        break;
    }
  }

  // Execute all in parallel and wait for all to complete
  const settled = await Promise.all(executions);

  const duration = Date.now() - startTime;

  // Aggregate results
  const results: Record<string, ExecutorResult> = {};
  let successCount = 0;
  let failureCount = 0;

  for (const { agent, result } of settled) {
    results[agent] = result;
    if (result.exitCode === 0) {
      successCount++;
    } else {
      failureCount++;
    }
  }

  logger.info({
    duration,
    successCount,
    failureCount,
    agents: Object.keys(results),
  }, "Parallel execution completed");

  return {
    results,
    duration,
    successCount,
    failureCount,
  };
}

/**
 * Predefined parallel execution patterns
 */

/**
 * Research Swarm: Claude orchestrates, Kimi + Gemini research in parallel
 *
 * Use when: Deep research requiring multiple sources and perspectives
 * Pattern: Kimi scrapes data, Gemini analyzes trends, Claude synthesizes
 */
export async function researchSwarm(
  query: string,
  cwd: string = process.env.HOME || "/Users/yj"
): Promise<ParallelExecutionResult> {
  return executeParallel({
    query: `Research task: ${query}

Instructions for agents:
- Kimi: Use parallel agent swarm to scrape 10-20 relevant sources. Return structured data.
- Gemini: Analyze current trends and patterns. Focus on recent developments (2026).
- Claude: Synthesize findings into executive summary with actionable insights.`,
    cwd,
    agents: ["claude", "gemini", "kimi"],
    kimiTaskType: "research",
  });
}

/**
 * Design Pipeline: Gemini explores patterns, Kimi analyzes visuals, Claude decides
 *
 * Use when: Front-end design decisions, UI/UX research
 * Pattern: Gemini finds best practices, Kimi converts wireframes, Claude recommends approach
 */
export async function designPipeline(
  query: string,
  cwd: string = process.env.HOME || "/Users/yj"
): Promise<ParallelExecutionResult> {
  return executeParallel({
    query: `Design task: ${query}

Instructions for agents:
- Gemini: Research modern UI/UX patterns and component libraries. Focus on React/Tailwind.
- Kimi: If screenshots provided, convert to code. Otherwise, suggest visual implementations.
- Claude: Recommend final approach based on findings. Consider P&G brand guidelines.`,
    cwd,
    agents: ["claude", "gemini", "kimi"],
    kimiTaskType: "design",
  });
}

/**
 * Full Spectrum: All agents working in parallel
 *
 * Use when: Complex multi-faceted problems requiring diverse perspectives
 * Pattern: Each agent brings unique strength, Claude synthesizes at end
 */
export async function fullSpectrum(
  query: string,
  cwd: string = process.env.HOME || "/Users/yj"
): Promise<ParallelExecutionResult> {
  return executeParallel({
    query,
    cwd,
    agents: ["claude", "gemini", "codex", "kimi"],
    kimiTaskType: "research",
  });
}

/**
 * Combine outputs from parallel execution into a single summary
 *
 * @param result - Parallel execution result
 * @returns Markdown-formatted combined output
 */
export function combineOutputs(result: ParallelExecutionResult): string {
  const sections: string[] = [];

  sections.push("# Parallel Agent Execution Results\n");
  sections.push(`**Duration:** ${(result.duration / 1000).toFixed(2)}s`);
  sections.push(`**Success:** ${result.successCount}/${result.successCount + result.failureCount}\n`);

  for (const [agent, agentResult] of Object.entries(result.results)) {
    const status = agentResult.exitCode === 0 ? "✓" : "✗";
    sections.push(`## ${status} ${agent.toUpperCase()}\n`);
    sections.push(agentResult.output);
    sections.push("\n---\n");
  }

  return sections.join("\n");
}
