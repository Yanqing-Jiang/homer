/**
 * Night Supervisor
 *
 * Main orchestrator for the autonomous night mode.
 * Uses Gemini CLI for nightly planning and the PipelineOrchestrator for queued overnight tasks.
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
import { executeGeminiWithFallback } from "../executors/opencode-cli.js";
import { executeClaudeCommand } from "../executors/claude.js";
import { logger } from "../utils/logger.js";
import { OvernightTaskStore, PipelineOrchestrator } from "../overnight/index.js";
import type { OvernightTask, YouTubeSummaryMetadata } from "../overnight/types.js";
import type Database from "better-sqlite3";
import { storeJobArtifact } from "../scheduler/jobs/artifact-store.js";
// dedupeIdeasFile import removed — dedup handled by dedicated idea-dedup cron job
import {
  summarizeYouTubeVideo,
  summaryExists,
  ensureSummariesDir,
} from "../youtube/summarizer.js";

// ============================================
// NIGHT SUPERVISOR CLASS
// ============================================

export class NightSupervisor {
  private config: NightModeConfig;
  private session: NightSession | null = null;
  private jobQueue: JobQueue;
  private isRunning = false;
  private db: Database.Database | null = null;
  private jobRunId: number | null = null;
  private overnightStore: OvernightTaskStore | null = null;
  private onOvernightMilestone?: (chatId: number, milestone: string, message: string) => Promise<void>;

  constructor(config: Partial<NightModeConfig> = {}, options?: {
    db?: Database.Database;
    jobRunId?: number;
    onOvernightMilestone?: (chatId: number, milestone: string, message: string) => Promise<void>;
  }) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.jobQueue = new JobQueue();
    this.db = options?.db ?? null;
    this.jobRunId = options?.jobRunId ?? null;
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

      // Phase 0.5: Idea dedup handled by dedicated cron job (idea-dedup at 5 AM)
      // and via dependency trigger from ideas-explore

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

      // Store plan as artifact for lineage tracking
      if (this.db && this.jobRunId) {
        storeJobArtifact(this.db, this.jobRunId, "night-supervisor", "plan", "json",
          JSON.stringify(plan, null, 2), { jobCount: jobs.length });
      }

      if (dryRun) {
        logger.info({ jobCount: jobs.length }, "Dry run - skipping job execution");
        return this.endSession();
      }

      // Phase 3: Execute jobs
      await this.executeJobs();

      // Store execution results as artifact
      if (this.db && this.jobRunId) {
        storeJobArtifact(this.db, this.jobRunId, "night-supervisor", "execution-results", "json",
          JSON.stringify({
            jobsCompleted: this.session.jobsCompleted,
            jobsFailed: this.session.jobsFailed,
            findings: this.session.findings,
            proposals: this.session.proposals,
          }, null, 2));
      }

      // Phase 4: Synthesis - optional morning briefing generation
      if (this.config.generateMorningBriefing) {
        await this.setPhase("synthesis");
        await this.generateBriefing(contextPack.dailyLog);
      } else {
        this.session.findings.push("Morning briefing skipped by Night Supervisor (scheduled morning-brief job is source of truth).");
      }

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

    const endTime = Date.now() + this.config.totalTimeout;

    while (Date.now() < endTime) {
      const queuedTasks = this.overnightStore.getQueuedTasks();
      if (queuedTasks.length === 0) {
        const nextScheduled = this.overnightStore.getNextQueuedTime();
        if (!nextScheduled) {
          logger.debug("No queued overnight tasks");
          return;
        }
        const sleepMs = Math.min(nextScheduled.getTime() - Date.now(), 15 * 60 * 1000);
        if (sleepMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, sleepMs));
          continue;
        }
      }

      logger.info({ taskCount: queuedTasks.length }, "Processing queued overnight tasks");

      // Separate YouTube tasks from others for batch processing
      const ytTasks = queuedTasks.filter((t) => t.type === "youtube_summary");
      const otherTasks = queuedTasks.filter((t) => t.type !== "youtube_summary");

      // Process YouTube tasks in parallel (semaphores inside summarizer control concurrency:
      // Flash classification max 4, Pro analysis max 2)
      if (ytTasks.length > 0) {
        await this.processYouTubeBatch(ytTasks);
      }

      // Process remaining tasks sequentially
      for (const task of otherTasks) {
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
  }

  private async processOvernightTask(task: OvernightTask): Promise<void> {
    logger.info({ taskId: task.id, type: task.type, subject: task.subject }, "Processing overnight task");

    // Create milestone notifier for this task
    const onMilestone = async (milestone: string, message: string): Promise<void> => {
      if (this.onOvernightMilestone) {
        await this.onOvernightMilestone(task.chatId, milestone, message);
      }
    };

    if (!this.overnightStore) return;

    if (task.iterations <= 0) {
      this.overnightStore.updateTaskStatus(task.id, "ready", { completedAt: new Date(), iterations: 0 });
      this.session?.findings.push(`Overnight task skipped (no iterations left): ${task.subject}`);
      return;
    }

    const orchestrator = new PipelineOrchestrator(task, this.overnightStore!, { onMilestone });
    const result = await orchestrator.execute();

    if (result.success) {
      const remaining = Math.max(0, task.iterations - 1);
      if (result.nextIterationNeeded && remaining > 0) {
        const nextRun = new Date(Date.now() + 60 * 60 * 1000);
        this.overnightStore.updateTaskStatus(task.id, "queued", {
          scheduledFor: nextRun,
          iterations: remaining,
          startedAt: null,
          completedAt: null,
        });
        this.session?.findings.push(
          `Overnight task scheduled for next iteration: ${task.subject} (${result.summary})`
        );
      } else {
        this.overnightStore.updateTaskStatus(task.id, "ready", {
          completedAt: new Date(),
          iterations: remaining,
        });
        this.session?.findings.push(`Overnight task ready: ${task.subject} (${result.summary})`);
      }
    } else {
      this.session?.findings.push(`Overnight task failed: ${task.subject} - ${result.error}`);
    }
  }

  // ----------------------------------------
  // YouTube Batch Processing
  // ----------------------------------------

  private async processYouTubeBatch(tasks: OvernightTask[]): Promise<void> {
    logger.info({ count: tasks.length }, "Processing YouTube tasks in parallel batch");
    ensureSummariesDir();

    const results = await Promise.allSettled(
      tasks.map((task) => this.processYouTubeTask(task))
    );

    let succeeded = 0;
    let failed = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        succeeded++;
      } else {
        failed++;
      }
    }

    logger.info({ succeeded, failed, total: tasks.length }, "YouTube batch processing complete");
  }

  private async processYouTubeTask(task: OvernightTask): Promise<void> {
    if (!this.overnightStore) return;

    let metadata: YouTubeSummaryMetadata;
    try {
      metadata = JSON.parse(task.metadata ?? "{}") as YouTubeSummaryMetadata;
    } catch {
      this.overnightStore.updateTaskStatus(task.id, "failed", {
        error: "Invalid metadata JSON",
      });
      return;
    }

    const { videoId } = metadata;
    if (!videoId) {
      this.overnightStore.updateTaskStatus(task.id, "failed", {
        error: "No videoId in metadata",
      });
      return;
    }

    // Process-time dedup: skip if summary exists in DB or file
    if (summaryExists(videoId, this.db ?? undefined)) {
      logger.info({ videoId, taskId: task.id }, "Summary already exists (DB or file), marking ready");
      this.overnightStore.updateTaskStatus(task.id, "ready", {
        completedAt: new Date(),
      });
      this.session?.findings.push(`YouTube summary already exists: ${videoId}`);
      return;
    }

    // Mark as classifying (Pass 1: Flash)
    this.overnightStore.updateTaskStatus(task.id, "executing", {
      startedAt: new Date(),
    });

    logger.info({ videoId, taskId: task.id }, "Processing YouTube video (v2 pipeline)");

    // Semaphores are managed inside summarizeYouTubeVideo (Flash=4, Pro=2)
    const result = await summarizeYouTubeVideo(metadata, this.db ?? undefined);

    if (result.success) {
      // Update metadata in DB with enriched data
      this.overnightStore.updateTaskMetadata(
        task.id,
        JSON.stringify(metadata)
      );
      this.overnightStore.updateTaskStatus(task.id, "ready", {
        completedAt: new Date(),
      });
      const ideaNote = result.createdIdeaIds?.length
        ? `, ideas: ${result.createdIdeaIds.length}`
        : "";
      this.session?.findings.push(
        `YouTube summary ready: ${metadata.videoTitle ?? videoId} (relevance: ${metadata.relevanceScore ?? "?"}, category: ${metadata.primaryCategory ?? "?"}${ideaNote})`
      );
    } else {
      this.overnightStore.updateTaskStatus(task.id, "failed", {
        error: result.error,
        completedAt: new Date(),
      });
      this.session?.findings.push(
        `YouTube summary failed: ${videoId} — ${result.error}`
      );
    }
  }

  // runIdeaDedup removed — handled by dedicated idea-dedup cron job at 5 AM

  // ----------------------------------------
  // Planning
  // ----------------------------------------

  private async generatePlan(context: string, _dryRun: boolean): Promise<NightPlan | null> {
    logger.info("Generating night plan with Gemini");

    const prompt = `You are the Night Supervisor. Analyze the context and create a plan for tonight's autonomous work.

Focus on:
1. Research tasks that would provide value (web searches, documentation lookups)
2. Ideas worth exploring further (pick 1-2 high-value ones)
3. Code improvements or proposals (be conservative - these require verification)
4. Priority actions for tomorrow

Note: Idea deduplication is handled separately and should NOT be included.

Return a JSON plan with this structure:
{
  "summary": "Brief description of tonight's focus",
  "maintenance_tasks": [],
  "research_tasks": [...],
  "ideas_to_explore": [...],
  "code_proposals": [...],
  "priority_actions": [...]
}

Be selective - quality over quantity.`;

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
          // Dedup is handled by dedicated idea-dedup cron job — skip if supervisor triggers it
          logger.info("Skipping idea_consolidation — handled by dedicated cron job");
          return {
            success: true,
            output: "Skipped: handled by dedicated idea-dedup cron job",
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
      const prompt = `Generate a concise, actionable morning briefing.

## Overnight Findings
${findings}

## Overnight Job Summary
${jobsSummary}

## Yesterday Daily Log
${dailyLog}

Output sections:
1. The Big 3
2. Overnight Findings
3. Needs Attention
4. Context for Today

Rules:
- concise and actionable
- no approval requests
- markdown only`;

      const result = await executeClaudeCommand(prompt, {
        cwd: process.env.HOME ?? "/Users/yj",
        model: "sonnet",
        timeout: this.config.jobTimeout,
      });

      if (result.exitCode !== 0 || !result.output?.trim()) {
        throw new Error(result.output || "Morning briefing generation failed");
      }

      const briefing = result.output.trim();

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
    const stateJson = JSON.stringify({
      session: this.session,
      jobQueue: this.jobQueue.toJSON(),
      lastUpdated: new Date().toISOString(),
    }, null, 2);

    const path = join(this.config.outputDir, "state.json");
    await writeFile(path, stateJson);

    // Store session state as artifact for recovery
    if (this.db && this.jobRunId) {
      storeJobArtifact(this.db, this.jobRunId, "night-supervisor", "session-state", "json", stateJson);
    }
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
