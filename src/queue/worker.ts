import type { Bot } from "grammy";
import { QueueManager } from "./manager.js";
import { StateManager, type Job } from "../state/manager.js";
import { acquireSlot } from "../executors/concurrency.js";
import { runCompletionCheckup } from "../executors/completion-checkup.js";
import {
  runWithFallbackChain,
  DEFAULT_FALLBACK_ORDER,
  MEMORY_FALLBACK_ORDER,
  type ExecutorKind,
} from "../executors/fallback-orchestrator.js";
import { writeChainTrace } from "../executors/trace-writer.js";
import { executeResolvedHarness } from "../harness/dispatch.js";
import { negotiateHarnessAttempts } from "../harness/negotiation.js";
import { resolveHarnessSelection } from "../harness/resolution/resolver.js";
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

type QueueJobScope = Job & { turnId?: string | null; conversationId?: string | null };

function harnessScopeForQueueJob(job: Job): {
  turnId?: string | null;
  conversationId?: string | null;
  lane?: string | null;
  jobId?: string | null;
} {
  const scoped = job as QueueJobScope;
  return {
    turnId: scoped.turnId ?? null,
    conversationId: scoped.conversationId ?? null,
    lane: job.lane,
    jobId: null,
  };
}

function queueTimeoutMs(executor: ExecutorKind): number {
  return executor === "claude" || executor === "codex" ? 1_800_000 : 1_200_000;
}

function uniqueExecutorChain(executors: ExecutorKind[]): ExecutorKind[] {
  const seen = new Set<ExecutorKind>();
  const chain: ExecutorKind[] = [];
  for (const executor of executors) {
    if (!seen.has(executor)) {
      seen.add(executor);
      chain.push(executor);
    }
  }
  return chain;
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
      // Selection: a job that names a concrete executor is honored as the explicit primary
      // (e.g. /codex, /gemini). A "default"/unknown job follows resolver scope order
      // (turn/conversation if present, lane, then global). Memory jobs only change fallback order.
      const baseChain: ExecutorKind[] = memoryJob ? [...MEMORY_FALLBACK_ORDER] : [...DEFAULT_FALLBACK_ORDER];
      const VALID_EXECUTORS: ExecutorKind[] = ["claude", "gemini", "codex", "kimi", "opencode"];
      const requested = VALID_EXECUTORS.includes(job.executor as ExecutorKind)
        ? (job.executor as ExecutorKind)
        : undefined;
      const scope = harnessScopeForQueueJob(job);
      const store = this.stateManager.createHarnessSelectionStore();
      const baselineProfile = {
        cwdOverride: HOME,
        executorOptions: {
          opencode: {
            forceOpenCode: true,
            researchOnly: false,
            agent: "build",
            yolo: true,
            sandbox: true,
          },
          kimi: { yolo: true },
        },
      };
      const attemptModels = new Map<ExecutorKind, string | null>();
      let primary: ExecutorKind;
      let chain: ExecutorKind[];

      try {
        const plan = resolveHarnessSelection(
          {
            requestId: `queue-${job.id}`,
            source: "queue",
            scope,
            explicit: requested ? { harness: requested, model: null } : null,
            baselineProfile,
          },
          store,
        );
        const attemptPlan = negotiateHarnessAttempts({
          resolved: plan,
          mode: "runtime-turn",
          compatibilityOrder: baseChain,
          allowDegradation: true,
        });
        for (const attempt of attemptPlan.attempts) {
          attemptModels.set(attempt.harness, attempt.model);
        }
        primary = attemptPlan.primary.harness;
        chain = uniqueExecutorChain([
          primary,
          ...attemptPlan.attempts.map((attempt) => attempt.harness),
          ...baseChain,
        ]);
      } catch (error) {
        logger.warn({ jobId: job.id, error }, "Queue harness resolution failed; using static fallback chain");
        primary = requested ?? baseChain[0] ?? "claude";
        chain = uniqueExecutorChain([primary, ...baseChain]);
      }

      // Claude session handling
      const initialClaudeSessionId = this.stateManager.getClaudeSessionId(job.lane);
      let lastClaudeSessionId = initialClaudeSessionId ?? undefined;

      const runExecutor = async (
        executor: ExecutorKind,
        queryOverride?: string,
        modelOverride?: string
      ): Promise<{ exitCode: number; output: string; error?: string; duration: number; startedAt: Date; completedAt: Date }> => {
        const query = queryOverride ?? job.query;
        const startedAt = new Date();
        const model = modelOverride ?? attemptModels.get(executor) ?? null;
        const result = await executeResolvedHarness({
          requestId: `queue-${job.id}-${executor}`,
          source: "queue",
          mode: "runtime-turn",
          prompt: query,
          scope,
          explicit: { harness: executor, model },
          baselineProfile,
          cwd: HOME,
          timeoutMs: queueTimeoutMs(executor),
          session: executor === "claude" && lastClaudeSessionId
            ? { lane: job.lane, sessionId: lastClaudeSessionId, harness: "claude", model }
            : null,
          store,
        });

        if (result.session?.harness === "claude" && result.session.sessionId) {
          lastClaudeSessionId = result.session.sessionId;
        } else if (executor === "claude" && lastClaudeSessionId) {
          this.stateManager.updateClaudeSessionActivity(job.lane);
        }

        return {
          exitCode: result.exitCode,
          output: result.output,
          error: result.exitCode === 0 ? undefined : result.stderr ?? result.output,
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

      writeChainTrace(fallbackResult, { jobId: job.id, source: "queue" });

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
