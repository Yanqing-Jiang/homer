/**
 * Research Orchestrator
 *
 * Manages deep research tasks with:
 * - Query expansion (10+ sub-queries)
 * - Parallel harvest (web, docs, code)
 * - Validation loops (cross-reference)
 * - Synthesis via Kimi (2M context)
 *
 * Produces 3 interpretations: Conservative, Progressive, Balanced
 */

import { logger } from "../utils/logger.js";
import { executeWithRouting } from "../executors/router.js";
import { executeGeminiWithFallback } from "../executors/gemini-cli.js";
import { executeKimiCommand } from "../executors/kimi.js";
import { OvernightTaskStore } from "./task-store.js";
import type {
  OvernightTask,
  OvernightIteration,
  ApproachLabel,
  ApproachName,
  OrchestratorResult,
} from "./types.js";
import { DEFAULT_OVERNIGHT_CONFIG } from "./types.js";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

// ============================================
// RESEARCH CONFIGURATION
// ============================================

interface ResearchQuery {
  query: string;
  category: "web" | "docs" | "code" | "academic";
  priority: "high" | "medium" | "low";
}

interface HarvestResult {
  query: string;
  category: string;
  content: string;
  sources: string[];
  confidence: number;
}

interface SynthesisResult {
  label: ApproachLabel;
  name: ApproachName;
  summary: string;
  keyFindings: string[];
  recommendations: string[];
  concerns: string[];
  confidence: number;
}

// ============================================
// ORCHESTRATOR CLASS
// ============================================

export class ResearchOrchestrator {
  private task: OvernightTask;
  private store: OvernightTaskStore;
  private outputDir: string;
  private onMilestone?: (milestone: string, message: string) => Promise<void>;

  constructor(
    task: OvernightTask,
    store: OvernightTaskStore,
    options?: {
      outputDir?: string;
      onMilestone?: (milestone: string, message: string) => Promise<void>;
    }
  ) {
    this.task = task;
    this.store = store;
    this.outputDir = options?.outputDir ?? join(DEFAULT_OVERNIGHT_CONFIG.workspacesDir, task.id);
    this.onMilestone = options?.onMilestone;
  }

  /**
   * Execute the full research workflow
   */
  async execute(): Promise<OrchestratorResult> {
    const startTime = Date.now();
    let totalTokens = 0;

    logger.info({ taskId: this.task.id, subject: this.task.subject }, "Starting research orchestration");

    try {
      // Ensure output directory exists
      await mkdir(this.outputDir, { recursive: true });

      // Phase 1: Query Expansion
      this.store.updateTaskStatus(this.task.id, "planning", { startedAt: new Date() });
      await this.notifyMilestone("planning", "📋 Expanding research queries...");
      const queries = await this.expandQueries();
      totalTokens += 500;

      // Phase 2: Parallel Harvest
      this.store.updateTaskStatus(this.task.id, "executing");
      await this.notifyMilestone("iteration_start", `🔍 Harvesting from ${queries.length} sources...`);
      const harvestResults = await this.parallelHarvest(queries);
      totalTokens += queries.length * 1000;

      // Phase 3: Validation Loop
      await this.notifyMilestone("synthesis", "✅ Cross-validating findings...");
      const validatedResults = await this.validateFindings(harvestResults);

      // Phase 4: Synthesis with Kimi
      this.store.updateTaskStatus(this.task.id, "synthesizing");
      await this.notifyMilestone("synthesis", "🧠 Synthesizing with Kimi (2M context)...");
      const syntheses = await this.synthesizeFindings(validatedResults);
      totalTokens += 2000;

      // Phase 5: Create iterations from syntheses
      const iterations = await this.createIterationsFromSyntheses(syntheses);

      // Phase 6: Save artifacts
      await this.saveArtifacts(harvestResults, syntheses);

      // Phase 7: Update status to ready
      this.store.updateTaskStatus(this.task.id, "ready", { completedAt: new Date() });
      await this.notifyMilestone("ready", "✅ Research complete. Preparing morning briefing...");

      return {
        success: true,
        iterations,
        synthesis: this.formatSynthesisSummary(syntheses),
        durationMs: Date.now() - startTime,
        totalTokens,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ taskId: this.task.id, error: errorMessage }, "Research orchestration failed");

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
  // PHASE 1: QUERY EXPANSION
  // ============================================

  private async expandQueries(): Promise<ResearchQuery[]> {
    const prompt = `You are expanding a research topic into multiple specific queries.

**Topic:** ${this.task.subject}

**Constraints:**
${this.task.constraints.length > 0 ? this.task.constraints.map((c) => `- ${c}`).join("\n") : "None specified"}

Generate 10-15 specific research queries covering:
1. **Web** (3-4 queries): Current articles, blog posts, discussions
2. **Docs** (3-4 queries): Official documentation, API references
3. **Code** (2-3 queries): GitHub repos, implementations, examples
4. **Academic** (2-3 queries): Papers, research, formal analyses

For each query, provide priority (high/medium/low).

Respond in JSON:
\`\`\`json
{
  "queries": [
    {
      "query": "rate limiting best practices 2024",
      "category": "web",
      "priority": "high"
    },
    ...
  ]
}
\`\`\``;

    const result = await executeGeminiWithFallback(prompt, "", {
      sandbox: true,
      yolo: false,
    });

    if (result.exitCode !== 0) {
      // Fallback to basic queries
      return this.getDefaultQueries();
    }

    return this.parseQueries(result.output);
  }

  private parseQueries(output: string): ResearchQuery[] {
    const jsonMatch = output.match(/```json\n?([\s\S]*?)\n?```/);
    if (!jsonMatch) {
      return this.getDefaultQueries();
    }

    try {
      const parsed = JSON.parse(jsonMatch[1] ?? "{}");
      return parsed.queries.map((q: ResearchQuery) => ({
        query: q.query,
        category: q.category,
        priority: q.priority,
      }));
    } catch {
      return this.getDefaultQueries();
    }
  }

  private getDefaultQueries(): ResearchQuery[] {
    const subject = this.task.subject;
    return [
      { query: `${subject} best practices`, category: "web", priority: "high" },
      { query: `${subject} implementation guide`, category: "docs", priority: "high" },
      { query: `${subject} examples github`, category: "code", priority: "medium" },
      { query: `${subject} comparison alternatives`, category: "web", priority: "medium" },
      { query: `${subject} performance benchmarks`, category: "web", priority: "low" },
    ];
  }

  // ============================================
  // PHASE 2: PARALLEL HARVEST
  // ============================================

  private async parallelHarvest(queries: ResearchQuery[]): Promise<HarvestResult[]> {
    // Group queries by priority for staged execution
    const highPriority = queries.filter((q) => q.priority === "high");
    const mediumPriority = queries.filter((q) => q.priority === "medium");
    const lowPriority = queries.filter((q) => q.priority === "low");

    // Execute high priority first, then medium, then low
    const results: HarvestResult[] = [];

    // High priority in parallel
    const highResults = await Promise.allSettled(
      highPriority.map((q) => this.harvestQuery(q))
    );
    results.push(...this.extractSettledResults(highResults));

    // Medium priority in parallel
    const mediumResults = await Promise.allSettled(
      mediumPriority.map((q) => this.harvestQuery(q))
    );
    results.push(...this.extractSettledResults(mediumResults));

    // Low priority in parallel
    const lowResults = await Promise.allSettled(
      lowPriority.map((q) => this.harvestQuery(q))
    );
    results.push(...this.extractSettledResults(lowResults));

    return results;
  }

  private async harvestQuery(query: ResearchQuery): Promise<HarvestResult> {
    logger.debug({ query: query.query, category: query.category }, "Harvesting query");

    const prompt = `Research the following topic and provide a comprehensive summary.

**Query:** ${query.query}
**Category:** ${query.category}

Instructions:
1. Search for relevant information
2. Extract key insights and facts
3. Note any conflicting information
4. List all sources used

Provide a structured response with:
- Main findings (3-5 bullet points)
- Key details
- Sources (URLs if available)
- Confidence level (0-1)`;

    const result = await executeWithRouting({
      query: prompt,
      taskType: "discovery",
      urgency: "batch",
      forceExecutor: "gemini-cli",
    });

    return {
      query: query.query,
      category: query.category,
      content: result.output,
      sources: this.extractSources(result.output),
      confidence: this.estimateConfidence(result.output),
    };
  }

  private extractSources(content: string): string[] {
    const urlPattern = /https?:\/\/[^\s<>"]+/g;
    const matches = content.match(urlPattern) || [];
    return [...new Set(matches)]; // Deduplicate
  }

  private estimateConfidence(content: string): number {
    // Simple heuristic based on content length and structure
    if (content.length < 100) return 0.3;
    if (content.length < 500) return 0.5;
    if (content.includes("source") || content.includes("according to")) return 0.8;
    return 0.6;
  }

  private extractSettledResults(settled: PromiseSettledResult<HarvestResult>[]): HarvestResult[] {
    return settled
      .filter((r): r is PromiseFulfilledResult<HarvestResult> => r.status === "fulfilled")
      .map((r) => r.value);
  }

  // ============================================
  // PHASE 3: VALIDATION LOOP
  // ============================================

  private async validateFindings(results: HarvestResult[]): Promise<HarvestResult[]> {
    // Cross-reference findings to flag contradictions
    const validatedResults = [...results];

    // Group by category for cross-validation
    const byCategory = new Map<string, HarvestResult[]>();
    for (const result of results) {
      const existing = byCategory.get(result.category) || [];
      existing.push(result);
      byCategory.set(result.category, existing);
    }

    // For each category, compare findings
    for (const [category, categoryResults] of byCategory) {
      if (categoryResults.length < 2) continue;

      // Simple validation: check if any result contradicts others
      const validationPrompt = `Compare these research findings for contradictions:

${categoryResults.map((r, i) => `Finding ${i + 1}:\n${r.content.slice(0, 500)}`).join("\n\n")}

List any contradictions or inconsistencies found. If findings are consistent, say "CONSISTENT".`;

      try {
        const validationResult = await executeWithRouting({
          query: validationPrompt,
          taskType: "verification",
          forceExecutor: "codex",
          urgency: "batch",
        });

        // Adjust confidence based on validation
        if (validationResult.output.includes("CONSISTENT")) {
          for (const result of categoryResults) {
            result.confidence = Math.min(1, result.confidence + 0.1);
          }
        } else {
          // Flag potential issues
          logger.info({ category }, "Validation found potential contradictions");
        }
      } catch (error) {
        logger.warn({ category, error }, "Validation failed for category");
      }
    }

    return validatedResults;
  }

  // ============================================
  // PHASE 4: SYNTHESIS WITH KIMI
  // ============================================

  private async synthesizeFindings(results: HarvestResult[]): Promise<SynthesisResult[]> {
    // Compile all findings into a single context
    const compiledContext = results
      .map((r) => `## ${r.query} (${r.category}, confidence: ${r.confidence})\n\n${r.content}`)
      .join("\n\n---\n\n");

    const synthesisPrompt = `You are synthesizing research findings into 3 distinct interpretations.

**Research Topic:** ${this.task.subject}

**Compiled Findings:**
${compiledContext}

Generate 3 interpretations of these findings:

## Interpretation A: Conservative
Focus on well-established facts, proven approaches, and cautious conclusions.

## Interpretation B: Progressive
Focus on emerging trends, innovative possibilities, and forward-looking conclusions.

## Interpretation C: Balanced
Balance established knowledge with new developments, practical recommendations.

For each interpretation, provide:
1. Summary (2-3 sentences)
2. Key findings (3-5 bullets)
3. Recommendations (2-3 actionable items)
4. Concerns or caveats
5. Confidence score (0-100)

Respond in JSON:
\`\`\`json
{
  "interpretations": [
    {
      "label": "A",
      "name": "Conservative",
      "summary": "...",
      "keyFindings": ["..."],
      "recommendations": ["..."],
      "concerns": ["..."],
      "confidence": 85
    },
    ...
  ]
}
\`\`\``;

    // Use Kimi for synthesis (2M context window)
    const result = await executeKimiCommand(synthesisPrompt, {
      maxTokens: 4096,
    });

    if (result.exitCode !== 0) {
      return this.getDefaultSyntheses();
    }

    return this.parseSyntheses(result.output);
  }

  private parseSyntheses(output: string): SynthesisResult[] {
    const jsonMatch = output.match(/```json\n?([\s\S]*?)\n?```/);
    if (!jsonMatch) {
      return this.getDefaultSyntheses();
    }

    try {
      const parsed = JSON.parse(jsonMatch[1] ?? "{}");
      return parsed.interpretations.map((i: SynthesisResult) => ({
        label: i.label as ApproachLabel,
        name: i.name as ApproachName,
        summary: i.summary,
        keyFindings: i.keyFindings,
        recommendations: i.recommendations,
        concerns: i.concerns || [],
        confidence: i.confidence / 100,
      }));
    } catch {
      return this.getDefaultSyntheses();
    }
  }

  private getDefaultSyntheses(): SynthesisResult[] {
    const interpretations: Array<{ label: ApproachLabel; name: ApproachName }> = [
      { label: "A", name: "Conservative" },
      { label: "B", name: "Innovative" },
      { label: "C", name: "Pragmatic" },
    ];

    return interpretations.map((i) => ({
      label: i.label,
      name: i.name,
      summary: `${i.name} interpretation of research on ${this.task.subject}`,
      keyFindings: ["Research synthesis required manual review"],
      recommendations: ["Review raw findings for detailed analysis"],
      concerns: ["Automatic synthesis was limited"],
      confidence: 0.5,
    }));
  }

  // ============================================
  // PHASE 5: CREATE ITERATIONS
  // ============================================

  private async createIterationsFromSyntheses(
    syntheses: SynthesisResult[]
  ): Promise<OvernightIteration[]> {
    const iterations: OvernightIteration[] = [];

    for (const synthesis of syntheses) {
      const iteration = this.store.createIteration({
        taskId: this.task.id,
        approachLabel: synthesis.label,
        approachName: synthesis.name,
        approachDescription: synthesis.summary,
        executor: "kimi",
      });

      // Update with results
      this.store.updateIterationStatus(iteration.id, "completed", {
        output: this.formatSynthesisOutput(synthesis),
        validationScore: synthesis.confidence * 100,
        completedAt: new Date(),
      });

      iterations.push(this.store.getIteration(iteration.id)!);
    }

    return iterations;
  }

  private formatSynthesisOutput(synthesis: SynthesisResult): string {
    return `# ${synthesis.name} Interpretation

${synthesis.summary}

## Key Findings
${synthesis.keyFindings.map((f) => `- ${f}`).join("\n")}

## Recommendations
${synthesis.recommendations.map((r) => `- ${r}`).join("\n")}

## Concerns
${synthesis.concerns.map((c) => `- ${c}`).join("\n")}

---
Confidence: ${Math.round(synthesis.confidence * 100)}%`;
  }

  // ============================================
  // PHASE 6: SAVE ARTIFACTS
  // ============================================

  private async saveArtifacts(
    harvestResults: HarvestResult[],
    syntheses: SynthesisResult[]
  ): Promise<void> {
    // Save raw harvest results
    const harvestPath = join(this.outputDir, "harvest.md");
    const harvestContent = harvestResults
      .map((r) => `## ${r.query}\n\n${r.content}\n\n**Sources:** ${r.sources.join(", ")}`)
      .join("\n\n---\n\n");
    await writeFile(harvestPath, harvestContent);

    // Save syntheses
    const synthesisPath = join(this.outputDir, "synthesis.md");
    const synthesisContent = syntheses
      .map((s) => this.formatSynthesisOutput(s))
      .join("\n\n---\n\n");
    await writeFile(synthesisPath, synthesisContent);

    // Save summary
    const summaryPath = join(this.outputDir, "summary.md");
    const summaryContent = this.formatSynthesisSummary(syntheses);
    await writeFile(summaryPath, summaryContent);

    logger.info({ outputDir: this.outputDir }, "Research artifacts saved");
  }

  private formatSynthesisSummary(syntheses: SynthesisResult[]): string {
    return `# Research Summary: ${this.task.subject}

## Overview
Completed overnight research with ${syntheses.length} interpretations.

## Interpretations

${syntheses.map((s) => `### ${s.label}: ${s.name}
${s.summary}

**Top Finding:** ${s.keyFindings[0] || "N/A"}
**Confidence:** ${Math.round(s.confidence * 100)}%
`).join("\n")}

## Files
- \`harvest.md\` - Raw research findings
- \`synthesis.md\` - Detailed interpretations
- \`summary.md\` - This summary`;
  }

  // ============================================
  // MILESTONE NOTIFICATIONS
  // ============================================

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
