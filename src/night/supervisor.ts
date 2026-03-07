/**
 * Night Supervisor
 *
 * Main orchestrator for the autonomous night mode.
 * Uses Gemini CLI for nightly planning and the PipelineOrchestrator for queued overnight tasks.
 */

import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { randomUUID } from "crypto";
import type {
  NightSession,
  NightPlan,
  NightModeConfig,
  NightPhase,
} from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { buildContextPack } from "./context.js";
import { JobQueue } from "./jobs.js";
import { executeGeminiWithFallback } from "../executors/opencode-cli.js";
import { GEMINI_CLI_FLASH_MODEL } from "../executors/gemini-cli.js";
import { logger } from "../utils/logger.js";
import { OvernightTaskStore, PipelineOrchestrator } from "../overnight/index.js";
import type { OvernightTask, YouTubeSummaryMetadata } from "../overnight/types.js";
import type Database from "better-sqlite3";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
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
  private bot: Bot | null = null;
  private chatId: number = 0;

  constructor(config: Partial<NightModeConfig> = {}, options?: {
    db?: Database.Database;
    jobRunId?: number;
    bot?: Bot;
    chatId?: number;
    onOvernightMilestone?: (chatId: number, milestone: string, message: string) => Promise<void>;
  }) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.jobQueue = new JobQueue();
    this.db = options?.db ?? null;
    this.jobRunId = options?.jobRunId ?? null;
    this.bot = options?.bot ?? null;
    this.chatId = options?.chatId ?? 0;
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

      // Save the plan to disk
      await this.savePlan(plan);

      // Store plan as artifact for lineage tracking
      if (this.db && this.jobRunId) {
        storeJobArtifact(this.db, this.jobRunId, "night-supervisor", "plan", "json",
          JSON.stringify(plan, null, 2), { jobCount: jobs.length });
      }

      // Save plan to DB for approval flow
      const planId = await this.savePlanToDB(plan);

      if (dryRun) {
        logger.info({ jobCount: jobs.length }, "Dry run - skipping job execution");
        return this.endSession();
      }

      // Send plan to Telegram for approval (wait-for-approval mode)
      await this.sendPlanToTelegram(planId, plan);

      // STOP — no execution, no briefing. User approves via Telegram.
      this.session.findings.push("Night plan saved and sent to Telegram for approval. Execution deferred until user approval.");
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
        model: GEMINI_CLI_FLASH_MODEL,
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
  // File Operations
  // ----------------------------------------

  private async ensureDirectories(): Promise<void> {
    // Ensure night output directory for .md deliverables
    const nightOutputDir = join(process.env.HOME ?? "/Users/yj", "homer", "output", "night");
    if (!existsSync(nightOutputDir)) {
      mkdirSync(nightOutputDir, { recursive: true });
    }

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

  private async savePlanToDB(plan: NightPlan): Promise<string> {
    if (!this.db || !this.session) {
      return "";
    }

    const planId = `nplan_${randomUUID().slice(0, 8)}`;

    try {
      this.db.prepare(`
        INSERT INTO night_plans (id, session_id, plan_json, status, created_at)
        VALUES (?, ?, ?, 'pending', CURRENT_TIMESTAMP)
      `).run(planId, this.session.id, JSON.stringify(plan));
      logger.info({ planId, sessionId: this.session.id }, "Night plan saved to DB");
    } catch (err) {
      // Table may not exist yet — log but don't fail
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, "Failed to save night plan to DB");
    }

    return planId;
  }

  private async sendPlanToTelegram(planId: string, plan: NightPlan): Promise<void> {
    if (!this.bot || !this.chatId) {
      logger.debug("No bot/chatId configured, skipping Telegram plan notification");
      return;
    }

    const date = new Date().toISOString().split("T")[0];
    const lines: string[] = [`<b>Night Plan — ${date}</b>\n`];

    if (plan.research_tasks.length > 0) {
      lines.push(`<b>Research (${plan.research_tasks.length}):</b>`);
      for (const t of plan.research_tasks.slice(0, 5)) {
        lines.push(`  • ${escapeHtml(t.query.slice(0, 80))}`);
      }
      if (plan.research_tasks.length > 5) {
        lines.push(`  ... +${plan.research_tasks.length - 5} more`);
      }
      lines.push("");
    }

    if (plan.ideas_to_explore.length > 0) {
      lines.push(`<b>Ideas (${plan.ideas_to_explore.length}):</b>`);
      for (const t of plan.ideas_to_explore.slice(0, 5)) {
        lines.push(`  • ${escapeHtml(t.topic.slice(0, 80))}`);
      }
      lines.push("");
    }

    if (plan.code_proposals.length > 0) {
      lines.push(`<b>Proposals (${plan.code_proposals.length}):</b>`);
      for (const t of plan.code_proposals.slice(0, 3)) {
        lines.push(`  • ${escapeHtml(t.description.slice(0, 80))}`);
      }
      lines.push("");
    }

    if (plan.priority_actions.length > 0) {
      lines.push(`<b>Priority Actions:</b>`);
      for (const a of plan.priority_actions.slice(0, 5)) {
        lines.push(`  • ${escapeHtml(a.slice(0, 80))}`);
      }
      lines.push("");
    }

    if (plan.summary) {
      lines.push(`<i>${escapeHtml(plan.summary.slice(0, 200))}</i>`);
    }

    const keyboard = new InlineKeyboard()
      .text("Execute All", `night_plan:execute:${planId}`)
      .text("Edit Plan", `night_plan:edit:${planId}`)
      .text("Skip Tonight", `night_plan:skip:${planId}`);

    try {
      const msg = await this.bot.api.sendMessage(this.chatId, lines.join("\n"), {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });

      // Update the plan with the Telegram message ID
      if (this.db) {
        try {
          this.db.prepare(
            "UPDATE night_plans SET telegram_message_id = ? WHERE id = ?"
          ).run(msg.message_id, planId);
        } catch {
          // Best effort
        }
      }

      logger.info({ planId, messageId: msg.message_id }, "Night plan sent to Telegram");
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to send night plan to Telegram");
    }
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

// ============================================
// HELPERS
// ============================================

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
