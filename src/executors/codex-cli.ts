import { spawn } from "child_process";
import type { ExecutorResult } from "./types.js";
import type { StreamStepEvent } from "./claude.js";
import { logger } from "../utils/logger.js";
import { processRegistry } from "../process/registry.js";

const DEFAULT_TIMEOUT = 1800_000; // 30 minutes
const KILL_GRACE_MS = 5_000;

export interface CodexCLIOptions {
  cwd: string;
  timeout?: number;
  signal?: AbortSignal;
  sessionId?: string;
  model?: string;
  reasoningEffort?: string;
  /** Called with cumulative text as codex streams tokens */
  onPartial?: (text: string) => void;
  /** Called with structured step events (tool_use, tool_result) */
  onEvent?: (event: StreamStepEvent) => void;
}

export interface CodexCLIResult extends ExecutorResult {
  sessionId?: string;
}

interface CodexStreamItem {
  id?: string;
  type?: string;
  text?: string;
  message?: string;
  content?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: Array<{ path?: string; kind?: string }>;
}

interface CodexStreamEvent {
  type?: string;
  thread_id?: string;
  item?: CodexStreamItem;
  message?: string;
}

/**
 * Execute Codex CLI with a full prompt.
 * Command: codex exec --json --dangerously-bypass-approvals-and-sandbox <prompt>
 * Resume:  codex exec resume --json --dangerously-bypass-approvals-and-sandbox <sessionId> <prompt>
 */
export async function executeCodexCLI(
  prompt: string,
  options: CodexCLIOptions,
): Promise<CodexCLIResult> {
  const startTime = Date.now();
  const {
    cwd,
    timeout = DEFAULT_TIMEOUT,
    signal,
    sessionId,
    model,
    reasoningEffort = "high",
    onPartial,
    onEvent,
  } = options;

  return new Promise((resolve, reject) => {
    const args: string[] = sessionId
      ? [
          "exec",
          "resume",
          "--json",
          "--dangerously-bypass-approvals-and-sandbox",
        ]
      : ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox"];

    if (model) args.push("-m", model);
    if (reasoningEffort)
      args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);

    if (sessionId) {
      args.push(sessionId, prompt);
    } else {
      args.push(prompt);
    }

    const child = spawn("codex", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: {
        ...process.env,
        CI: process.env.CI ?? "1",
        TERM: process.env.TERM ?? "dumb",
        NO_COLOR: process.env.NO_COLOR ?? "1",
        PATH:
          process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",
      },
    });

    // Register with process lifecycle management
    processRegistry.register(child, {
      command: "codex",
      type: "executor",
      timeoutMs: timeout,
      source: "cli-runner",
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let buffer = "";
    let capturedSessionId: string | undefined;
    const responseChunks: string[] = [];
    const errorChunks: string[] = [];

    const finalize = (exitCode: number, output: string) => {
      if (settled) return;
      settled = true;
      resolve({
        output,
        exitCode,
        duration: Date.now() - startTime,
        executor: "codex",
        sessionId: capturedSessionId,
      });
    };

    // Kill entire process group (detached) for clean child cleanup
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already dead */
        }
      }
    };

    const killProcess = () => {
      if (child.exitCode == null && child.signalCode == null) {
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
      }
    };

    const abortHandler = () => {
      if (aborted) return;
      aborted = true;
      logger.warn({ pid: child.pid }, "Codex CLI aborted");
      killProcess();
    };

    if (signal) {
      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    const timeoutId = setTimeout(() => {
      timedOut = true;
      logger.warn({ pid: child.pid }, "Codex CLI timed out");
      killProcess();
    }, timeout);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (child.pid) processRegistry.touch(child.pid);

      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as CodexStreamEvent;

          if (event.type === "thread.started" && event.thread_id) {
            capturedSessionId = event.thread_id;
            continue;
          }

          // Emit step events for tool activity (command_execution, file_change)
          if (event.type === "item.started" && onEvent) {
            const item = event.item;
            if (item?.type === "command_execution" && item.command) {
              const shortCmd = item.command.replace(/^\/bin\/\w+\s+-lc\s+'?/, "").replace(/'$/, "").slice(0, 80);
              try { onEvent({ type: "tool_use", id: item.id, tool: "Bash", label: `Running: ${shortCmd}`, labelDone: `Ran: ${shortCmd}`, preview: item.command }); } catch { /* */ }
            } else if (item?.type === "file_change" && item.changes?.length) {
              const desc = item.changes.map(c => `${c.kind ?? "edit"} ${c.path?.split("/").pop() ?? "file"}`).join(", ");
              try { onEvent({ type: "tool_use", id: item.id, tool: "Edit", label: `Editing: ${desc}`, labelDone: `Edited: ${desc}` }); } catch { /* */ }
            }
          }

          if (event.type === "item.completed" || event.type === "item.delta") {
            const item = event.item;
            if (!item) continue;
            if (
              item.type === "agent_message" ||
              item.type === "assistant_message" ||
              item.type === "message"
            ) {
              const text =
                item.text ||
                (typeof item.content === "string" ? item.content : "");
              if (text) {
                responseChunks.push(text);
                if (onPartial) {
                  try { onPartial(responseChunks.join("")); } catch { /* don't crash executor */ }
                }
              }
              continue;
            }
            // Emit tool_result for completed tool items
            if (onEvent && event.type === "item.completed" && (item.type === "command_execution" || item.type === "file_change")) {
              const preview = item.type === "command_execution"
                ? (item.exit_code === 0 ? item.aggregated_output?.slice(0, 200) : `exit ${item.exit_code}`)
                : undefined;
              try { onEvent({ type: "tool_result", id: item.id, label: "", labelDone: "", preview }); } catch { /* */ }
            }
            if (item.type === "error") {
              const message = item.message || item.text;
              if (message) errorChunks.push(message);
            }
          }

          if (event.type === "error" && event.message) {
            errorChunks.push(event.message);
          }
        } catch {
          // Ignore non-JSON lines
        }
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("close", (code) => {
      clearTimeout(timeoutId);

      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim()) as CodexStreamEvent;
          if (event.type === "thread.started" && event.thread_id) {
            capturedSessionId = event.thread_id;
          } else if (
            event.type === "item.completed" ||
            event.type === "item.delta"
          ) {
            const item = event.item;
            if (
              item?.type === "agent_message" ||
              item?.type === "assistant_message" ||
              item?.type === "message"
            ) {
              const text =
                item.text ||
                (typeof item.content === "string" ? item.content : "");
              if (text) responseChunks.push(text);
            } else if (item?.type === "error") {
              const message = item.message || item.text;
              if (message) errorChunks.push(message);
            }
          } else if (event.type === "error" && event.message) {
            errorChunks.push(event.message);
          }
        } catch {
          // Ignore trailing non-JSON
        }
      }

      if (!capturedSessionId && sessionId) {
        capturedSessionId = sessionId;
      }

      if (aborted) {
        finalize(130, "Cancelled");
        return;
      }

      if (timedOut) {
        finalize(124, "Timeout");
        return;
      }

      const parsedOutput = responseChunks.join("").trim();
      const parsedErrors = errorChunks.join("\n").trim();
      const fallbackOutput =
        parsedOutput || stderr.trim() || stdout.trim() || "(No output)";

      if (code && code !== 0) {
        const errorOutput = parsedErrors || stderr.trim() || fallbackOutput;
        finalize(code, errorOutput);
        return;
      }

      const output = parsedOutput || stderr.trim() || "(No output)";
      finalize(code ?? 1, output);
    });

    child.on("error", (error) => {
      clearTimeout(timeoutId);
      if (settled) return;
      settled = true;
      reject(new Error(`Failed to spawn codex: ${error.message}`));
    });

    // Ensure stdin closes
    child.stdin?.end();
  });
}
