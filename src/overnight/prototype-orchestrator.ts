/**
 * Prototype Orchestrator
 *
 * Manages parallel prototype generation with 3 approaches:
 * - Conservative (Codex): Precision, established patterns
 * - Innovative (Gemini): Creativity, exploration
 * - Pragmatic (Claude): Balanced approach
 *
 * Each approach runs in an isolated git worktree.
 */

import { logger } from "../utils/logger.js";
import { executeWithRouting, type RoutingRequest } from "../executors/router.js";
import { executeGeminiWithFallback } from "../executors/gemini-cli.js";
import { OvernightTaskStore } from "./task-store.js";
import { WorkspaceManager } from "./workspace.js";
import type {
  OvernightTask,
  OvernightIteration,
  ApproachLabel,
  ApproachName,
  ApproachStrategy,
  OrchestratorResult,
  ExecutorType,
} from "./types.js";
import { DEFAULT_OVERNIGHT_CONFIG } from "./types.js";

// ============================================
// APPROACH DEFINITIONS
// ============================================

const APPROACH_DEFINITIONS: Record<ApproachLabel, { name: ApproachName; description: string }> = {
  A: {
    name: "Conservative",
    description: "Minimal changes, established patterns, proven libraries. Prioritize safety and maintainability.",
  },
  B: {
    name: "Innovative",
    description: "Creative solutions, modern approaches, exploration of new patterns. Prioritize elegance and future-proofing.",
  },
  C: {
    name: "Pragmatic",
    description: "Balanced trade-offs, practical implementation, good enough for now. Prioritize delivery and simplicity.",
  },
};

const APPROACH_EXECUTOR_MAP: Record<ApproachName, ExecutorType> = {
  Conservative: "codex",
  Innovative: "gemini-cli" as ExecutorType,
  Pragmatic: "claude",
};

// ============================================
// ORCHESTRATOR CLASS
// ============================================

export class PrototypeOrchestrator {
  private task: OvernightTask;
  private store: OvernightTaskStore;
  private workspaceManager: WorkspaceManager;
  private onMilestone?: (milestone: string, message: string) => Promise<void>;

  constructor(
    task: OvernightTask,
    store: OvernightTaskStore,
    options?: {
      workspaceManager?: WorkspaceManager;
      onMilestone?: (milestone: string, message: string) => Promise<void>;
    }
  ) {
    this.task = task;
    this.store = store;
    this.workspaceManager = options?.workspaceManager ?? new WorkspaceManager();
    this.onMilestone = options?.onMilestone;
  }

  /**
   * Execute the full prototype generation workflow
   */
  async execute(): Promise<OrchestratorResult> {
    const startTime = Date.now();
    let totalTokens = 0;

    logger.info({ taskId: this.task.id, subject: this.task.subject }, "Starting prototype orchestration");

    try {
      // Phase 1: Update status to planning
      this.store.updateTaskStatus(this.task.id, "planning", { startedAt: new Date() });
      await this.notifyMilestone("planning", "📋 Planning complete. Generating 3 approaches...");

      // Phase 2: Generate approach strategies
      const strategies = await this.generateStrategies();

      // Phase 3: Create iterations in database
      const iterations = this.createIterations(strategies);

      // Phase 4: Update status to executing
      this.store.updateTaskStatus(this.task.id, "executing");
      await this.notifyMilestone("iteration_start", "🔨 Starting parallel execution...");

      // Phase 5: Execute iterations in parallel
      const results = await this.executeIterations(iterations, strategies);
      totalTokens = results.reduce((sum, r) => sum + (r.tokenUsage ?? 0), 0);

      // Phase 6: Cross-validate results
      this.store.updateTaskStatus(this.task.id, "synthesizing");
      await this.notifyMilestone("synthesis", "🔍 Cross-validating results...");
      await this.validateIterations(results);

      // Phase 7: Update status to ready
      this.store.updateTaskStatus(this.task.id, "ready", { completedAt: new Date() });
      await this.notifyMilestone("ready", "✅ Iterations complete. Preparing morning briefing...");

      const successfulIterations = results.filter((r) => r.status === "completed");

      return {
        success: successfulIterations.length > 0,
        iterations: results,
        durationMs: Date.now() - startTime,
        totalTokens,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ taskId: this.task.id, error: errorMessage }, "Prototype orchestration failed");

      this.store.updateTaskStatus(this.task.id, "failed", {
        error: errorMessage,
        completedAt: new Date(),
      });

      await this.notifyMilestone("failed", `❌ Failed: ${errorMessage}`);

      return {
        success: false,
        iterations: [],
        error: errorMessage,
        durationMs: Date.now() - startTime,
        totalTokens,
      };
    }
  }

  // ============================================
  // PHASE 1: STRATEGY GENERATION
  // ============================================

  private async generateStrategies(): Promise<ApproachStrategy[]> {
    const prompt = this.buildStrategyPrompt();

    logger.debug({ taskId: this.task.id }, "Generating approach strategies");

    const result = await executeGeminiWithFallback(prompt, "", {
      sandbox: true,
      yolo: false,
    });

    if (result.exitCode !== 0) {
      throw new Error(`Strategy generation failed: ${result.output}`);
    }

    return this.parseStrategies(result.output);
  }

  private buildStrategyPrompt(): string {
    const constraints = this.task.constraints.length > 0
      ? `\n\nConstraints:\n${this.task.constraints.map((c) => `- ${c}`).join("\n")}`
      : "";

    return `You are planning 3 different implementation approaches for an overnight coding task.

**Task:** ${this.task.subject}${constraints}

Generate 3 distinct implementation strategies:

## Approach A: Conservative
${APPROACH_DEFINITIONS.A.description}

## Approach B: Innovative
${APPROACH_DEFINITIONS.B.description}

## Approach C: Pragmatic
${APPROACH_DEFINITIONS.C.description}

For each approach, provide:
1. **Strategy** (2-3 sentences): The specific implementation plan
2. **Key decisions**: Libraries, patterns, architecture choices
3. **Trade-offs**: What you're optimizing for vs sacrificing

Respond in JSON format:
\`\`\`json
{
  "approaches": [
    {
      "label": "A",
      "name": "Conservative",
      "strategy": "...",
      "keyDecisions": ["..."],
      "tradeoffs": "..."
    },
    ...
  ]
}
\`\`\``;
  }

  private parseStrategies(output: string): ApproachStrategy[] {
    // Extract JSON from output
    const jsonMatch = output.match(/```json\n?([\s\S]*?)\n?```/);
    if (!jsonMatch) {
      // Fallback to default strategies
      return this.getDefaultStrategies();
    }

    try {
      const parsed = JSON.parse(jsonMatch[1] ?? "{}");
      return parsed.approaches.map((a: { label: ApproachLabel; name: ApproachName; strategy: string }) => ({
        label: a.label as ApproachLabel,
        name: a.name as ApproachName,
        description: a.strategy,
        executor: APPROACH_EXECUTOR_MAP[a.name],
        prompt: this.buildExecutionPrompt(a.label, a.name, a.strategy),
      }));
    } catch {
      return this.getDefaultStrategies();
    }
  }

  private getDefaultStrategies(): ApproachStrategy[] {
    const labels: ApproachLabel[] = ["A", "B", "C"];
    return labels.map((label) => {
      const def = APPROACH_DEFINITIONS[label];
      return {
        label,
        name: def.name,
        description: def.description,
        executor: APPROACH_EXECUTOR_MAP[def.name],
        prompt: this.buildExecutionPrompt(label, def.name, def.description),
      };
    });
  }

  private buildExecutionPrompt(label: ApproachLabel, name: ApproachName, strategy: string): string {
    const constraints = this.task.constraints.length > 0
      ? `\n\nConstraints:\n${this.task.constraints.map((c) => `- ${c}`).join("\n")}`
      : "";

    return `You are implementing Approach ${label} (${name}) for an overnight coding task.

**Task:** ${this.task.subject}${constraints}

**Your Approach:** ${strategy}

Instructions:
1. Implement the solution following your approach philosophy
2. Create all necessary files and modifications
3. Include tests if applicable
4. Write a brief summary of what you implemented

Focus on completeness and correctness. Your work will be reviewed in the morning.`;
  }

  // ============================================
  // PHASE 2: ITERATION CREATION
  // ============================================

  private createIterations(strategies: ApproachStrategy[]): OvernightIteration[] {
    return strategies.map((strategy) => {
      return this.store.createIteration({
        taskId: this.task.id,
        approachLabel: strategy.label,
        approachName: strategy.name,
        approachDescription: strategy.description,
        executor: strategy.executor,
      });
    });
  }

  // ============================================
  // PHASE 3: PARALLEL EXECUTION
  // ============================================

  private async executeIterations(
    iterations: OvernightIteration[],
    strategies: ApproachStrategy[]
  ): Promise<OvernightIteration[]> {
    // Create workspaces for each iteration
    const workspacePromises = iterations.map((iter) =>
      this.workspaceManager.createWorkspace({
        taskId: this.task.id,
        approachLabel: iter.approachLabel,
        basePath: DEFAULT_OVERNIGHT_CONFIG.workspacesDir,
      })
    );

    const workspaces = await Promise.all(workspacePromises);

    // Execute all iterations in parallel
    const executionPromises = iterations.map((iter, idx) => {
      const strategy = strategies.find((s) => s.label === iter.approachLabel)!;
      const workspace = workspaces[idx]!;
      return this.executeIteration(iter, strategy, workspace.path);
    });

    const results = await Promise.allSettled(executionPromises);

    // Process results
    return results.map((result, idx) => {
      if (result.status === "fulfilled") {
        return result.value;
      } else {
        // Mark as failed
        const iter = iterations[idx]!;
        this.store.updateIterationStatus(iter.id, "failed", {
          output: `Execution failed: ${result.reason}`,
          completedAt: new Date(),
        });
        return this.store.getIteration(iter.id)!;
      }
    });
  }

  private async executeIteration(
    iteration: OvernightIteration,
    strategy: ApproachStrategy,
    workspacePath: string
  ): Promise<OvernightIteration> {
    const startTime = Date.now();

    logger.info(
      { iterationId: iteration.id, approach: iteration.approachLabel, executor: strategy.executor },
      "Executing iteration"
    );

    // Update status to running
    this.store.updateIterationStatus(iteration.id, "running", {
      workspacePath,
      startedAt: new Date(),
    });

    try {
      // Build routing request based on executor
      const request: RoutingRequest = {
        query: strategy.prompt,
        taskType: "code-change",
        urgency: "batch",
        forceExecutor: strategy.executor,
        cwd: workspacePath,
      };

      const result = await executeWithRouting(request);

      // Collect artifacts
      const artifacts = await this.workspaceManager.collectArtifacts(workspacePath);
      const changeStats = await this.workspaceManager.getChangeStats(workspacePath);

      // Update iteration with results
      this.store.updateIterationStatus(iteration.id, "completed", {
        output: result.output,
        artifacts,
        tokenUsage: result.decision.estimatedCost * 1000, // Rough estimate
        durationMs: Date.now() - startTime,
        completedAt: new Date(),
      });

      logger.info(
        {
          iterationId: iteration.id,
          filesChanged: changeStats.filesChanged,
          duration: Date.now() - startTime,
        },
        "Iteration completed"
      );

      return this.store.getIteration(iteration.id)!;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.store.updateIterationStatus(iteration.id, "failed", {
        output: `Execution error: ${errorMessage}`,
        durationMs: Date.now() - startTime,
        completedAt: new Date(),
      });

      logger.error({ iterationId: iteration.id, error: errorMessage }, "Iteration failed");

      return this.store.getIteration(iteration.id)!;
    }
  }

  // ============================================
  // PHASE 4: CROSS-VALIDATION
  // ============================================

  private async validateIterations(iterations: OvernightIteration[]): Promise<void> {
    const completedIterations = iterations.filter((i) => i.status === "completed");

    if (completedIterations.length === 0) {
      logger.warn({ taskId: this.task.id }, "No completed iterations to validate");
      return;
    }

    // Use Codex to validate each iteration
    for (const iteration of completedIterations) {
      try {
        const validationResult = await this.validateIteration(iteration);
        this.store.updateIterationStatus(iteration.id, "completed", {
          validationScore: validationResult.score,
          validationNotes: validationResult.notes,
        });
      } catch (error) {
        logger.warn(
          { iterationId: iteration.id, error },
          "Validation failed, skipping"
        );
      }
    }
  }

  private async validateIteration(
    iteration: OvernightIteration
  ): Promise<{ score: number; notes: string }> {
    if (!iteration.workspacePath) {
      return { score: 50, notes: "No workspace to validate" };
    }

    const prompt = `Review this implementation for the task: "${this.task.subject}"

Approach: ${iteration.approachName} (${iteration.approachDescription})

Output:
${iteration.output?.slice(0, 2000) || "No output recorded"}

Rate this implementation on a scale of 0-100:
- Completeness: Does it fully address the task?
- Correctness: Is the implementation correct?
- Quality: Code quality, patterns, maintainability
- Risk: Any potential issues or risks?

Respond in JSON:
\`\`\`json
{
  "score": 85,
  "completeness": "...",
  "correctness": "...",
  "quality": "...",
  "risk": "...",
  "summary": "..."
}
\`\`\``;

    const result = await executeWithRouting({
      query: prompt,
      taskType: "verification",
      forceExecutor: "codex",
      urgency: "batch",
    });

    // Parse validation result
    const jsonMatch = result.output.match(/```json\n?([\s\S]*?)\n?```/);
    if (jsonMatch && jsonMatch[1]) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        return {
          score: parsed.score ?? 50,
          notes: parsed.summary ?? "Validation completed",
        };
      } catch {
        // Fall through
      }
    }

    // Default score
    return {
      score: 60,
      notes: result.output.slice(0, 200),
    };
  }

  // ============================================
  // MILESTONE NOTIFICATIONS
  // ============================================

  private async notifyMilestone(milestone: string, message: string): Promise<void> {
    // Record in database
    this.store.createMilestone({
      taskId: this.task.id,
      milestone: milestone as any,
      message,
    });

    // Notify via callback if provided
    if (this.onMilestone) {
      try {
        await this.onMilestone(milestone, message);
      } catch (error) {
        logger.warn({ error }, "Milestone notification failed");
      }
    }
  }
}
