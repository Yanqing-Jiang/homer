import type { Bot } from "grammy";
import type { RegisteredJob, JobExecutionResult } from "./types.js";
import type { StateManager } from "../state/manager.js";
import { sendNextIdeaForReview } from "../bot/handlers/approval.js";
import { NightSupervisor } from "../night/supervisor.js";
import { sendMilestoneNotification, presentOvernightSummaries } from "../bot/handlers/overnight.js";
import { ingestIdeasFromLegacy } from "../ideas/ingest.js";
import { dedupeIdeasDir } from "../ideas/dedup.js";
import { runSessionSummary } from "./jobs/session-summaries.js";
import { runWeeklyConsolidation } from "./jobs/weekly-consolidation.js";
import { runWeeklyMemoryCleanup } from "./jobs/memory-cleanup.js";

interface InternalJobContext {
  stateManager: StateManager;
  bot: Bot;
  chatId: number;
}

function buildResult(
  job: RegisteredJob,
  startedAt: Date,
  success: boolean,
  output: string,
  error?: string
): JobExecutionResult {
  const completedAt = new Date();
  return {
    jobId: job.config.id,
    jobName: job.config.name,
    sourceFile: job.sourceFile,
    startedAt,
    completedAt,
    success,
    output,
    error,
    exitCode: success ? 0 : 1,
    duration: completedAt.getTime() - startedAt.getTime(),
  };
}

export async function executeInternalJob(
  job: RegisteredJob,
  ctx: InternalJobContext
): Promise<JobExecutionResult> {
  const startedAt = new Date();

  try {
    switch (job.config.handler) {
      case "ideas_review": {
        const sent = await sendNextIdeaForReview(ctx.bot, ctx.chatId);
        return buildResult(
          job,
          startedAt,
          true,
          sent ? "Sent next idea for review" : "No new ideas to review"
        );
      }
      case "night_supervisor": {
        const supervisor = new NightSupervisor({}, {
          db: ctx.stateManager.getDb(),
          onOvernightMilestone: async (chatId, milestone, message) => {
            await sendMilestoneNotification(ctx.bot, chatId, milestone, message);
          },
        });
        const session = await supervisor.run(false);
        const summary = `Night supervisor completed. Jobs: ${session.jobsCompleted} ok, ${session.jobsFailed} failed.`;
        return buildResult(job, startedAt, true, summary);
      }
      case "overnight_review": {
        const count = await presentOvernightSummaries(ctx.bot, ctx.stateManager, ctx.chatId);
        const output = count > 0
          ? `Presented ${count} overnight task summaries`
          : "No overnight tasks ready for review";
        return buildResult(job, startedAt, true, output);
      }
      case "idea_ingest": {
        const result = await ingestIdeasFromLegacy(ctx.stateManager.getDb());
        const parts: string[] = [];
        if (result.ingested > 0) {
          parts.push(`Ingested ${result.ingested} ideas`);
          if (result.fromTwitter > 0) parts.push(`${result.fromTwitter} from X`);
          if (result.enriched > 0) parts.push(`${result.enriched} enriched`);
        }
        if (result.archivedToDeny > 0) parts.push(`${result.archivedToDeny} archived to deny-history`);
        if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
        const output = parts.length > 0 ? parts.join(", ") : "No new ideas found";
        return buildResult(job, startedAt, true, output);
      }
      case "idea_dedup": {
        const result = await dedupeIdeasDir();
        const output = result.deleted > 0
          ? `Dedup complete: ${result.deleted} duplicates deleted, ${result.kept} ideas retained`
          : `No duplicates found (${result.kept} ideas checked)`;
        return buildResult(job, startedAt, true, output);
      }
      case "session_summaries": {
        const result = await runSessionSummary(undefined, ctx.stateManager);
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "weekly_consolidation": {
        const result = await runWeeklyConsolidation();
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "memory_cleanup": {
        const result = await runWeeklyMemoryCleanup();
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "ideas_explore": {
        const { runIdeasExplore } = await import("./jobs/ideas-explore.js");
        const result = await runIdeasExplore();
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "nightly_memory": {
        const { runNightlyMemory } = await import("./jobs/nightly-memory.js");
        const result = await runNightlyMemory(ctx.stateManager);
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      case "homer_improvements": {
        const { runHomerImprovements } = await import("./jobs/homer-improvements.js");
        const result = await runHomerImprovements();
        return buildResult(job, startedAt, result.success, result.output, result.error);
      }
      default: {
        return buildResult(job, startedAt, false, "", `Unknown internal handler: ${job.config.handler}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildResult(job, startedAt, false, "", message);
  }
}
