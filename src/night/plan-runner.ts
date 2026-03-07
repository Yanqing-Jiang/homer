/**
 * Night Plan Runner
 *
 * Executes an approved night plan. Called from:
 * 1. Telegram callback handler (immediate on approval)
 * 2. Fallback cron (stale plan reminder)
 */

import type Database from "better-sqlite3";
import type { Bot } from "grammy";
import type { NightPlan } from "./types.js";
import { JobQueue, shouldAutoExecute } from "./jobs.js";
import { executeGeminiWithFallback } from "../executors/opencode-cli.js";
import { GEMINI_CLI_FLASH_MODEL } from "../executors/gemini-cli.js";
import { logger } from "../utils/logger.js";
import { join } from "path";
import { writeFile } from "fs/promises";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { DEFAULT_CONFIG } from "./types.js";

interface NightPlanRow {
  id: string;
  session_id: string;
  plan_json: string;
  status: string;
}

export async function executeApprovedPlan(
  planId: string,
  db: Database.Database,
  bot: Bot,
  chatId: number,
): Promise<void> {
  // Load plan from DB
  const row = db.prepare("SELECT * FROM night_plans WHERE id = ?").get(planId) as NightPlanRow | undefined;
  if (!row) {
    throw new Error(`Night plan ${planId} not found`);
  }

  if (row.status !== "approved") {
    throw new Error(`Night plan ${planId} is ${row.status}, expected approved`);
  }

  let plan: NightPlan;
  try {
    plan = JSON.parse(row.plan_json) as NightPlan;
  } catch {
    throw new Error(`Failed to parse plan JSON for ${planId}`);
  }

  // Mark as executing
  db.prepare("UPDATE night_plans SET status = 'executing', executed_at = CURRENT_TIMESTAMP WHERE id = ?").run(planId);

  const config = DEFAULT_CONFIG;
  const jobQueue = new JobQueue();
  const jobs = jobQueue.createJobsFromPlan(plan);

  const startTime = Date.now();
  let jobsCompleted = 0;
  let jobsFailed = 0;
  const findings: string[] = [];

  logger.info({ planId, jobCount: jobs.length }, "Starting approved plan execution");

  // Ensure output directory
  const nightOutputDir = join(process.env.HOME ?? "/Users/yj", "homer", "output", "night");
  if (!existsSync(nightOutputDir)) {
    mkdirSync(nightOutputDir, { recursive: true });
  }

  // Execute jobs in parallel waves (same logic as supervisor)
  let waveNum = 0;
  while (Date.now() - startTime < config.totalTimeout) {
    const executableJobs = jobQueue.getAllExecutableJobs()
      .filter(job => shouldAutoExecute(job, { autoApproveGreen: config.autoApproveGreen }));

    if (executableJobs.length === 0) break;

    waveNum++;
    logger.info({ wave: waveNum, jobCount: executableJobs.length }, "Plan execution: starting wave");

    for (const job of executableJobs) {
      jobQueue.updateJobStatus(job.id, "running");
    }

    const maxParallel = config.maxParallelJobs;
    const batches: typeof executableJobs[] = [];
    for (let i = 0; i < executableJobs.length; i += maxParallel) {
      batches.push(executableJobs.slice(i, i + maxParallel));
    }

    for (const batch of batches) {
      if (Date.now() - startTime >= config.totalTimeout) break;

      const results = await Promise.allSettled(
        batch.map(async (job) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), config.jobTimeout);
          try {
            const result = await executeJobForPlan(job, config.jobTimeout, nightOutputDir, controller.signal);
            return { job, result };
          } catch (err) {
            if (controller.signal.aborted) {
              throw new Error(`Job timed out after ${config.jobTimeout / 1000}s`);
            }
            throw err;
          } finally {
            clearTimeout(timer);
          }
        })
      );

      for (let i = 0; i < results.length; i++) {
        const settled = results[i]!;
        const job = batch[i]!;

        if (settled.status === "fulfilled") {
          const { result } = settled.value;
          jobQueue.setJobResult(job.id, result);
          if (result.success) {
            jobsCompleted++;
            findings.push(`✅ ${job.name}: ${result.output.slice(0, 200)}`);
          } else {
            jobsFailed++;
            findings.push(`❌ ${job.name}: ${result.error}`);
          }
        } else {
          jobsFailed++;
          jobQueue.setJobResult(job.id, {
            success: false,
            output: "",
            error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
            duration: Date.now() - startTime,
          });
          findings.push(`❌ ${job.name}: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`);
        }
      }
    }
  }

  // Mark as completed
  db.prepare("UPDATE night_plans SET status = 'completed' WHERE id = ?").run(planId);

  const durationMin = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  logger.info({ planId, jobsCompleted, jobsFailed, durationMin }, "Plan execution completed");

  // Send completion summary to Telegram
  const summaryLines = [
    `<b>Night Plan Completed</b>`,
    ``,
    `✅ ${jobsCompleted} succeeded, ❌ ${jobsFailed} failed`,
    `⏱ ${durationMin} minutes`,
    ``,
    ...findings.slice(0, 10).map(f => `• ${escapeHtml(f)}`),
  ];

  if (findings.length > 10) {
    summaryLines.push(`... +${findings.length - 10} more`);
  }

  try {
    await bot.api.sendMessage(chatId, summaryLines.join("\n"), { parse_mode: "HTML" });
  } catch (err) {
    logger.warn({ error: String(err) }, "Failed to send plan completion to Telegram");
  }
}

async function executeJobForPlan(
  job: ReturnType<JobQueue["getJob"]>,
  timeout: number,
  outputDir: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; output: string; error?: string; duration: number }> {
  const startTime = Date.now();

  if (!job) {
    return { success: false, output: "", error: "Job not found", duration: 0 };
  }

  const date = new Date().toISOString().split("T")[0];
  const mdOutputPath = join(outputDir, `${job.id}-${date}.md`);
  const mdOutputInstruction = `\n\nOUTPUT INSTRUCTIONS: Write your FULL analysis/results to: ${mdOutputPath}\nReturn only a brief summary in your response. The file is your deliverable.`;

  try {
    switch (job.type) {
      case "web_research": {
        const query = job.payload.query as string;
        const result = await executeGeminiWithFallback(
          `Research the following topic thoroughly and provide key insights:\n\n${query}${mdOutputInstruction}`,
          "",
          { model: GEMINI_CLI_FLASH_MODEL, sandbox: true, timeout, signal }
        );
        const output = await readOutputFile(mdOutputPath, result.output);
        return {
          success: result.exitCode === 0,
          output,
          error: result.exitCode !== 0 ? result.output : undefined,
          duration: Date.now() - startTime,
        };
      }

      case "idea_exploration": {
        const topic = job.payload.topic as string;
        const connection = job.payload.connection as string | undefined;
        const prompt = connection
          ? `Explore this idea and how it connects to the project:\n\nIdea: ${topic}\nProject: ${connection}${mdOutputInstruction}`
          : `Explore this idea and identify potential applications:\n\n${topic}${mdOutputInstruction}`;
        const result = await executeGeminiWithFallback(prompt, "", {
          model: GEMINI_CLI_FLASH_MODEL, sandbox: true, timeout, signal,
        });
        const output = await readOutputFile(mdOutputPath, result.output);
        return {
          success: result.exitCode === 0,
          output,
          error: result.exitCode !== 0 ? result.output : undefined,
          duration: Date.now() - startTime,
        };
      }

      case "code_proposal": {
        const description = job.payload.description as string;
        const targetProject = job.payload.targetProject as string;
        const proposalPath = join(outputDir, `${date}_${job.id}.plan`);
        await writeFile(proposalPath, `# Code Proposal\n\n**Target:** ${targetProject}\n\n${description}\n`);
        return {
          success: true,
          output: `Proposal saved to ${proposalPath}`,
          duration: Date.now() - startTime,
        };
      }

      case "idea_consolidation":
        return {
          success: true,
          output: "Skipped: handled by dedicated cron job",
          duration: Date.now() - startTime,
        };

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

async function readOutputFile(path: string, fallback: string): Promise<string> {
  try {
    if (existsSync(path)) {
      return readFileSync(path, "utf-8");
    }
  } catch {
    // Fall through
  }
  return fallback;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
