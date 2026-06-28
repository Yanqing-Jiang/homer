import { randomUUID } from "crypto";
import { readFileSync, existsSync } from "fs";
import { logger } from "../utils/logger.js";
import { acquireSlot } from "./concurrency.js";
import { StateManager, type CLIRunStatus, type ExecutorStateType } from "../state/manager.js";
import { executeClaudeCommand } from "./claude.js";
import { executePooledClaudeTurn, closePooledClaudeSession, closeAllPooledClaudeSessions } from "./claude-session-pool.js";
import { executeOpenCodeCLI } from "./opencode-cli.js";
import { executeCodexCLI } from "./codex-cli.js";
import { executeKimiCLI } from "./kimi-cli.js";
import { runWithFallbackChain, DEFAULT_FALLBACK_ORDER, type ExecutorKind } from "./fallback-orchestrator.js";
import { writeChainTrace } from "./trace-writer.js";
import { getCatalogEntry, getClaudeDefaultModel } from "../commands/index.js";
import { buildConversationContext, CONTEXT_DEFAULTS, type ContextSource } from "./context-builder.js";

export type CLIExecutor = "claude" | "gemini" | "codex" | "kimi" | "chatgpt" | "opencode";

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".heif", ".tiff", ".svg"];

/** True if any attachment path looks like an image (GLM-5.2 is text-only). */
function hasImageAttachment(attachments?: string[]): boolean {
  if (!attachments?.length) return false;
  return attachments.some((p) => IMAGE_EXTENSIONS.some((ext) => p.toLowerCase().endsWith(ext)));
}

/** Default model for a freshly-resolved executor (no explicit/lane model). */
function defaultModelFor(executor: CLIExecutor): string | undefined {
  return getCatalogEntry(executor)?.defaultModel ?? undefined;
}

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
  /** Called with phased message chunks for non-Claude streaming executors */
  onMessageChunk?: (chunk: RunMessageChunk) => void;
  /** Called with structured step events (tool_use, tool_result, thinking) */
  onEvent?: (event: import("./claude.js").StreamStepEvent) => void;
}

export interface CLIRunResult {
  runId: string;
  status: CLIRunStatus;
  output: string;
  exitCode: number;
  duration: number;
  executor: CLIExecutor;
  sessionId?: string | null;
  assistantThreadMessageId?: string | null;
}

export interface RunMessageChunk {
  runId: string;
  seq: number;
  id?: string;
  phase: string;
  delta: string;
}

interface ActiveRun {
  runId: string;
  lane: string;
  abort: () => void;
  cancelled: boolean;
}

const MEMORY_HINT =
  "Use Homer memory MCP tools directly when memory matters. Call memory_context for fresh current context, memory_read for durable files, memory_search for lookup (use mode='hybrid' for chunk-only semantic recall), memory_suggest for decisions/preferences/lessons, and memory_promote only for simple stable facts.";
const TELEGRAM_HINT =
  "Keep responses concise and readable on mobile. Short paragraphs, no HTML, no unnecessary formatting. Get to the point.";
const CHATGPT_BROWSER_HINT =
  "Use the browser tool to access chatgpt.com and complete the task there. Keep the final response here concise and include any relevant output or links.";

const CODEX_HOME = process.env.CODEX_HOME || `${process.env.HOME ?? process.cwd()}/.codex`;
const CODEX_AGENT_PATH = `${CODEX_HOME}/AGENTS.md`;

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

  // Gemini is a pure research/tool CLI — no memory access.
  if (params.executor === "codex" || params.executor === "opencode") {
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
  /** In-memory partial output for streaming non-Claude executors to web SSE */
  private partialOutputs: Map<string, string> = new Map();
  /** In-memory step event queues for streaming non-Claude executors to web SSE */
  private stepQueues: Map<string, import("./claude.js").StreamStepEvent[]> = new Map();
  /** In-memory phased message chunk queues for streaming non-Claude executors to web SSE */
  private messageChunkQueues: Map<string, RunMessageChunk[]> = new Map();
  /** Per-lane promise chain — serializes turns so msgs sent while a turn is
   *  running queue behind it instead of getting rejected. */
  private laneChains: Map<string, Promise<unknown>> = new Map();
  /** How many runs are queued (but not yet started) per lane. */
  private laneQueueDepth: Map<string, number> = new Map();

  get activeCount(): number {
    return this.activeRuns.size;
  }

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
  }

  getActiveRun(lane: string): ActiveRun | null {
    return this.activeRuns.get(lane) ?? null;
  }

  /** Number of runs currently queued behind the active one on this lane. */
  getQueueDepth(lane: string): number {
    return this.laneQueueDepth.get(lane) ?? 0;
  }

  getPartialOutput(runId: string): string | undefined {
    return this.partialOutputs.get(runId);
  }

  /** Drain pending step events (returns and clears the queue) */
  drainStepEvents(runId: string): import("./claude.js").StreamStepEvent[] {
    const queue = this.stepQueues.get(runId);
    if (!queue || queue.length === 0) return [];
    const events = [...queue];
    queue.length = 0;
    return events;
  }

  drainMessageChunks(runId: string): RunMessageChunk[] {
    const queue = this.messageChunkQueues.get(runId);
    if (!queue || queue.length === 0) return [];
    const chunks = [...queue];
    queue.length = 0;
    return chunks;
  }

  cancelRun(lane: string, reason = "cancelled"): boolean {
    const active = this.activeRuns.get(lane);
    if (!active) return false;

    logger.info({ lane, runId: active.runId, reason }, "Cancelling active CLI run");
    active.cancelled = true;
    active.abort();
    return true;
  }

  cancelAll(reason = "daemon shutdown"): number {
    let cancelled = 0;
    for (const [lane] of this.activeRuns) {
      if (this.cancelRun(lane, reason)) cancelled++;
    }
    closeAllPooledClaudeSessions(reason);
    return cancelled;
  }

  /**
   * Close the pooled Claude session for a lane (used on /new, executor switch,
   * or when the stored sessionId is cleared). Any in-flight turn is cancelled.
   */
  closeLaneSession(lane: string, reason = "closed"): void {
    this.cancelRun(lane, reason);
    closePooledClaudeSession(lane, reason);
  }

  async startRun(params: CLIRunStartParams): Promise<{ runId: string; result: Promise<CLIRunResult> }> {
    const runId = randomUUID();
    const prev = this.laneChains.get(params.lane);
    const isQueued = prev !== undefined;
    if (isQueued) {
      this.laneQueueDepth.set(params.lane, (this.laneQueueDepth.get(params.lane) ?? 0) + 1);
      logger.info(
        { lane: params.lane, runId, queueDepth: this.laneQueueDepth.get(params.lane) },
        "CLI run queued behind active run on lane"
      );
    }

    const resultPromise: Promise<CLIRunResult> = (async () => {
      if (prev) {
        try { await prev; } catch { /* previous run failure shouldn't block us */ }
      }
      if (isQueued) {
        const depth = (this.laneQueueDepth.get(params.lane) ?? 1) - 1;
        if (depth <= 0) this.laneQueueDepth.delete(params.lane);
        else this.laneQueueDepth.set(params.lane, depth);
      }
      return this._executeRun(runId, params);
    })();

    const chainTail = resultPromise.catch(() => undefined);
    this.laneChains.set(params.lane, chainTail);
    // Clear the chain entry only when no later run has queued behind this one.
    void chainTail.finally(() => {
      if (this.laneChains.get(params.lane) === chainTail) {
        this.laneChains.delete(params.lane);
      }
    });

    return { runId, result: resultPromise };
  }

  private async _executeRun(runId: string, params: CLIRunStartParams): Promise<CLIRunResult> {
    const executorState = this.stateManager.getCurrentExecutor(params.lane);
    // Resolution order: explicit turn/command -> per-lane override -> global harness default.
    // An executor_state row exists ONLY when the user explicitly /switch-ed the lane; we no
    // longer auto-seed it from the default, so the global kill-switch (harness_default) reaches
    // every non-overridden lane. Session/continuity is tracked in executor_session_map, keyed by
    // (lane, executor, model), independent of the executor_state row.
    const laneExecutor = params.executor ?? executorState?.executor ?? this.stateManager.resolveDefaultExecutor();
    const laneModel = params.model ?? executorState?.model ?? defaultModelFor(laneExecutor);

    // GLM-5.2 (opencode) is text-only: route image-bearing turns to Claude (vision) for THIS
    // turn only — the lane's persisted executor/model stay opencode and its session is untouched.
    const imageOverride = laneExecutor === "opencode" && hasImageAttachment(params.attachments);
    const executor = imageOverride ? "claude" : laneExecutor;
    const model = imageOverride ? getClaudeDefaultModel(params.lane) : laneModel;

    // Resume the session for the *resolved* executor+model from the session map (never blindly
    // from executor_state.session_id, which may belong to a different executor). Image-override
    // turns are stateless w.r.t. the opencode lane — they never resume or persist into it.
    const sessionId = imageOverride
      ? null
      : (this.stateManager.getStoredExecutorSessionId(params.lane, executor as ExecutorStateType, model ?? null) ?? null);

    const contextSource: ContextSource | null = params.threadId
      ? params.threadId.startsWith("tg:")
        ? { type: "lane", id: params.threadId }
        : { type: "thread", id: params.threadId }
      : null;

    const shouldInjectContext = (executorKind: ExecutorKind | CLIExecutor): boolean => {
      if (params.suppressContext) return false;
      if (!contextSource) return false;
      if (executorKind !== executor) return true;
      // A resumable session (for the resolved executor+model) already carries history.
      if (sessionId) return false;
      const sameExecutorRow = executorState?.executor === executor;
      if (sameExecutorRow && (executorState?.messageCount ?? 0) > 0) return false;
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
      const releaseSlot = await acquireSlot();
      try {
        let output = "";
        let exitCode = 0;
        let duration = 0;
        let newSessionId: string | null | undefined = null;
        let newSessionAccountId: number | null | undefined = null;
        let executorUsed: CLIExecutor = executor;
        let nextMessageSeq = 0;

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
            // Use per-lane pooled session so mid-session message injection reuses
            // one long-lived Claude process (no --resume respawn between turns).
            // Fallback executors (chain) spawn fresh via executeClaudeCommand.
            if (executorKind === executor) {
              const turnStart = Date.now();
              try {
                const result = await executePooledClaudeTurn(params.lane, prompt, {
                  cwd: params.cwd,
                  model: model ?? undefined,
                  resumeSessionId: sessionId ?? undefined,
                  signal: abortController.signal,
                  onPartial: params.onPartial,
                  onEvent: params.onEvent,
                });
                return {
                  output: result.output,
                  exitCode: result.exitCode,
                  duration: result.duration,
                  sessionId: result.claudeSessionId ?? null,
                  error: result.exitCode === 0 ? undefined : result.output,
                };
              } catch (err) {
                return {
                  output: err instanceof Error ? err.message : "Unknown error",
                  exitCode: 1,
                  duration: Date.now() - turnStart,
                  sessionId: null,
                  error: err instanceof Error ? err.message : "Unknown error",
                };
              }
            }
            const result = await executeClaudeCommand(prompt, {
              cwd: params.cwd,
              claudeSessionId: undefined,
              model: undefined,
              signal: abortController.signal,
              runId,
              onPartial: params.onPartial,
              onEvent: params.onEvent,
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
            const result = await executeOpenCodeCLI(prompt, "", {
              model: executorKind === executor ? model ?? undefined : undefined,
              resume: executorKind === executor ? sessionId ?? undefined : undefined,
              accountId: resumeAccountId,
              signal: abortController.signal,
              sandbox: true,
              yolo: true,
              runId,
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
              runId,
              onMessageChunk: params.onMessageChunk
                ? ({ id, phase, delta }) => {
                    params.onMessageChunk?.({
                      runId,
                      seq: ++nextMessageSeq,
                      id,
                      phase,
                      delta,
                    });
                  }
                : undefined,
              onPartial: params.onPartial,
              onEvent: params.onEvent,
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
            const opencodeModel = model || defaultModelFor("opencode");
            const runOpenCode = (resumeId: string | undefined) =>
              executeOpenCodeCLI(prompt, "", {
                model: opencodeModel,
                forceOpenCode: true,
                researchOnly: false, // main harness: opencode turns must be edit-capable
                agent: "build",
                cwd: params.cwd,
                resume: resumeId,
                yolo: true,
                sandbox: true,
                signal: abortController.signal,
                runId,
                onPartial: params.onPartial,
              });

            const wantResume = executorKind === executor ? sessionId ?? undefined : undefined;
            let result = await runOpenCode(wantResume);
            // opencode `run -s` fails hard ("Session not found") on a pruned/stale session
            // instead of starting a new one. Invalidate exactly that stale id (keyed +
            // guarded, won't clobber a concurrently-switched session) and retry fresh once.
            if (
              wantResume &&
              result.exitCode !== 0 &&
              /session not found|invalid.*session|session.*not.*valid/i.test(result.output)
            ) {
              this.stateManager.clearStaleExecutorSession(params.lane, "opencode", opencodeModel ?? null, wantResume);
              result = await runOpenCode(undefined);
            }
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
            runId,
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
            chain: DEFAULT_FALLBACK_ORDER,
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

          writeChainTrace(fallbackResult, { jobId: runId, source: "runtime" });

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
            onEvent: params.onEvent,
          });
          output = result.output;
          exitCode = result.exitCode;
          duration = result.duration;
          executorUsed = "chatgpt";
          newSessionId = result.claudeSessionId ?? null;
        } else {
          // Wire onPartial/onEvent to store in-memory for SSE consumers (web UI)
          if (executor !== "codex" && !params.onPartial) {
            params.onPartial = (text: string) => {
              this.partialOutputs.set(runId, text);
            };
          }
          if (executor === "codex" && !params.onMessageChunk) {
            params.onMessageChunk = (chunk) => {
              let queue = this.messageChunkQueues.get(runId);
              if (!queue) {
                queue = [];
                this.messageChunkQueues.set(runId, queue);
              }
              queue.push(chunk);
              this.stateManager.updateCliRunStream(runId, {
                appendDelta: chunk.phase === "final_answer" ? chunk.delta : null,
                phase: chunk.phase,
                seq: chunk.seq,
                updatedAt: Date.now(),
              });
            };
          }
          if (!params.onEvent) {
            params.onEvent = (event) => {
              let queue = this.stepQueues.get(runId);
              if (!queue) { queue = []; this.stepQueues.set(runId, queue); }
              queue.push(event);
              if (params.threadId) {
                this.stateManager.createRunEvent({
                  id: randomUUID(),
                  runId,
                  threadId: params.threadId,
                  kind: event.type,
                  label: event.label,
                  labelDone: event.labelDone,
                  payload: {
                    toolId: event.id,
                    preview: event.preview,
                    tool: event.tool,
                  },
                });
              }
            };
          }
          const result = await runExecutor(executor as ExecutorKind);
          output = result.output;
          exitCode = result.exitCode;
          duration = result.duration;
          executorUsed = executor;
          newSessionId = result.sessionId ?? null;
          newSessionAccountId = result.accountId ?? null;
        }

        const cleanedResponse = output;

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
        let assistantThreadMessageId: string | null = null;
        if (params.threadId && threadContent) {
          assistantThreadMessageId = randomUUID();
          this.stateManager.createThreadMessage({
            id: assistantThreadMessageId,
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

        // Update executor state. An image-override turn ran Claude as a transient vision detour:
        // store its session only in Claude's own map slot, and never touch the opencode lane's
        // executor_state row or message count (keeps the opencode session + continuity intact).
        if (persistedSessionId) {
          if (imageOverride) {
            this.stateManager.setStoredExecutorSessionId(
              params.lane,
              "claude",
              persistedSessionId,
              model ?? null,
              newSessionAccountId ?? null
            );
          } else {
            this.stateManager.setExecutorSessionId(
              params.lane,
              persistedSessionId,
              executorUsed as ExecutorStateType,
              model ?? null,
              newSessionAccountId ?? null
            );
          }
        }

        const status: CLIRunStatus = exitCode === 0 ? "completed" : (wasCancelled ? "cancelled" : "failed");
        if (status !== "cancelled" && !imageOverride) {
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
          assistantThreadMessageId,
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
        releaseSlot();
        this.activeRuns.delete(params.lane);
        this.partialOutputs.delete(runId);
        this.stepQueues.delete(runId);
        this.messageChunkQueues.delete(runId);
      }
    })();

    return runPromise;
  }
}
