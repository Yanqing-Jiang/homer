import type { Bot } from "grammy";
import { QueueManager } from "./manager.js";
import { StateManager, type Job } from "../state/manager.js";
import { executeClaudeCommand } from "../executors/claude.js";
import { executeOpenCodeCLI } from "../executors/opencode-cli.js";
import { GEMINI_CLI_FLASH_MODEL } from "../executors/gemini-cli.js";
import { executeCodexCLI } from "../executors/codex-cli.js";
import { executeKimiCLI } from "../executors/kimi-cli.js";
import { acquireSlot } from "../executors/concurrency.js";
import { runCompletionCheckup } from "../executors/completion-checkup.js";
import {
  runWithFallbackChain,
  DEFAULT_CHAIN,
  MEMORY_CHAIN,
  type ExecutorKind,
} from "../executors/fallback-orchestrator.js";
import { writeChainTrace } from "../executors/trace-writer.js";
import { chunkMessage } from "../utils/chunker.js";
import { logger } from "../utils/logger.js";

const HOME = process.env.HOME || "/Users/yj";

function isMemoryJob(job: Job): boolean {
  const query = job.query.toLowerCase();
  return (
    query.includes("/nightly-memory") ||
    query.includes("memory/daily") ||
    query.includes("daily log") ||
    query.includes("memory")
  );
}

export class QueueWorker {
  private queueManager: QueueManager;
  private stateManager: StateManager;
  private bot: Bot;
  private running = false;
  private jobReadyHandler: (job: Job) => void;

  constructor(queueManager: QueueManager, stateManager: StateManager, bot: Bot) {
    this.queueManager = queueManager;
    this.stateManager = stateManager;
    this.bot = bot;

    // Store handler reference for cleanup
    this.jobReadyHandler = (job: Job) => {
      this.processJob(job);
    };

    // Listen for ready jobs
    this.queueManager.on("job:ready", this.jobReadyHandler);
  }

  /**
   * Start the worker
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info("Queue worker started");

    // Check for pending jobs immediately on startup
    const stats = this.queueManager.getStats();
    if (stats.pending > 0) {
      logger.info({ pendingJobs: stats.pending }, "Found pending jobs on worker start, triggering pump");
      // Trigger job pump by emitting event
      this.queueManager.emit("job:enqueued");
    }
  }

  /**
   * Stop the worker
   */
  stop(): void {
    this.running = false;
    // Remove event listener to prevent memory leaks
    this.queueManager.off("job:ready", this.jobReadyHandler);
    logger.info("Queue worker stopped");
  }

  /**
   * Process a single job
   */
  private async processJob(job: Job): Promise<void> {
    if (!this.running) return;

    logger.info({ jobId: job.id, lane: job.lane, executor: job.executor }, "Processing job");

    // Job is already marked as running and locked by atomic claim
    // Start heartbeat interval
    const heartbeatInterval = this.queueManager.startJobHeartbeat(job.id);

    let releaseSlot: (() => void) | null = null;
    try {
      const memoryJob = isMemoryJob(job);
      const chain: ExecutorKind[] = memoryJob ? [...MEMORY_CHAIN] : [...DEFAULT_CHAIN];
      const primary: ExecutorKind = chain[0] ?? "claude";

      // Determine subagent (used only when executor is Claude)
      let subagent: "gemini" | "codex" | undefined;
      if (job.executor === "gemini") {
        subagent = "gemini";
      } else if (job.executor === "codex") {
        subagent = "codex";
      }

      // Claude session handling
      const initialClaudeSessionId = this.stateManager.getClaudeSessionId(job.lane);
      let lastClaudeSessionId = initialClaudeSessionId ?? undefined;

      const runExecutor = async (
        executor: ExecutorKind,
        queryOverride?: string
      ): Promise<{ exitCode: number; output: string; error?: string; duration: number; startedAt: Date; completedAt: Date }> => {
        const query = queryOverride ?? job.query;
        const startedAt = new Date();

        if (executor === "claude") {
          const result = await executeClaudeCommand(query, {
            cwd: HOME,
            claudeSessionId: lastClaudeSessionId,
            subagent,
          });
          if (result.claudeSessionId) {
            lastClaudeSessionId = result.claudeSessionId;
          } else if (lastClaudeSessionId) {
            this.stateManager.updateClaudeSessionActivity(job.lane);
          }
          return {
            exitCode: result.exitCode,
            output: result.output,
            error: result.exitCode === 0 ? undefined : result.output,
            duration: result.duration,
            startedAt,
            completedAt: new Date(),
          };
        }

        if (executor === "gemini") {
          const result = await executeOpenCodeCLI(query, "", {
            timeout: 1200000,
            sandbox: true,
            model: GEMINI_CLI_FLASH_MODEL,
          });
          return {
            exitCode: result.exitCode,
            output: result.output,
            error: result.exitCode === 0 ? undefined : result.output,
            duration: result.duration,
            startedAt,
            completedAt: new Date(),
          };
        }

        if (executor === "codex") {
          const result = await executeCodexCLI(query, {
            cwd: HOME,
            timeout: 1800000,
          });
          return {
            exitCode: result.exitCode,
            output: result.output,
            error: result.exitCode === 0 ? undefined : result.output,
            duration: result.duration,
            startedAt,
            completedAt: new Date(),
          };
        }

        const result = await executeKimiCLI(query, "", {
          timeout: 1200000,
          yolo: true,
          workDir: HOME,
        });
        return {
          exitCode: result.exitCode,
          output: result.output,
          error: result.exitCode === 0 ? undefined : result.output,
          duration: result.duration,
          startedAt,
          completedAt: new Date(),
        };
      };

      releaseSlot = await acquireSlot();
      const fallbackResult = await runWithFallbackChain({
        primary,
        chain,
        job: {
          id: job.id,
          name: job.query.slice(0, 80),
          query: job.query,
          lane: job.lane,
          source: "queue",
        },
        runExecutor,
        notify: async (message) => {
          await this.bot.api.sendMessage(job.chatId, message);
        },
      });

      writeChainTrace(fallbackResult, { jobId: job.id, source: "runtime" });

      const result = fallbackResult.result;
      const success = result.exitCode === 0;

      // Update session activity
      const session = this.stateManager.getOrCreateSession(job.lane);
      this.stateManager.updateSessionActivity(session.id);

      // Persist Claude session if used
      if (lastClaudeSessionId) {
        this.stateManager.setClaudeSessionId(job.lane, lastClaudeSessionId);
      }

      // Send response to Telegram
      if (job.messageId) {
        try {
          await this.bot.api.editMessageText(job.chatId, job.messageId, result.output, {
            parse_mode: "Markdown",
          });
        } catch {
          const chunks = chunkMessage(result.output);
          for (const chunk of chunks) {
            await this.bot.api.sendMessage(job.chatId, chunk, { parse_mode: "Markdown" });
          }
        }
      } else {
        const chunks = chunkMessage(result.output);
        for (const chunk of chunks) {
          try {
            await this.bot.api.sendMessage(job.chatId, chunk, { parse_mode: "Markdown" });
          } catch {
            await this.bot.api.sendMessage(job.chatId, chunk);
          }
        }
      }

      if (success) {
        // Completion checkup
        const check = await runCompletionCheckup({
          name: job.query.slice(0, 80),
          id: job.id,
          query: job.query,
          output: result.output,
          isMemoryJob: memoryJob,
        });
        if (check) {
          const lines: string[] = [check.complete ? "✅ Checkup: Complete" : "⚠️ Checkup: Incomplete"];
          if (check.summary) lines.push(`Summary: ${check.summary}`);
          if (check.missing && check.missing.length > 0) {
            lines.push(`Missing: ${check.missing.join("; ")}`);
          }
          if (check.next_steps && check.next_steps.length > 0) {
            lines.push(`Next: ${check.next_steps.join("; ")}`);
          }
          if (typeof check.confidence === "number") {
            lines.push(`Confidence: ${Math.round(check.confidence * 100)}%`);
          }
          await this.bot.api.sendMessage(job.chatId, lines.join("\n"));
        }

        this.queueManager.completeJob(job.id, result.output);
      } else {
        this.queueManager.failJob(job.id, result.error ?? "Execution failed");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error({ jobId: job.id, error: errorMessage }, "Job execution failed");

      try {
        if (job.messageId) {
          await this.bot.api.editMessageText(job.chatId, job.messageId, `❌ Error: ${errorMessage}`);
        } else {
          await this.bot.api.sendMessage(job.chatId, `❌ Error: ${errorMessage}`);
        }
      } catch {
        // Ignore notification errors
      }

      this.queueManager.failJob(job.id, errorMessage);
    } finally {
      if (releaseSlot) releaseSlot();
      this.queueManager.stopJobHeartbeat(heartbeatInterval);
    }
  }

}
