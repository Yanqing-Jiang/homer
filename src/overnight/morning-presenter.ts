/**
 * Morning Presenter
 *
 * Formats overnight work results for morning presentation:
 * - Comparison matrix (LOC, risk, validation score)
 * - Telegram inline keyboard for selection
 * - PR creation on selection
 */

import { spawn } from "child_process";
import { logger } from "../utils/logger.js";
import { OvernightTaskStore } from "./task-store.js";
import type {
  OvernightTask,
  OvernightIteration,
  MorningChoice,
  RankedOption,
  ComparisonMatrix,
  ComparisonRow,
  ApproachLabel,
} from "./types.js";
import { DEFAULT_OVERNIGHT_CONFIG } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

// ============================================
// PRESENTER CLASS
// ============================================

export class MorningPresenter {
  private store: OvernightTaskStore;
  private workspaceManager: WorkspaceManager;

  constructor(store: OvernightTaskStore, workspaceManager?: WorkspaceManager) {
    this.store = store;
    this.workspaceManager = workspaceManager ?? new WorkspaceManager();
  }

  /**
   * Prepare morning choices for a completed task
   */
  async prepareMorningChoices(task: OvernightTask): Promise<MorningChoice | null> {
    const iterations = this.store.getIterationsByTask(task.id);
    const completedIterations = iterations.filter((i) => i.status === "completed");

    if (completedIterations.length === 0) {
      logger.warn({ taskId: task.id }, "No completed iterations for morning presentation");
      return null;
    }

    // Build ranked options
    const options = await this.buildRankedOptions(completedIterations);

    // Build comparison matrix
    const comparisonMatrix = await this.buildComparisonMatrix(completedIterations);

    // Determine recommendation
    const { recommendation, reason } = this.determineRecommendation(options);

    // Calculate expiration
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + DEFAULT_OVERNIGHT_CONFIG.choiceExpirationHours);

    // Create morning choice record
    const choice = this.store.createMorningChoice({
      taskId: task.id,
      options,
      comparisonMatrix,
      recommendation,
      recommendationReason: reason,
      expiresAt,
    });

    logger.info(
      { taskId: task.id, choiceId: choice.id, recommendation },
      "Morning choices prepared"
    );

    return choice;
  }

  /**
   * Format morning choices for Telegram display
   */
  formatTelegramMessage(task: OvernightTask, choice: MorningChoice): string {
    let message = `🌅 *Overnight Work Complete*\n\n`;
    message += `**${task.subject}**\n\n`;

    // Comparison table
    message += this.formatComparisonTable(choice.comparisonMatrix);

    // Recommendation
    const recOption = choice.options.find((o) => o.label === choice.recommendation);
    if (recOption) {
      message += `\n*Recommendation:* Option ${choice.recommendation} - ${recOption.name}\n`;
      message += `_${choice.recommendationReason}_\n`;
    }

    return message;
  }

  /**
   * Build Telegram inline keyboard for choices
   */
  buildInlineKeyboard(task: OvernightTask, choice: MorningChoice): InlineKeyboardButton[][] {
    const rows: InlineKeyboardButton[][] = [];

    // Option buttons row
    const optionRow: InlineKeyboardButton[] = choice.options.map((opt) => ({
      text: `${opt.label}: ${opt.name}`,
      callback_data: encodeCallbackData({
        action: "select",
        taskId: task.id,
        option: opt.label,
      }),
    }));
    rows.push(optionRow);

    // Action buttons row
    rows.push([
      {
        text: "📊 Compare All",
        callback_data: encodeCallbackData({
          action: "compare",
          taskId: task.id,
        }),
      },
      {
        text: "⏭ Skip",
        callback_data: encodeCallbackData({
          action: "skip",
          taskId: task.id,
        }),
      },
    ]);

    return rows;
  }

  /**
   * Handle user selection of an option
   */
  async handleSelection(
    task: OvernightTask,
    choice: MorningChoice,
    selectedOption: ApproachLabel
  ): Promise<SelectionResult> {
    const iteration = this.store
      .getIterationsByTask(task.id)
      .find((i) => i.approachLabel === selectedOption);

    if (!iteration) {
      return {
        success: false,
        error: `Iteration ${selectedOption} not found`,
      };
    }

    // Create PR if workspace exists
    let prUrl: string | undefined;
    let prNumber: number | undefined;

    if (iteration.workspacePath && iteration.gitBranch) {
      try {
        const prResult = await this.createPullRequest(task, iteration);
        prUrl = prResult.url;
        prNumber = prResult.number;
      } catch (error) {
        logger.error({ error }, "Failed to create PR");
        return {
          success: false,
          error: `Failed to create PR: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    // Update choice record
    this.store.updateMorningChoiceSelection(choice.id, selectedOption, {
      prUrl,
      prNumber,
    });

    // Update task status
    this.store.updateTaskStatus(task.id, prUrl ? "applied" : "selected");

    return {
      success: true,
      prUrl,
      prNumber,
    };
  }

  /**
   * Handle skip action
   */
  handleSkip(task: OvernightTask, choice: MorningChoice): void {
    this.store.updateMorningChoiceSelection(choice.id, "skip");
    this.store.updateTaskStatus(task.id, "skipped");

    // Optionally clean up workspaces
    this.workspaceManager.removeTaskWorkspaces(task.id).catch((error) => {
      logger.warn({ error, taskId: task.id }, "Failed to clean up workspaces");
    });
  }

  /**
   * Format detailed comparison for a specific option
   */
  formatDetailedComparison(choice: MorningChoice): string {
    let message = `📊 *Detailed Comparison*\n\n`;

    for (const option of choice.options) {
      message += `## ${option.label}: ${option.name}\n`;
      message += `${option.description}\n\n`;
      message += `*Summary:* ${option.summary}\n\n`;

      if (option.highlights.length > 0) {
        message += `*Highlights:*\n`;
        message += option.highlights.map((h) => `  • ${h}`).join("\n");
        message += "\n\n";
      }

      if (option.concerns && option.concerns.length > 0) {
        message += `*Concerns:*\n`;
        message += option.concerns.map((c) => `  ⚠️ ${c}`).join("\n");
        message += "\n\n";
      }

      message += `*Stats:* ${option.linesChanged} lines, ${option.filesChanged} files, Risk: ${option.riskLevel}\n`;
      message += `*Validation Score:* ${option.validationScore}/100\n\n`;
      message += `---\n\n`;
    }

    return message;
  }

  // ============================================
  // PRIVATE HELPERS
  // ============================================

  private async buildRankedOptions(
    iterations: OvernightIteration[]
  ): Promise<RankedOption[]> {
    const options: RankedOption[] = [];

    for (const iter of iterations) {
      // Get change stats from workspace
      let linesChanged = 0;
      let filesChanged = 0;

      if (iter.workspacePath) {
        try {
          const stats = await this.workspaceManager.getChangeStats(iter.workspacePath);
          linesChanged = stats.insertions + stats.deletions;
          filesChanged = stats.filesChanged;
        } catch {
          // Ignore
        }
      }

      // Parse output for summary
      const summary = this.extractSummary(iter.output || "");
      const highlights = this.extractHighlights(iter.output || "");

      options.push({
        label: iter.approachLabel,
        name: iter.approachName,
        description: iter.approachDescription || "",
        linesChanged,
        filesChanged,
        riskLevel: this.assessRisk(linesChanged, filesChanged),
        validationScore: iter.validationScore ?? 50,
        summary,
        highlights,
        concerns: iter.validationNotes ? [iter.validationNotes] : undefined,
      });
    }

    // Sort by validation score (descending)
    options.sort((a, b) => b.validationScore - a.validationScore);

    return options;
  }

  private async buildComparisonMatrix(
    iterations: OvernightIteration[]
  ): Promise<ComparisonMatrix> {
    const headers = ["Approach", "Lines", "Files", "Risk", "Score"];
    const rows: ComparisonRow[] = [];

    for (const iter of iterations) {
      let stats = { filesChanged: 0, insertions: 0, deletions: 0 };

      if (iter.workspacePath) {
        try {
          stats = await this.workspaceManager.getChangeStats(iter.workspacePath);
        } catch {
          // Ignore
        }
      }

      rows.push({
        approach: iter.approachLabel,
        name: iter.approachName,
        values: {
          Lines: `+${stats.insertions}/-${stats.deletions}`,
          Files: stats.filesChanged,
          Risk: this.assessRisk(stats.insertions + stats.deletions, stats.filesChanged),
          Score: iter.validationScore ?? 50,
        },
      });
    }

    return { headers, rows };
  }

  private formatComparisonTable(matrix: ComparisonMatrix): string {
    if (matrix.rows.length === 0) {
      return "_No comparison data available_\n";
    }

    let table = "| Approach | Lines | Risk | Score |\n";
    table += "|----------|-------|------|-------|\n";

    for (const row of matrix.rows) {
      table += `| ${row.approach}: ${row.name} | ${row.values.Lines} | ${row.values.Risk} | ${row.values.Score} |\n`;
    }

    return table;
  }

  private determineRecommendation(
    options: RankedOption[]
  ): { recommendation: ApproachLabel; reason: string } {
    if (options.length === 0) {
      return { recommendation: "A", reason: "No options available" };
    }

    // Find best option (highest validation score with reasonable risk)
    const sortedByScore = [...options].sort((a, b) => {
      // Penalize high risk
      const aScore = a.validationScore - (a.riskLevel === "high" ? 10 : 0);
      const bScore = b.validationScore - (b.riskLevel === "high" ? 10 : 0);
      return bScore - aScore;
    });

    const best = sortedByScore[0]!;
    let reason = "";

    if (best.validationScore >= 80) {
      reason = "Highest validation score with good quality";
    } else if (best.riskLevel === "low") {
      reason = "Safest approach with acceptable quality";
    } else {
      reason = "Best balance of quality and risk";
    }

    return { recommendation: best.label, reason };
  }

  private assessRisk(linesChanged: number, filesChanged: number): "low" | "medium" | "high" {
    if (linesChanged > 500 || filesChanged > 10) return "high";
    if (linesChanged > 100 || filesChanged > 5) return "medium";
    return "low";
  }

  private extractSummary(output: string): string {
    // Try to find a summary section
    const summaryMatch = output.match(/(?:summary|overview|description):\s*(.+?)(?:\n\n|\n#|$)/is);
    if (summaryMatch && summaryMatch[1]) {
      return summaryMatch[1].trim().slice(0, 200);
    }

    // Fall back to first paragraph
    const firstParagraph = output.split("\n\n")[0] ?? "";
    return firstParagraph.slice(0, 200);
  }

  private extractHighlights(output: string): string[] {
    const highlights: string[] = [];

    // Look for bullet points
    const bulletMatch = output.match(/[-*]\s+(.+)/g);
    if (bulletMatch) {
      highlights.push(...bulletMatch.slice(0, 3).map((b) => b.replace(/^[-*]\s+/, "")));
    }

    return highlights;
  }

  private async createPullRequest(
    task: OvernightTask,
    iteration: OvernightIteration
  ): Promise<{ url: string; number: number }> {
    const title = `feat: ${task.subject} (${iteration.approachName} approach)`;
    const body = `## Summary
Overnight implementation of: ${task.subject}

**Approach:** ${iteration.approachName}
${iteration.approachDescription || ""}

## Changes
${iteration.output?.slice(0, 1000) || "See commits for details."}

---
🤖 Generated with HOMER overnight work`;

    // Use gh CLI to create PR
    return new Promise((resolve, reject) => {
      const args = [
        "pr",
        "create",
        "--title",
        title,
        "--body",
        body,
        "--head",
        iteration.gitBranch!,
      ];

      const proc = spawn("gh", args, {
        cwd: iteration.workspacePath,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          // Parse PR URL from output
          const urlMatch = stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
          if (urlMatch && urlMatch[0] && urlMatch[1]) {
            resolve({
              url: urlMatch[0],
              number: parseInt(urlMatch[1], 10),
            });
          } else {
            // URL might be on its own line
            const url = stdout.trim();
            const numberMatch = url.match(/\/pull\/(\d+)/);
            resolve({
              url,
              number: numberMatch && numberMatch[1] ? parseInt(numberMatch[1], 10) : 0,
            });
          }
        } else {
          reject(new Error(`gh pr create failed: ${stderr}`));
        }
      });

      proc.on("error", reject);
    });
  }
}

// ============================================
// TYPES
// ============================================

interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

interface SelectionResult {
  success: boolean;
  prUrl?: string;
  prNumber?: number;
  error?: string;
}

// ============================================
// CALLBACK DATA ENCODING
// ============================================

function encodeCallbackData(data: {
  action: string;
  taskId: string;
  option?: string;
}): string {
  return `overnight:${data.action}:${data.taskId}:${data.option || ""}`;
}

// ============================================
// EXPORTS
// ============================================

export { encodeCallbackData };
export type { SelectionResult, InlineKeyboardButton };
