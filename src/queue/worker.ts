import type { Bot } from "grammy";
import { QueueManager } from "./manager.js";
import { StateManager, type Job } from "../state/manager.js";
import { executeClaudeCommand } from "../executors/claude.js";
import { getLanePath } from "../router/prefix-router.js";
import { chunkMessage } from "../utils/chunker.js";
import { logger } from "../utils/logger.js";

export class QueueWorker {
  private queueManager: QueueManager;
  private stateManager: StateManager;
  private bot: Bot;
  private running = false;

  constructor(queueManager: QueueManager, stateManager: StateManager, bot: Bot) {
    this.queueManager = queueManager;
    this.stateManager = stateManager;
    this.bot = bot;

    // Listen for ready jobs
    this.queueManager.on("job:ready", (job: Job) => {
      this.processJob(job);
    });
  }

  /**
   * Start the worker
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info("Queue worker started");
  }

  /**
   * Stop the worker
   */
  stop(): void {
    this.running = false;
    logger.info("Queue worker stopped");
  }

  /**
   * Process a single job
   */
  private async processJob(job: Job): Promise<void> {
    if (!this.running) return;

    logger.info({ jobId: job.id, lane: job.lane, executor: job.executor }, "Processing job");

    // Mark as running
    this.queueManager.startJob(job.id);

    try {
      // Determine subagent
      let subagent: "gemini" | "codex" | undefined;
      if (job.executor === "gemini") {
        subagent = "gemini";
      } else if (job.executor === "codex") {
        subagent = "codex";
      }

      // Get Claude session ID for resume
      const claudeSessionId = this.stateManager.getClaudeSessionId(job.lane);
      const lanePath = getLanePath(job.lane as "work" | "invest" | "personal" | "learning");

      // Execute
      const result = await executeClaudeCommand(job.query, {
        cwd: lanePath,
        claudeSessionId: claudeSessionId ?? undefined,
        subagent,
      });

      // Store new Claude session ID if captured
      if (result.claudeSessionId) {
        this.stateManager.setClaudeSessionId(job.lane, result.claudeSessionId);
      } else if (claudeSessionId) {
        this.stateManager.updateClaudeSessionActivity(job.lane);
      }

      // Update session activity
      const session = this.stateManager.getOrCreateSession(job.lane);
      this.stateManager.updateSessionActivity(session.id);

      // Send response to Telegram
      if (job.messageId) {
        // Edit existing message
        try {
          await this.bot.api.editMessageText(job.chatId, job.messageId, result.output, {
            parse_mode: "Markdown",
          });
        } catch {
          // Fallback: send as new message
          const chunks = chunkMessage(result.output);
          for (const chunk of chunks) {
            await this.bot.api.sendMessage(job.chatId, chunk, { parse_mode: "Markdown" });
          }
        }
      } else {
        // Send new messages
        const chunks = chunkMessage(result.output);
        for (const chunk of chunks) {
          try {
            await this.bot.api.sendMessage(job.chatId, chunk, { parse_mode: "Markdown" });
          } catch {
            await this.bot.api.sendMessage(job.chatId, chunk);
          }
        }
      }

      // Mark complete
      this.queueManager.completeJob(job.id, result.output);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error({ jobId: job.id, error: errorMessage }, "Job execution failed");

      // Notify user of error
      try {
        if (job.messageId) {
          await this.bot.api.editMessageText(job.chatId, job.messageId, `❌ Error: ${errorMessage}`);
        } else {
          await this.bot.api.sendMessage(job.chatId, `❌ Error: ${errorMessage}`);
        }
      } catch {
        // Ignore notification errors
      }

      // Mark failed
      this.queueManager.failJob(job.id, errorMessage);
    }
  }
}
