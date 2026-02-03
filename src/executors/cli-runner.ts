import { randomUUID } from "crypto";
import { readFileSync, existsSync } from "fs";
import { logger } from "../utils/logger.js";
import { StateManager, type CLIRunStatus } from "../state/manager.js";
import { executeClaudeCommand } from "./claude.js";
import { executeGeminiCLI } from "./gemini-cli.js";
import { executeCodexCLI } from "./codex-cli.js";
import { processMemoryUpdates } from "../memory/writer.js";
import { getExecutorModel } from "../commands/index.js";

export type CLIExecutor = "claude" | "gemini" | "codex";

export interface CLIRunStartParams {
  lane: string;
  executor?: CLIExecutor;
  model?: string;
  query: string;
  cwd: string;
  attachments?: string[];
  threadId?: string;
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
}): string {
  const parts: string[] = [];

  if (params.executor === "codex") {
    const agent = loadCodexAgent();
    if (agent) parts.push(agent);
  }

  if (params.executor === "gemini" || params.executor === "codex") {
    parts.push(MEMORY_HINT);
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

    const executorState = this.stateManager.getCurrentExecutor(params.lane);
    const executor = params.executor ?? executorState?.executor ?? "claude";
    const model = params.model ?? executorState?.model ?? getExecutorModel(executor);
    const sessionId = executorState?.sessionId ?? null;

    if (!executorState) {
      this.stateManager.setCurrentExecutor(params.lane, executor, model ?? undefined, sessionId);
    }

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

    const finalPrompt = buildPrompt({
      executor,
      query: params.query,
      attachments: params.attachments,
    });

    const runPromise = (async (): Promise<CLIRunResult> => {
      try {
        let output = "";
        let exitCode = 0;
        let duration = 0;
        let newSessionId: string | null | undefined = null;

        if (executor === "claude") {
          const result = await executeClaudeCommand(finalPrompt, {
            cwd: params.cwd,
            claudeSessionId: sessionId ?? undefined,
            model: model ?? undefined,
            signal: abortController.signal,
          });
          output = result.output;
          exitCode = result.exitCode;
          duration = result.duration;
          newSessionId = result.claudeSessionId ?? null;
        } else if (executor === "gemini") {
          const result = await executeGeminiCLI(finalPrompt, "", {
            model: model ?? undefined,
            resume: sessionId ?? undefined,
            signal: abortController.signal,
          });
          output = result.output;
          exitCode = result.exitCode;
          duration = result.duration;
          newSessionId = result.sessionId ?? null;
        } else {
          const result = await executeCodexCLI(finalPrompt, {
            cwd: params.cwd,
            signal: abortController.signal,
          });
          output = result.output;
          exitCode = result.exitCode;
          duration = result.duration;
          newSessionId = null;
        }

        // Process memory updates (Codex/Gemini encouraged via prompt)
        const { cleanedResponse } = await processMemoryUpdates(output, "general");

        const wasCancelled = this.activeRuns.get(params.lane)?.cancelled ?? false;
        if (wasCancelled) {
          output = "Cancelled";
          exitCode = 130;
        }

        // Save assistant message if threadId is provided
        if (params.threadId && cleanedResponse.trim()) {
          this.stateManager.createThreadMessage({
            id: randomUUID(),
            threadId: params.threadId,
            role: "assistant",
            content: cleanedResponse.trim(),
            metadata: {
              executor,
              exitCode,
            },
          });
        }

        // Update executor state
        if (newSessionId) {
          this.stateManager.setExecutorSessionId(params.lane, newSessionId);
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
        });

        return {
          runId,
          status,
          output: cleanedResponse.trim() || output,
          exitCode,
          duration,
          executor,
          sessionId: newSessionId ?? undefined,
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
