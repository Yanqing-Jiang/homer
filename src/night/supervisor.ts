/**
 * Night Supervisor
 *
 * Main orchestrator for the autonomous night mode.
 * Runs Gemini CLI to plan and execute overnight tasks.
 */

import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import type {
  NightSession,
  NightPlan,
  NightModeConfig,
  NightPhase,
} from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { buildContextPack } from "./context.js";
import { JobQueue, shouldAutoExecute, formatJobsForBriefing } from "./jobs.js";
import { executeGeminiWithFallback } from "../executors/gemini-cli.js";
import { generateMorningBriefing } from "../executors/gemini.js";
import { logger } from "../utils/logger.js";
import { OvernightTaskStore, PrototypeOrchestrator, ResearchOrchestrator } from "../overnight/index.js";
import type { OvernightTask } from "../overnight/types.js";
import type Database from "better-sqlite3";

// ============================================
// NIGHT SUPERVISOR CLASS
// ============================================

export class NightSupervisor {
  private config: NightModeConfig;
  private session: NightSession | null = null;
  private jobQueue: JobQueue;
  private isRunning = false;
  private db: Database.Database | null = null;
  private overnightStore: OvernightTaskStore | null = null;
  private onOvernightMilestone?: (chatId: number, milestone: string, message: string) => Promise<void>;

  constructor(config: Partial<NightModeConfig> = {}, options?: {
    db?: Database.Database;
    onOvernightMilestone?: (chatId: number, milestone: string, message: string) => Promise<void>;
  }) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.jobQueue = new JobQueue();
    this.db = options?.db ?? null;
    this.onOvernightMilestone = options?.onOvernightMilestone;
    if (this.db) {
      this.overnightStore = new OvernightTaskStore(this.db);
    }
  }

  // ----------------------------------------
  // Main Entry Point
  // ----------------------------------------

  async run(dryRun = false): Promise<NightSession> {
    if (this.isRunning) {
      throw new Error("Night supervisor is already running");
    }

    this.isRunning = true;
    const startTime = Date.now();

    // Initialize session
    this.session = {
      id: `night_${randomUUID().slice(0, 8)}`,
      startedAt: new Date(),
      phase: "ingestion",
      jobs: [],
      findings: [],
      proposals: [],
      jobsCompleted: 0,
      jobsFailed: 0,
      totalDuration: 0,
    };

    logger.info({ sessionId: this.session.id, dryRun }, "Night supervisor starting");

    try {
      // Ensure output directories exist
      await this.ensureDirectories();

      // Phase 0: Process queued overnight tasks (ad-hoc user requests)
      await this.processOvernightTasks();

      // Phase 1: Ingestion - Build context
      await this.setPhase("ingestion");
      const contextPack = await buildContextPack(this.config);

      // Phase 2: Planning - Ask Gemini for a plan
      await this.setPhase("deep_work");
      const plan = await this.generatePlan(contextPack.compiled, dryRun);

      if (!plan) {
        logger.warn("No plan generated, ending night session");
        return this.endSession();
      }

      // Create jobs from plan
      const jobs = this.jobQueue.createJobsFromPlan(plan);
      this.session.jobs = jobs;

      // Save the plan
      await this.savePlan(plan);

      if (dryRun) {
        logger.info({ jobCount: jobs.length }, "Dry run - skipping job execution");
        return this.endSession();
      }

      // Phase 3: Execute jobs
      await this.executeJobs();

      // Phase 4: Synthesis - Generate morning briefing
      await this.setPhase("synthesis");
      await this.generateBriefing(contextPack.dailyLog);

      // Phase 5: Finalize
      await this.setPhase("briefing");
      await this.saveSessionState();

    } catch (error) {
      logger.error({ error, sessionId: this.session?.id }, "Night supervisor error");
      if (this.session) {
        this.session.findings.push(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      this.isRunning = false;
      // Session may already be ended (e.g., if no plan was generated)
      if (this.session) {
        this.session.totalDuration = Date.now() - startTime;
        return this.endSession();
      }
    }

    // Fallback - create empty session result if somehow we get here
    return {
      id: "unknown",
      startedAt: new Date(),
      phase: "idle",
      jobs: [],
      findings: [],
      proposals: [],
      jobsCompleted: 0,
      jobsFailed: 0,
      totalDuration: Date.now() - startTime,
    };
  }

  // ----------------------------------------
  // Phase Management
  // ----------------------------------------

  private async setPhase(phase: NightPhase): Promise<void> {
    if (this.session) {
      this.session.phase = phase;
      logger.info({ sessionId: this.session.id, phase }, "Phase transition");
    }
  }

  // ----------------------------------------
  // Overnight Tasks (Ad-hoc User Requests)
  // ----------------------------------------

  /**
   * Process queued overnight tasks from user requests like
   * "work on xyz tonight" or "research xyz for me tonight"
   */
  private async processOvernightTasks(): Promise<void> {
    if (!this.overnightStore) {
      logger.debug("No database connection, skipping overnight tasks");
      return;
    }

    const queuedTasks = this.overnightStore.getQueuedTasks();
    if (queuedTasks.length === 0) {
      logger.debug("No queued overnight tasks");
      return;
    }

    logger.info({ taskCount: queuedTasks.length }, "Processing queued overnight tasks");

    for (const task of queuedTasks) {
      try {
        await this.processOvernightTask(task);
      } catch (error) {
        logger.error(
          { taskId: task.id, error: error instanceof Error ? error.message : String(error) },
          "Failed to process overnight task"
        );
        // Continue with other tasks
      }
    }
  }

  private async processOvernightTask(task: OvernightTask): Promise<void> {
    logger.info({ taskId: task.id, type: task.type, subject: task.subject }, "Processing overnight task");

    // Create milestone notifier for this task
    const onMilestone = async (milestone: string, message: string): Promise<void> => {
      if (this.onOvernightMilestone) {
        await this.onOvernightMilestone(task.chatId, milestone, message);
      }
    };

    if (task.type === "prototype_work") {
      const orchestrator = new PrototypeOrchestrator(task, this.overnightStore!, {
        onMilestone,
      });
      const result = await orchestrator.execute();

      if (result.success) {
        this.session?.findings.push(`Overnight prototype: ${task.subject} - ${result.iterations.length} approaches completed`);
      } else {
        this.session?.findings.push(`Overnight prototype failed: ${task.subject} - ${result.error}`);
      }
    } else if (task.type === "research_dive") {
      const orchestrator = new ResearchOrchestrator(task, this.overnightStore!, {
        onMilestone,
      });
      const result = await orchestrator.execute();

      if (result.success) {
        this.session?.findings.push(`Overnight research: ${task.subject} - ${result.iterations.length} interpretations ready`);
      } else {
        this.session?.findings.push(`Overnight research failed: ${task.subject} - ${result.error}`);
      }
    }
  }

  // ----------------------------------------
  // Planning
  // ----------------------------------------

  private async generatePlan(context: string, _dryRun: boolean): Promise<NightPlan | null> {
    logger.info("Generating night plan with Gemini");

    const prompt = `You are the Night Supervisor. Analyze the context and create a plan for tonight's autonomous work.

Focus on:
1. **Idea Consolidation** (ALWAYS include): Deduplicate ~/memory/ideas.md, merge similar entries, archive stale drafts
2. Research tasks that would provide value (web searches, documentation lookups)
3. Ideas worth exploring further (pick 1-2 high-value ones)
4. Code improvements or proposals (be conservative - these require verification)
5. Priority actions for tomorrow

Return a JSON plan with this structure:
{
  "summary": "Brief description of tonight's focus",
  "maintenance_tasks": [{"id": "m1", "task": "idea_consolidation", "priority": "high"}],
  "research_tasks": [...],
  "ideas_to_explore": [...],
  "code_proposals": [...],
  "priority_actions": [...]
}

Be selective - quality over quantity. Always include idea_consolidation as a maintenance task.`;

    try {
      const result = await executeGeminiWithFallback(prompt, context, {
        model: "gemini-3-flash-preview",
        sandbox: true,
        timeout: this.config.jobTimeout,
      });

      if (result.exitCode !== 0) {
        logger.error({ output: result.output }, "Failed to generate plan");
        return null;
      }

      // Store Gemini session for continuity
      if (this.session) {
        this.session.geminiSessionId = result.sessionId;
      }

      // Parse the plan from response
      const plan = this.parsePlan(result.output);
      logger.info(
        {
          research: plan.research_tasks.length,
          ideas: plan.ideas_to_explore.length,
          proposals: plan.code_proposals.length,
        },
        "Night plan generated"
      );

      return plan;
    } catch (error) {
      logger.error({ error }, "Error generating plan");
      return null;
    }
  }

  private parsePlan(output: string): NightPlan {
    // Try to extract JSON from the response
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as NightPlan;
      } catch {
        logger.warn("Failed to parse plan JSON, using empty plan");
      }
    }

    // Return empty plan if parsing fails
    return {
      summary: "Failed to parse plan",
      research_tasks: [],
      ideas_to_explore: [],
      code_proposals: [],
      priority_actions: [],
    };
  }

  // ----------------------------------------
  // Job Execution
  // ----------------------------------------

  private async executeJobs(): Promise<void> {
    const startTime = Date.now();
    const maxDuration = this.config.totalTimeout;

    while (Date.now() - startTime < maxDuration) {
      const job = this.jobQueue.getNextExecutableJob();
      if (!job) {
        // No more executable jobs
        break;
      }

      // Check if we should auto-execute
      if (!shouldAutoExecute(job, { autoApproveGreen: this.config.autoApproveGreen })) {
        logger.debug({ jobId: job.id }, "Job requires approval, skipping");
        continue;
      }

      // Execute the job
      this.jobQueue.updateJobStatus(job.id, "running");
      logger.info({ jobId: job.id, type: job.type, name: job.name }, "Executing job");

      try {
        const result = await this.executeJob(job);
        this.jobQueue.setJobResult(job.id, result);

        if (result.success) {
          this.session!.jobsCompleted++;
          this.session!.findings.push(`✅ ${job.name}: ${result.output.slice(0, 200)}`);
        } else {
          this.session!.jobsFailed++;
          this.session!.findings.push(`❌ ${job.name}: ${result.error}`);
        }
      } catch (error) {
        this.session!.jobsFailed++;
        this.jobQueue.setJobResult(job.id, {
          success: false,
          output: "",
          error: error instanceof Error ? error.message : String(error),
          duration: 0,
        });
      }
    }

    logger.info(
      { completed: this.session!.jobsCompleted, failed: this.session!.jobsFailed },
      "Job execution completed"
    );
  }

  private async executeJob(job: typeof this.jobQueue extends JobQueue ? ReturnType<JobQueue["getJob"]> : never): Promise<{ success: boolean; output: string; error?: string; duration: number; artifacts?: string[] }> {
    const startTime = Date.now();

    // Type guard
    if (!job) {
      return { success: false, output: "", error: "Job not found", duration: 0 };
    }

    try {
      switch (job.type) {
        case "web_research": {
          const query = job.payload.query as string;
          const result = await executeGeminiWithFallback(
            `Research the following topic thoroughly and provide key insights:\n\n${query}`,
            "",
            {
              model: "gemini-3-flash-preview",
              sandbox: true,
              timeout: this.config.jobTimeout,
            }
          );

          const outputPath = await this.saveResearch(job.id, query, result.output);

          return {
            success: result.exitCode === 0,
            output: result.output,
            error: result.exitCode !== 0 ? result.output : undefined,
            duration: Date.now() - startTime,
            artifacts: [outputPath],
          };
        }

        case "idea_exploration": {
          const topic = job.payload.topic as string;
          const connection = job.payload.connection as string | undefined;

          const prompt = connection
            ? `Explore this idea and how it connects to the project:\n\nIdea: ${topic}\nProject: ${connection}`
            : `Explore this idea and identify potential applications:\n\n${topic}`;

          const result = await executeGeminiWithFallback(prompt, "", {
            model: "gemini-3-flash-preview",
            sandbox: true,
            timeout: this.config.jobTimeout,
          });

          return {
            success: result.exitCode === 0,
            output: result.output,
            error: result.exitCode !== 0 ? result.output : undefined,
            duration: Date.now() - startTime,
          };
        }

        case "code_proposal": {
          // Code proposals are logged but not executed
          const description = job.payload.description as string;
          const targetProject = job.payload.targetProject as string;

          const proposalPath = await this.saveProposal(job.id, description, targetProject);
          this.session!.proposals.push(proposalPath);

          return {
            success: true,
            output: `Proposal saved to ${proposalPath}`,
            duration: Date.now() - startTime,
            artifacts: [proposalPath],
          };
        }

        case "idea_consolidation": {
          // Deduplicate and consolidate ideas in ideas.md
          const prompt = `You are consolidating the ideas file. Read ~/memory/ideas.md and:

1. **Find Duplicates**: Identify ideas about the same topic (e.g., multiple entries for "Trellis", "Moltworker", "Anthony Fu skills")
2. **Merge Duplicates**: Keep the most comprehensive entry, archive others
3. **Remove Stale Ideas**: Archive ideas older than 14 days that are still in "draft" status
4. **Update Blocklist**: Add any frequently duplicated repos to ~/memory/deny-history.md "Already Tracking" section

Output a summary:
- Duplicates merged: X
- Stale ideas archived: Y
- Repos added to blocklist: Z

IMPORTANT: Actually edit the files, don't just analyze.`;

          const result = await executeGeminiWithFallback(prompt, "", {
            model: "gemini-3-flash-preview",
            sandbox: false, // Need to edit files
            yolo: true,
            timeout: this.config.jobTimeout,
          });

          return {
            success: result.exitCode === 0,
            output: result.output,
            error: result.exitCode !== 0 ? result.output : undefined,
            duration: Date.now() - startTime,
          };
        }

        default:
          return {
            success: false,
            output: "",
            error: `Unknown job type: ${job.type}`,
            duration: Date.now() - startTime,
          };
      }
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      };
    }
  }

  // ----------------------------------------
  // Morning Briefing
  // ----------------------------------------

  private async generateBriefing(dailyLog: string): Promise<void> {
    logger.info("Generating morning briefing");

    const findings = this.session!.findings.join("\n");
    const jobsSummary = formatJobsForBriefing(this.session!.jobs);

    try {
      const briefing = await generateMorningBriefing(
        `${findings}\n\n${jobsSummary}`,
        dailyLog
      );

      this.session!.morningBriefing = briefing;
      await this.saveBriefing(briefing);

      logger.info("Morning briefing generated and saved");
    } catch (error) {
      logger.error({ error }, "Failed to generate morning briefing");

      // Generate a simple fallback briefing
      const fallback = this.generateFallbackBriefing();
      this.session!.morningBriefing = fallback;
      await this.saveBriefing(fallback);
    }
  }

  private generateFallbackBriefing(): string {
    const stats = this.jobQueue.getStats();

    return `## Morning Briefing: ${new Date().toISOString().split("T")[0]}

### Overnight Summary
- Jobs completed: ${stats.completed}
- Jobs failed: ${stats.failed}
- Pending approval: ${stats.pendingApproval}

### Findings
${this.session!.findings.slice(0, 5).map(f => `- ${f}`).join("\n")}

### Proposals
${this.session!.proposals.map(p => `- ${p}`).join("\n") || "None"}

---
*Generated by Night Supervisor*`;
  }

  // ----------------------------------------
  // File Operations
  // ----------------------------------------

  private async ensureDirectories(): Promise<void> {
    const dirs = [
      this.config.outputDir,
      join(this.config.outputDir, "research"),
      join(this.config.outputDir, "drafts"),
      join(this.config.outputDir, "handoffs"),
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
    }
  }

  private async savePlan(plan: NightPlan): Promise<void> {
    const date = new Date().toISOString().split("T")[0];
    const path = join(this.config.outputDir, `plan_${date}.json`);
    await writeFile(path, JSON.stringify(plan, null, 2));
    logger.debug({ path }, "Plan saved");
  }

  private async saveResearch(jobId: string, query: string, content: string): Promise<string> {
    const date = new Date().toISOString().split("T")[0];
    const path = join(this.config.outputDir, "research", `${date}_${jobId}.md`);

    const markdown = `# Research: ${query.slice(0, 100)}

**Date:** ${new Date().toISOString()}
**Job ID:** ${jobId}

---

${content}
`;

    await writeFile(path, markdown);
    return path;
  }

  private async saveProposal(jobId: string, description: string, targetProject: string): Promise<string> {
    const date = new Date().toISOString().split("T")[0];
    const path = join(this.config.outputDir, "drafts", `${date}_${jobId}.plan`);

    const proposal = `# Code Proposal

**Date:** ${new Date().toISOString()}
**Job ID:** ${jobId}
**Target Project:** ${targetProject}
**Status:** PENDING_VERIFICATION

## Description

${description}

## Implementation Notes

*To be filled by Codex/Opus verification*

## Risk Assessment

*To be assessed during verification*

---
*Generated by Night Supervisor - Requires verification before execution*
`;

    await writeFile(path, proposal);
    return path;
  }

  private async saveBriefing(content: string): Promise<void> {
    const path = join(this.config.outputDir, "handoffs", "morning_briefing.md");
    await writeFile(path, content);
    logger.debug({ path }, "Morning briefing saved");
  }

  private async saveSessionState(): Promise<void> {
    const path = join(this.config.outputDir, "state.json");
    await writeFile(path, JSON.stringify({
      session: this.session,
      jobQueue: this.jobQueue.toJSON(),
      lastUpdated: new Date().toISOString(),
    }, null, 2));
  }

  // ----------------------------------------
  // Session End
  // ----------------------------------------

  private endSession(): NightSession {
    const session = this.session!;
    this.session = null;
    this.jobQueue.clear();
    this.isRunning = false;

    logger.info(
      {
        sessionId: session.id,
        duration: session.totalDuration,
        jobsCompleted: session.jobsCompleted,
        jobsFailed: session.jobsFailed,
      },
      "Night session ended"
    );

    return session;
  }

  // ----------------------------------------
  // Status
  // ----------------------------------------

  getStatus(): {
    isRunning: boolean;
    session: NightSession | null;
    jobStats: ReturnType<JobQueue["getStats"]> | null;
  } {
    return {
      isRunning: this.isRunning,
      session: this.session,
      jobStats: this.isRunning ? this.jobQueue.getStats() : null,
    };
  }
}

// ============================================
// CLI ENTRY POINT
// ============================================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  console.log("🌙 Night Supervisor Starting...\n");

  const supervisor = new NightSupervisor();
  const session = await supervisor.run(dryRun);

  console.log("\n📊 Session Summary:");
  console.log(`   ID: ${session.id}`);
  console.log(`   Duration: ${(session.totalDuration / 1000 / 60).toFixed(1)} minutes`);
  console.log(`   Jobs Completed: ${session.jobsCompleted}`);
  console.log(`   Jobs Failed: ${session.jobsFailed}`);

  if (session.morningBriefing) {
    console.log("\n📋 Morning Briefing:");
    console.log("─".repeat(60));
    console.log(session.morningBriefing);
    console.log("─".repeat(60));
  }

  if (dryRun) {
    console.log("\n🔍 Dry run complete - no jobs were executed");
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

