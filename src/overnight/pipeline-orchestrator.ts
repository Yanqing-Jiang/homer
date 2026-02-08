import { logger } from "../utils/logger.js";
import { executeClaudeCommand } from "../executors/claude.js";
import { executeGeminiWithFallback } from "../executors/opencode-cli.js";
import { executeWithRouting } from "../executors/router.js";
import { OvernightTaskStore } from "./task-store.js";
import { WorkspaceManager } from "./workspace.js";
import type { OvernightTask, OvernightIteration, OrchestratorResult } from "./types.js";
import { DEFAULT_OVERNIGHT_CONFIG } from "./types.js";

interface PlanMeta {
  summary?: string;
  done?: boolean;
  next_iteration_needed?: boolean;
  next_iteration_focus?: string;
}

interface PipelineResult extends OrchestratorResult {
  done: boolean;
  nextIterationNeeded: boolean;
  summary: string;
}

type ExecutorMode = "claude" | "gemini";

export class PipelineOrchestrator {
  private task: OvernightTask;
  private store: OvernightTaskStore;
  private workspaceManager: WorkspaceManager;
  private onMilestone?: (milestone: string, message: string) => Promise<void>;
  private fallbackMode: ExecutorMode = "claude";

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

  async execute(): Promise<PipelineResult> {
    const startTime = Date.now();
    let totalTokens = 0;
    const baseCwd = `${process.env.HOME ?? "/Users/yj"}/homer`;

    const iterationIndex = this.store.getIterationsByTask(this.task.id).length + 1;
    const previous = this.store.getIterationsByTask(this.task.id).slice(-1)[0];

    try {
      this.store.updateTaskStatus(this.task.id, "planning", { startedAt: new Date() });
      await this.notifyMilestone("planning", `📋 Planning iteration ${iterationIndex}...`);

      const planPrompt = this.buildPlanPrompt(previous?.output);
      const planResult = await this.runWithFallback(planPrompt, { cwd: baseCwd });
      totalTokens += 1000;

      const planMeta = this.extractMeta(planResult.output);

      const iteration = this.store.createIteration({
        taskId: this.task.id,
        approachLabel: "A",
        approachName: "Pragmatic",
        approachDescription: `Pipeline iteration ${iterationIndex}`,
        executor: this.fallbackMode === "claude" ? "claude" : "opencode",
      });

      this.store.updateIterationStatus(iteration.id, "running", {
        startedAt: new Date(),
      });

      // Execution
      this.store.updateTaskStatus(this.task.id, "executing");
      await this.notifyMilestone("iteration_start", "🔨 Executing plan...");

      let executionOutput = "";
      if (this.task.type === "prototype_work") {
        const workspace = await this.workspaceManager.createWorkspace({
          taskId: this.task.id,
          approachLabel: "A",
          basePath: DEFAULT_OVERNIGHT_CONFIG.workspacesDir,
        });
        const execPrompt = this.buildExecutionPrompt(planResult.output, previous?.output);
        const execResult = await this.runWithFallback(execPrompt, { cwd: workspace.path });
        executionOutput = execResult.output;

        const artifacts = await this.workspaceManager.collectArtifacts(workspace.path);
        await this.workspaceManager.getChangeStats(workspace.path);

        this.store.updateIterationStatus(iteration.id, "completed", {
          workspacePath: workspace.path,
          output: executionOutput,
          artifacts,
          durationMs: Date.now() - startTime,
          completedAt: new Date(),
        });
        totalTokens += 2000;
      } else {
        const execPrompt = this.buildResearchPrompt(planResult.output, previous?.output);
        const execResult = await this.runWithFallback(execPrompt, { cwd: baseCwd });
        executionOutput = execResult.output;

        this.store.updateIterationStatus(iteration.id, "completed", {
          output: executionOutput,
          durationMs: Date.now() - startTime,
          completedAt: new Date(),
        });
        totalTokens += 2000;
      }

      // Verification (Codex)
      this.store.updateTaskStatus(this.task.id, "synthesizing");
      await this.notifyMilestone("synthesis", "🔍 Codex verification...");

      const verification = await executeWithRouting({
        query: this.buildVerificationPrompt(planResult.output, executionOutput),
        taskType: "verification",
        forceExecutor: "codex",
        urgency: "batch",
      });

      const execMeta = this.extractMeta(executionOutput);
      const summary = execMeta.summary ?? planMeta.summary ?? executionOutput.slice(0, 400);
      const done = execMeta.done ?? planMeta.done ?? false;
      const nextIterationNeeded = execMeta.next_iteration_needed ?? planMeta.next_iteration_needed ?? false;

      const combinedOutput = [
        "## Plan",
        planResult.output.trim(),
        "",
        "## Execution",
        executionOutput.trim(),
        "",
        "## Verification",
        verification.output.trim(),
      ].join("\n");

      this.store.updateIterationStatus(iteration.id, "completed", {
        output: combinedOutput,
        validationNotes: verification.output.slice(0, 1000),
        validationScore: done ? 90 : 70,
        completedAt: new Date(),
      });

      if (!nextIterationNeeded) {
        this.store.updateTaskStatus(this.task.id, "ready", { completedAt: new Date() });
        await this.notifyMilestone("ready", "✅ Task complete. Ready for morning review.");
      } else {
        await this.notifyMilestone("synthesis", "⏭ Iteration scheduled for later tonight.");
      }

      return {
        success: true,
        iterations: [this.store.getIteration(iteration.id)! as OvernightIteration],
        durationMs: Date.now() - startTime,
        totalTokens,
        done,
        nextIterationNeeded,
        summary,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ taskId: this.task.id, error: message }, "Pipeline orchestration failed");
      this.store.updateTaskStatus(this.task.id, "failed", {
        error: message,
        completedAt: new Date(),
      });
      await this.notifyMilestone("failed", `❌ Failed: ${message}`);
      return {
        success: false,
        iterations: [],
        error: message,
        durationMs: Date.now() - startTime,
        totalTokens,
        done: false,
        nextIterationNeeded: false,
        summary: message,
      };
    }
  }

  private async runWithFallback(
    prompt: string,
    options: { cwd: string }
  ): Promise<{ output: string; exitCode: number; executor: ExecutorMode }> {
    try {
      const result = await executeClaudeCommand(prompt, { cwd: options.cwd });
      if (result.exitCode === 0) {
        this.fallbackMode = "claude";
        return { output: result.output, exitCode: result.exitCode, executor: "claude" };
      }
      logger.warn({ taskId: this.task.id }, "Claude failed, falling back to Gemini");
    } catch (error) {
      logger.warn({ taskId: this.task.id, error }, "Claude execution error, falling back to Gemini");
    }

    this.fallbackMode = "gemini";
    const gemini = await executeGeminiWithFallback(prompt, "", { sandbox: false });
    return { output: gemini.output, exitCode: gemini.exitCode, executor: "gemini" };
  }

  private buildPlanPrompt(previousOutput?: string): string {
    const constraints = this.task.constraints.length > 0
      ? `\nConstraints:\n${this.task.constraints.map(c => `- ${c}`).join("\n")}`
      : "";
    const prev = previousOutput
      ? `\n\nPrevious iteration context:\n${previousOutput.slice(0, 1500)}`
      : "";

    return `You are the overnight planner. Plan the task below using Claude Code as the primary orchestrator.

Task: ${this.task.subject}
Type: ${this.task.type}${constraints}${prev}

Instructions:
1) Use Claude Code to plan. If research is needed, spawn multiple Gemini subagents in parallel.
2) Use bird CLI for X/Twitter signals when relevant.
3) Use NotebookLM MCP for deep research if needed.
4) Return a crisp step-by-step plan.

Output a JSON block at the end:
\`\`\`json
{
  "summary": "1-2 sentence summary",
  "done": false,
  "next_iteration_needed": false,
  "next_iteration_focus": "optional"
}
\`\`\``;
  }

  private buildExecutionPrompt(planOutput: string, previousOutput?: string): string {
    const prev = previousOutput
      ? `\n\nPrevious iteration context:\n${previousOutput.slice(0, 1500)}`
      : "";
    return `You are executing the approved plan for this coding task.

Plan:
${planOutput}${prev}

Instructions:
1) Implement the plan using Claude Code.
2) Use subagents (Gemini, bird, NotebookLM) if they help.
3) Provide a concise summary and next steps.

Output a JSON block at the end:
\`\`\`json
{
  "summary": "1-2 sentence summary",
  "done": true,
  "next_iteration_needed": false,
  "next_iteration_focus": "optional"
}
\`\`\``;
  }

  private buildResearchPrompt(planOutput: string, previousOutput?: string): string {
    const prev = previousOutput
      ? `\n\nPrevious iteration context:\n${previousOutput.slice(0, 1500)}`
      : "";
    return `You are executing a research task using Claude Code as the orchestrator.

Plan:
${planOutput}${prev}

Instructions:
1) Use Claude Code to control multiple Gemini subagents for parallel research.
2) Use bird CLI for X/Twitter signals if relevant.
3) Use NotebookLM MCP for deep research when helpful.
4) Consolidate findings into a structured summary with sources.

Output a JSON block at the end:
\`\`\`json
{
  "summary": "1-2 sentence summary",
  "done": true,
  "next_iteration_needed": false,
  "next_iteration_focus": "optional"
}
\`\`\``;
  }

  private buildVerificationPrompt(planOutput: string, execOutput: string): string {
    return `Verify the following overnight work.

Plan:
${planOutput.slice(0, 2000)}

Execution:
${execOutput.slice(0, 4000)}

Check for:
1) Completeness vs plan
2) Correctness and risks
3) Missing steps or errors
4) Suggested fixes or next iteration needs

Respond with a concise review and any critical issues.`;
  }

  private extractMeta(output: string): PlanMeta {
    const match = output.match(/```json\n?([\s\S]*?)\n?```/);
    if (!match || !match[1]) return {};
    try {
      const parsed = JSON.parse(match[1]);
      return {
        summary: parsed.summary,
        done: parsed.done,
        next_iteration_needed: parsed.next_iteration_needed,
        next_iteration_focus: parsed.next_iteration_focus,
      };
    } catch {
      return {};
    }
  }

  private async notifyMilestone(milestone: string, message: string): Promise<void> {
    this.store.createMilestone({
      taskId: this.task.id,
      milestone: milestone as any,
      message,
    });

    if (this.onMilestone) {
      try {
        await this.onMilestone(milestone, message);
      } catch (error) {
        logger.warn({ error }, "Milestone notification failed");
      }
    }
  }
}
