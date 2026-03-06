import { randomUUID } from "crypto";
import { readFileSync, existsSync } from "fs";
import { logger } from "../utils/logger.js";
import { StateManager, type CLIRunStatus, type ExecutorStateType } from "../state/manager.js";
import { executeClaudeCommand } from "./claude.js";
import { executeGeminiCLI, executeOpenCodeCLI } from "./opencode-cli.js";
import { executeCodexCLI } from "./codex-cli.js";
import { executeKimiCLI } from "./kimi-cli.js";
import { runWithFallbackChain, DEFAULT_CHAIN, type ExecutorKind } from "./fallback-orchestrator.js";
import { processMemoryUpdates } from "../memory/writer.js";
import { getExecutorModel } from "../commands/index.js";
import { buildConversationContext, CONTEXT_DEFAULTS, type ContextSource } from "./context-builder.js";

export type CLIExecutor = "claude" | "gemini" | "codex" | "kimi" | "chatgpt" | "opencode";

export interface CLIRunStartParams {
  lane: string;
  executor?: CLIExecutor;
  model?: string;
  query: string;
  cwd: string;
  attachments?: string[];
  threadId?: string;
  contextBeforeMessageId?: string;
  suppressContext?: boolean;
  /** Called with cumulative text as Claude streams tokens */
  onPartial?: (text: string) => void;
}

export interface CLIRunResult {
  runId: string;
  status: CLIRunStatus;
  output: string;
  exitCode: number;
  duration: number;
  executor: CLIExecutor;
  sessionId?: string | null;
}

interface ActiveRun {
  runId: string;
  lane: string;
  abort: () => void;
  cancelled: boolean;
}

const MEMORY_HINT =
  "If anything should be saved to memory, emit <memory-update target=\"work|life|global\">...</memory-update>.";
const TELEGRAM_HINT =
  "Keep responses concise and readable on mobile. Short paragraphs, no HTML, no unnecessary formatting. Get to the point.";
const CHATGPT_BROWSER_HINT =
  "Use the browser tool to access chatgpt.com and complete the task there. Keep the final response here concise and include any relevant output or links.";

const CODEX_AGENT_PATH = `${process.env.HOME ?? "/Users/yj"}/.codex/AGENT.md`;

let cachedCodexAgent: string | null = null;

function loadCodexAgent(): string {
  if (cachedCodexAgent !== null) return cachedCodexAgent;
  if (!existsSync(CODEX_AGENT_PATH)) {
    cachedCodexAgent = "";
    return cachedCodexAgent;
  }
  try {
    cachedCodexAgent = readFileSync(CODEX_AGENT_PATH, "utf-8").trim();
    return cachedCodexAgent;
  } catch {
    cachedCodexAgent = "";
    return cachedCodexAgent;
  }
}

function buildPrompt(params: {
  executor: CLIExecutor;
  query: string;
  attachments?: string[];
  conversationContext?: string | null;
  lane?: string;
}): string {
  const parts: string[] = [];

  if (params.executor === "codex") {
    const agent = loadCodexAgent();
    if (agent) parts.push(agent);
  }

  if (params.executor === "gemini" || params.executor === "codex" || params.executor === "opencode") {
    parts.push(MEMORY_HINT);
  }

  if (params.executor === "chatgpt") {
    parts.push(CHATGPT_BROWSER_HINT);
  }

  if (params.lane?.startsWith("tg:")) {
    parts.push(TELEGRAM_HINT);
  }

  if (params.conversationContext) {
    parts.push(params.conversationContext);
  }

  if (params.attachments && params.attachments.length > 0) {
    parts.push(`Attached files (local paths):\n- ${params.attachments.join("\n- ")}`);
  }

  parts.push(params.query);
  return parts.join("\n\n");
}

export class CLIRunManager {
  private stateManager: StateManager;
  private activeRuns: Map<string, ActiveRun> = new Map();

  get activeCount(): number {
    return this.activeRuns.size;
  }

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
  }

  getActiveRun(lane: string): ActiveRun | null {
    return this.activeRuns.get(lane) ?? null;
  }

  cancelRun(lane: string, reason = "cancelled"): boolean {
    const active = this.activeRuns.get(lane);
    if (!active) return false;

    logger.info({ lane, runId: active.runId, reason }, "Cancelling active CLI run");
    active.cancelled = true;
    active.abort();
    return true;
  }

  async startRun(params: CLIRunStartParams): Promise<{ runId: string; result: Promise<CLIRunResult> }> {
    if (this.activeRuns.has(params.lane)) {
      throw new Error("A run is already in progress for this session.");
    }

    let executorState = this.stateManager.getCurrentExecutor(params.lane);
    const executor = params.executor ?? executorState?.executor ?? "claude";
    const model = params.model ?? executorState?.model ?? (
      executor === "claude" || executor === "gemini" || executor === "codex" || executor === "opencode"
        ? getExecutorModel(executor)
        : executor === "chatgpt"
          ? getExecutorModel("claude")
          : undefined
    );
    const sessionId = executorState?.sessionId ?? null;

    if (!executorState && executor !== "kimi") {
      this.stateManager.setCurrentExecutor(params.lane, executor, model ?? undefined);
      executorState = this.stateManager.getCurrentExecutor(params.lane);
    }

    const contextSource: ContextSource | null = params.threadId
      ? params.threadId.startsWith("tg:")
        ? { type: "lane", id: params.threadId }
        : { type: "thread", id: params.threadId }
      : null;

    const shouldInjectContext = (executorKind: ExecutorKind | CLIExecutor): boolean => {
      if (params.suppressContext) return false;
      if (!contextSource) return false;
      if (executorKind !== executor) return true;
      const messageCount = executorState?.messageCount ?? 0;
      if (messageCount > 0) return false;
      if (executorState?.sessionId) return false;
      return true;
    };

    let contextPromise: Promise<string | null> | null = null;
    const getConversationContext = async (): Promise<string | null> => {
      if (!contextSource) return null;
      if (contextPromise) return contextPromise;

      contextPromise = (async () => {
        // Check for pending context from executor switch (one-time use)
        const pendingContext = this.stateManager.getPendingContext(params.lane);
        if (pendingContext) {
          // Clear pending context after retrieval (one-time use)
          this.stateManager.clearPendingContext(params.lane);
          logger.debug({ lane: params.lane, sourceExecutor: pendingContext.sourceExecutor }, "Injecting pending context from executor switch");

          // Wrap pending context with handoff instructions
          return `<executor_handoff source="${pendingContext.sourceExecutor ?? "unknown"}">
<instructions>
You are continuing a conversation that was started with ${pendingContext.sourceExecutor ?? "another executor"}.
Review the conversation history below to understand the context.
Pay special attention to any constraints, corrections, or important notes from the user.
</instructions>

${pendingContext.context}
</executor_handoff>`;
        }

        // No pending context, build fresh from thread/lane messages
        const defaults = contextSource.type === "lane" ? CONTEXT_DEFAULTS.lane : CONTEXT_DEFAULTS.thread;
        const context = await buildConversationContext(this.stateManager, contextSource, {
          ...defaults,
          beforeMessageId: params.contextBeforeMessageId,
        });
        return context.formatted || null;
      })();

      return contextPromise;
    };

    const runId = randomUUID();
    const startedAt = Date.now();

    this.stateManager.createCliRun({
      id: runId,
      lane: params.lane,
      executor,
      threadId: params.threadId ?? null,
      status: "running",
      startedAt,
    });

    const abortController = new AbortController();
    this.activeRuns.set(params.lane, {
      runId,
      lane: params.lane,
      abort: () => abortController.abort(),
      cancelled: false,
    });

    const runPromise = (async (): Promise<CLIRunResult> => {
      try {
        let output = "";
        let exitCode = 0;
        let duration = 0;
        let newSessionId: string | null | undefined = null;
        let newSessionAccountId: number | null | undefined = null;
        let executorUsed: CLIExecutor = executor;

        const runExecutor = async (
          executorKind: ExecutorKind,
          queryOverride?: string
        ): Promise<{
          output: string;
          exitCode: number;
          duration: number;
          sessionId?: string | null;
          accountId?: number;
          error?: string;
        }> => {
          if (abortController.signal.aborted) {
            throw new Error("Cancelled");
          }

          const conversationContext = shouldInjectContext(executorKind)
            ? await getConversationContext()
            : null;

          const prompt = buildPrompt({
            executor: executorKind as CLIExecutor,
            query: queryOverride ?? params.query,
            attachments: params.attachments,
            conversationContext,
            lane: params.lane,
          });

          if (executorKind === "claude") {
            const result = await executeClaudeCommand(prompt, {
              cwd: params.cwd,
              claudeSessionId: executorKind === executor ? sessionId ?? undefined : undefined,
              model: executorKind === executor ? model ?? undefined : undefined,
              signal: abortController.signal,
              onPartial: params.onPartial,
            });
            return {
              output: result.output,
              exitCode: result.exitCode,
              duration: result.duration,
              sessionId: result.claudeSessionId ?? null,
              error: result.exitCode === 0 ? undefined : result.output,
            };
          }

          if (executorKind === "gemini") {
            let resumeAccountId: number | undefined;
            if (executorKind === executor && sessionId) {
              const stored = this.stateManager.getStoredExecutorSession(params.lane, "gemini", model ?? null);
              if (stored.sessionId === sessionId && stored.accountId) {
                resumeAccountId = stored.accountId;
              }
            }
            const result = await executeGeminiCLI(prompt, "", {
              model: executorKind === executor ? model ?? undefined : undefined,
              resume: executorKind === executor ? sessionId ?? undefined : undefined,
              accountId: resumeAccountId,
              signal: abortController.signal,
              sandbox: true,
              yolo: true,
              onPartial: params.onPartial,
            });
            return {
              output: result.output,
              exitCode: result.exitCode,
              duration: result.duration,
              sessionId: result.sessionId ?? null,
              accountId: result.accountId,
              error: result.exitCode === 0 ? undefined : result.output,
            };
          }

          if (executorKind === "codex") {
            const result = await executeCodexCLI(prompt, {
              cwd: params.cwd,
              timeout: 1800000,
              signal: abortController.signal,
              sessionId: executorKind === executor ? sessionId ?? undefined : undefined,
            });
            return {
              output: result.output,
              exitCode: result.exitCode,
              duration: result.duration,
              sessionId: result.sessionId ?? null,
              error: result.exitCode === 0 ? undefined : result.output,
            };
          }

          if (executorKind === "opencode") {
            const result = await executeOpenCodeCLI(prompt, "", {
              model: model || "google/gemini-3-flash-preview",
              yolo: true,
              sandbox: true,
              signal: abortController.signal,
              onPartial: params.onPartial,
            });
            return {
              output: result.output,
              exitCode: result.exitCode,
              duration: result.duration,
              sessionId: result.sessionId ?? null,
              accountId: result.accountId,
              error: result.exitCode === 0 ? undefined : result.output,
            };
          }

          const result = await executeKimiCLI(prompt, "", {
            timeout: 1200000,
            yolo: true,
            workDir: params.cwd,
          });
          return {
            output: result.output,
            exitCode: result.exitCode,
            duration: result.duration,
            sessionId: null,
            error: result.exitCode === 0 ? undefined : result.output,
          };
        };

        if (executor === "claude") {
          const fallbackResult = await runWithFallbackChain({
            primary: "claude",
            chain: DEFAULT_CHAIN,
            job: {
              id: runId,
              name: params.query.slice(0, 80),
              query: params.query,
              lane: params.lane,
              source: "runtime",
            },
            runExecutor,
            stateManager: this.stateManager,
          });

          const result = fallbackResult.result;
          output = result.output;
          exitCode = result.exitCode;
          duration = result.duration;
          executorUsed = fallbackResult.executorUsed as CLIExecutor;
          if (executorUsed === "claude" || executorUsed === "gemini") {
            newSessionId = result.sessionId ?? null;
            if (executorUsed === "gemini") {
              newSessionAccountId = result.accountId ?? null;
            }
          }
        } else if (executor === "chatgpt") {
          const conversationContext = shouldInjectContext("chatgpt")
            ? await getConversationContext()
            : null;
          const prompt = buildPrompt({
            executor: "chatgpt",
            query: params.query,
            attachments: params.attachments,
            conversationContext,
            lane: params.lane,
          });
          const result = await executeClaudeCommand(prompt, {
            cwd: params.cwd,
            claudeSessionId: sessionId ?? undefined,
            model: model ?? undefined,
            signal: abortController.signal,
            onPartial: params.onPartial,
          });
          output = result.output;
          exitCode = result.exitCode;
          duration = result.duration;
          executorUsed = "chatgpt";
          newSessionId = result.claudeSessionId ?? null;
        } else {
          const result = await runExecutor(executor as ExecutorKind);
          output = result.output;
          exitCode = result.exitCode;
          duration = result.duration;
          executorUsed = executor;
          newSessionId = result.sessionId ?? null;
          newSessionAccountId = result.accountId ?? null;
        }

        // Process memory updates (Codex/Gemini encouraged via prompt)
        const { cleanedResponse } = await processMemoryUpdates(output, "general");

        const wasCancelled = this.activeRuns.get(params.lane)?.cancelled ?? false;
        if (wasCancelled) {
          output = "Cancelled";
          exitCode = 130;
        }

        const fallbackUsed = executorUsed !== executor;
        const persistedSessionId = executorUsed === executor ? newSessionId ?? null : null;

        // Save assistant message if threadId is provided
        // Strip voice-mode XML tags so they don't leak into conversation history
        const threadContent = cleanedResponse.trim()
          .replace(/<\/?(?:spoken|summary|voice-mode)>/g, "")
          .trim();
        if (params.threadId && threadContent) {
          this.stateManager.createThreadMessage({
            id: randomUUID(),
            threadId: params.threadId,
            role: "assistant",
            content: threadContent,
            metadata: {
              executor: executorUsed,
              exitCode,
              fallbackUsed,
            },
          });
        }

        // Update executor state
        if (persistedSessionId) {
          this.stateManager.setExecutorSessionId(
            params.lane,
            persistedSessionId,
            executorUsed as ExecutorStateType,
            model ?? null,
            newSessionAccountId ?? null
          );
        }

        const status: CLIRunStatus = exitCode === 0 ? "completed" : (wasCancelled ? "cancelled" : "failed");
        if (status !== "cancelled") {
          this.stateManager.incrementExecutorMessageCount(params.lane);
        }
        this.stateManager.completeCliRun(runId, {
          status,
          completedAt: Date.now(),
          exitCode,
          output: cleanedResponse.trim() || output,
          executor: executorUsed,
        });

        return {
          runId,
          status,
          output: cleanedResponse.trim() || output,
          exitCode,
          duration,
          executor: executorUsed,
          sessionId: persistedSessionId ?? undefined,
        };
      } catch (error) {
        const active = this.activeRuns.get(params.lane);
        const cancelled = active?.cancelled ?? false;
        const status: CLIRunStatus = cancelled ? "cancelled" : "failed";
        const message = error instanceof Error ? error.message : "Unknown error";

        if (params.threadId) {
          const content = cancelled ? "Cancelled" : `Error: ${message}`;
          this.stateManager.createThreadMessage({
            id: randomUUID(),
            threadId: params.threadId,
            role: "assistant",
            content,
            metadata: {
              executor,
              exitCode: cancelled ? 130 : 1,
            },
          });
        }

        this.stateManager.completeCliRun(runId, {
          status,
          completedAt: Date.now(),
          exitCode: cancelled ? 130 : 1,
          error: message,
          executor,
        });

        return {
          runId,
          status,
          output: cancelled ? "Cancelled" : `Error: ${message}`,
          exitCode: cancelled ? 130 : 1,
          duration: Date.now() - startedAt,
          executor,
          sessionId: null,
        };
      } finally {
        this.activeRuns.delete(params.lane);
      }
    })();

    return { runId, result: runPromise };
  }
}
