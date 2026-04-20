import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import type { ExecutorResult } from "./types.js";
import { logger } from "../utils/logger.js";
import { processRegistry } from "../process/registry.js";
import { getRuntimePaths } from "../utils/runtime-paths.js";

const DEFAULT_TIMEOUT = 1800_000; // 30 minutes
const KILL_GRACE_MS = 5_000;
const CLOSE_GRACE_MS = 1_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2MB capture cap
/** Resolve Claude binary path at call time, not module load time.
 * This handles CLI auto-updates that change the symlink target after daemon start. */
function resolveClaudePath(): string {
  const envPath = process.env.CLAUDE_PATH;
  if (envPath) return envPath;
  const paths = getRuntimePaths();
  return paths.claudeBinaryPath;
}


// Note: Keychain token extraction was removed.
// In Aqua session, Claude CLI can access keychain directly and handle
// token refresh automatically. This is more reliable than extracting
// and injecting the (often expired) access token.

// Subagent-specific timeouts (longer for complex tasks)
const SUBAGENT_TIMEOUTS: Record<string, number> = {
  gemini: 15 * 60 * 1000, // 15 minutes
  codex: 30 * 60 * 1000,  // 30 minutes
  kimi: 10 * 60 * 1000,   // 10 minutes (faster parallel execution)
};

// Subagent prompt templates
const SUBAGENT_PROMPTS: Record<string, string> = {
  gemini: "[Use the gemini subagent for this task] ",
  codex: "[Use the codex subagent for this task] ",
  kimi: "[Use the kimi subagent for this task - specialized in parallel research, front-end design, and visual analysis] ",
};

export interface ClaudeExecutorOptions {
  cwd: string;
  claudeSessionId?: string;
  subagent?: "gemini" | "codex" | "kimi";
  model?: string; // Model override (e.g., "sonnet", "opus")
  signal?: AbortSignal;
  timeout?: number; // Override default/subagent timeout
  /** Called with cumulative text as assistant content streams in */
  onPartial?: (text: string) => void;
  /** Called with structured step events (tool_use, tool_result, thinking) */
  onEvent?: (event: StreamStepEvent) => void;
}

export interface ClaudeExecutorResult extends ExecutorResult {
  claudeSessionId?: string;
}

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
}

export interface StreamStepEvent {
  type: "tool_use" | "tool_result" | "thinking";
  id?: string;
  tool?: string;
  label: string;
  labelDone: string;
  preview?: string;
}

export interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
  content?: string | ContentBlock[];
  result?: string;
}

export function buildToolLabel(name: string, input?: Record<string, unknown>): { label: string; labelDone: string; preview?: string } {
  // Handle MCP tools: mcp__server__tool → tool
  const shortName = name.includes("__") ? name.split("__").pop()! : name;

  const filePath = input?.file_path as string | undefined;
  const command = input?.command as string | undefined;
  const pattern = input?.pattern as string | undefined;
  const description = input?.description as string | undefined;
  const query = input?.query as string | undefined;

  const shortPath = filePath ? filePath.split("/").pop() : undefined;

  switch (shortName) {
    case "Read":
      return { label: `Reading ${shortPath ?? "file"}`, labelDone: `Read ${shortPath ?? "file"}`, preview: filePath?.slice(0, 220) };
    case "Write":
      return { label: `Writing ${shortPath ?? "file"}`, labelDone: `Wrote ${shortPath ?? "file"}`, preview: filePath?.slice(0, 220) };
    case "Edit":
      return { label: `Editing ${shortPath ?? "file"}`, labelDone: `Edited ${shortPath ?? "file"}`, preview: filePath?.slice(0, 220) };
    case "Bash":
      return { label: description ?? "Running command", labelDone: description ?? "Ran command", preview: command?.slice(0, 220) };
    case "Glob":
      return { label: `Searching files: ${pattern ?? ""}`, labelDone: `Searched files`, preview: pattern?.slice(0, 220) };
    case "Grep":
      return { label: `Searching for "${pattern ?? ""}"`, labelDone: `Searched code`, preview: pattern?.slice(0, 220) };
    case "Agent":
      return { label: description ?? "Running agent", labelDone: description ?? "Agent finished" };
    case "WebFetch":
      return { label: "Fetching URL", labelDone: "Fetched URL", preview: (input?.url as string)?.slice(0, 220) };
    case "WebSearch":
      return { label: `Searching: ${query ?? ""}`, labelDone: "Searched web", preview: query?.slice(0, 220) };
    default:
      return { label: `Using ${shortName}`, labelDone: `Used ${shortName}` };
  }
}

export function extractTextContent(content: string | ContentBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text)
      .join("");
  }
  return "";
}

export async function executeClaudeCommand(
  query: string,
  options: ClaudeExecutorOptions
): Promise<ClaudeExecutorResult> {
  const startTime = Date.now();
  const { cwd, claudeSessionId, subagent, model, signal } = options;

  // Use explicit timeout, then subagent-specific, then default
  const timeout = options.timeout
    ?? (subagent ? (SUBAGENT_TIMEOUTS[subagent] ?? DEFAULT_TIMEOUT) : DEFAULT_TIMEOUT);

  // Build the query with optional subagent prompt injection
  let finalQuery = query;
  if (subagent && SUBAGENT_PROMPTS[subagent]) {
    finalQuery = SUBAGENT_PROMPTS[subagent] + query;
  }

  // Build args with stream-json output and optional resume
  // --print and --verbose are required for --output-format=stream-json
  const args = ["--print", "--verbose", "--output-format", "stream-json", "--dangerously-skip-permissions"];

  // Add model override if specified
  if (model) {
    args.push("--model", model);
    logger.debug({ model }, "Using model override");
  }

  if (claudeSessionId) {
    args.push("--resume", claudeSessionId);
    logger.debug({ claudeSessionId }, "Resuming Claude session");
  }

  args.push("--", finalQuery);

  // In Aqua session, Claude CLI can access keychain directly for OAuth.
  // Don't inject token via env var - let Claude handle refresh automatically.
  // Only the CLAUDE_CODE_ENTRYPOINT is needed to identify Homer as the caller.

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CODE_ENTRYPOINT: "homer",
    CI: process.env.CI ?? "1",
    TERM: process.env.TERM ?? "dumb",
    NO_COLOR: process.env.NO_COLOR ?? "1",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    HOME: getRuntimePaths().homeDir,
  };
  // Load OAuth token from file if not in env
  const tokenFile = getRuntimePaths().claudeTokenFile;
  if (!env.CLAUDE_CODE_OAUTH_TOKEN && existsSync(tokenFile)) {
    try {
      const token = readFileSync(tokenFile, "utf-8").trim();
      if (token) {
        env.CLAUDE_CODE_OAUTH_TOKEN = token;
      }
    } catch {
      // Ignore token file read errors
    }
  }

  logger.debug(
    {
      cwd,
      args: args.slice(0, -1).concat(["<query>"]), // Don't log full query
      resuming: !!claudeSessionId,
      subagent,
    },
    "Spawning Claude CLI"
  );

  const claudeBin = resolveClaudePath();
  return new Promise((resolve, reject) => {
    const proc = spawn(claudeBin, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // Create new process group for proper cleanup
    });

    // Register with process lifecycle management
    processRegistry.register(proc, {
      command: "claude",
      type: "executor",
      timeoutMs: timeout,
      source: "cli-runner",
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Session ID captured from stream
    let capturedSessionId: string | undefined;
    // Accumulated result content
    let resultContent = "";

    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let closed = false;
    let settled = false;
    let timedOut = false;

    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let hardTimeoutTimer: NodeJS.Timeout | undefined;
    let closeFallbackTimer: NodeJS.Timeout | undefined;
    let aborted = false;

    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (hardTimeoutTimer) clearTimeout(hardTimeoutTimer);
      if (closeFallbackTimer) clearTimeout(closeFallbackTimer);
    };

    const parseStreamEvent = (line: string): void => {
      if (!line.trim()) return;

      try {
        const event = JSON.parse(line) as StreamEvent;

        // Capture session_id from init or system event
        if ((event.type === "system" || event.type === "init") && event.session_id) {
          capturedSessionId = event.session_id;
          logger.debug({ sessionId: capturedSessionId }, "Captured Claude session ID");
        }

        // Capture assistant message content + emit step events
        if (event.type === "assistant" && event.message?.content) {
          const content = event.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                resultContent += block.text;
              } else if (block.type === "tool_use" && block.name && options.onEvent) {
                // Flush accumulated text via onPartial BEFORE emitting tool_use,
                // so consumers see the text delta before the step marker.
                if (options.onPartial && resultContent) {
                  try { options.onPartial(resultContent); } catch { /* don't crash executor */ }
                }
                try {
                  const labels = buildToolLabel(block.name, block.input);
                  options.onEvent({
                    type: "tool_use",
                    id: block.id,
                    tool: block.name,
                    ...labels,
                  });
                } catch { /* don't crash executor */ }
              } else if (block.type === "thinking" && options.onEvent) {
                try {
                  const thinkingText = (block.thinking ?? "").trim();
                  options.onEvent({
                    type: "thinking",
                    label: "Thinking...",
                    labelDone: "Thought",
                    preview: thinkingText || undefined,
                  });
                } catch { /* don't crash executor */ }
              }
            }
          } else {
            resultContent += extractTextContent(content);
          }
          if (options.onPartial && resultContent) {
            try { options.onPartial(resultContent); } catch { /* don't crash executor */ }
          }
        }

        // Capture user message tool_result events
        if (event.type === "user" && options.onEvent) {
          const content = event.message?.content ?? event.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result" && block.tool_use_id) {
                try {
                  const previewText = typeof block.content === "string"
                    ? block.content
                    : Array.isArray(block.content)
                      ? extractTextContent(block.content)
                      : "";
                  options.onEvent({
                    type: "tool_result",
                    id: block.tool_use_id,
                    label: "",
                    labelDone: "",
                    preview: previewText?.slice(0, 220),
                  });
                } catch { /* don't crash executor */ }
              }
            }
          }
        }

        // Capture result content (final response)
        if (event.type === "result" && event.result) {
          resultContent = event.result;
        }
      } catch {
        // Not JSON, might be stderr or other output
      }
    };

    const finalize = (reason: string) => {
      if (settled) return;
      settled = true;
      clearTimers();

      const duration = Date.now() - startTime;

      // Use parsed result content if available, otherwise fall back to raw stdout
      let output = resultContent.trim() || stdout.trim();

      if (stderr) {
        output = output ? `${output}\n\nStderr:\n${stderr}` : stderr;
      }

      logger.debug(
        {
          reason,
          pid: proc.pid,
          exitCode,
          exitSignal,
          duration,
          stdoutBytes,
          stderrBytes,
          stdoutTruncated,
          stderrTruncated,
          timedOut,
          killed: proc.killed,
          capturedSessionId,
        },
        "Claude CLI completed"
      );

      if (aborted) {
        reject(new Error("Cancelled"));
        return;
      }

      if (timedOut) {
        reject(new Error(`Claude command timed out after ${timeout / 1000}s`));
        return;
      }

      resolve({
        output: output || "(No output)",
        exitCode: exitCode ?? 1,
        duration,
        executor: "claude",
        claudeSessionId: capturedSessionId,
      });
    };

    proc.once("spawn", () => {
      logger.debug({ pid: proc.pid }, "Claude CLI spawned");
    });

    // CRITICAL FIX: Close stdin immediately to send EOF
    if (proc.stdin) {
      proc.stdin.on("error", (error) => {
        logger.debug({ error }, "Claude stdin error");
      });
      proc.stdin.end();
    }

    if (proc.stdout) {
      proc.stdout.setEncoding("utf8");
      let buffer = "";

      proc.stdout.on("data", (chunk: string) => {
        const byteLen = Buffer.byteLength(chunk);
        stdoutBytes += byteLen;
        if (proc.pid) processRegistry.touch(proc.pid);

        // Always parse stream events (captures result/session_id even if raw log is truncated)
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          parseStreamEvent(line);
        }

        // Cap raw stdout separately (only used for fallback logging)
        if (!stdoutTruncated) {
          if (stdoutBytes <= MAX_OUTPUT_BYTES) {
            stdout += chunk;
          } else {
            const over = stdoutBytes - MAX_OUTPUT_BYTES;
            const keep = chunk.length - over;
            if (keep > 0) stdout += chunk.slice(0, keep);
            stdoutTruncated = true;
          }
        }
      });
      proc.stdout.on("error", (error) => {
        logger.warn({ error }, "Claude stdout error");
      });
      proc.stdout.on("end", () => {
        // Parse any remaining buffer
        if (buffer) {
          parseStreamEvent(buffer);
        }
      });
    }

    if (proc.stderr) {
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk: string) => {
        const byteLen = Buffer.byteLength(chunk);
        stderrBytes += byteLen;
        if (!stderrTruncated) {
          if (stderrBytes <= MAX_OUTPUT_BYTES) {
            stderr += chunk;
          } else {
            const over = stderrBytes - MAX_OUTPUT_BYTES;
            const keep = chunk.length - over;
            if (keep > 0) stderr += chunk.slice(0, keep);
            stderrTruncated = true;
          }
        }
      });
      proc.stderr.on("error", (error) => {
        logger.warn({ error }, "Claude stderr error");
      });
    }

    // Use 'exit' event with fallback, not just 'close'
    proc.once("exit", (code, signal) => {
      exitCode = code ?? exitCode;
      exitSignal = signal ?? exitSignal;

      if (!closed) {
        closeFallbackTimer = setTimeout(() => finalize("exit-no-close"), CLOSE_GRACE_MS);
      } else {
        finalize("exit");
      }
    });

    proc.once("close", (code, signal) => {
      closed = true;
      exitCode = code ?? exitCode;
      exitSignal = signal ?? exitSignal;
      finalize("close");
    });

    proc.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      logger.error({ error }, "Failed to spawn Claude CLI");
      reject(new Error(`Failed to spawn Claude: ${error.message}`));
    });

    // Helper to kill process group (negative PID kills all processes in group)
    const killProcessGroup = (signal: NodeJS.Signals): boolean => {
      if (!proc.pid) return false;
      try {
        // Kill the entire process group by sending signal to negative PID
        process.kill(-proc.pid, signal);
        return true;
      } catch (error) {
        // Fallback to killing just the process if group kill fails
        try {
          proc.kill(signal);
          return true;
        } catch {
          return false;
        }
      }
    };

    const abortHandler = () => {
      if (settled) return;
      aborted = true;
      logger.warn({ pid: proc.pid }, "Claude CLI aborted");
      if (!killProcessGroup("SIGTERM")) {
        logger.warn({ pid: proc.pid }, "Failed to SIGTERM Claude CLI process group on abort");
      }
      setTimeout(() => {
        if (proc.exitCode == null && proc.signalCode == null) {
          if (killProcessGroup("SIGKILL")) {
            logger.warn({ pid: proc.pid }, "Sent SIGKILL to Claude CLI process group on abort");
          }
        }
      }, KILL_GRACE_MS);
    };

    if (signal) {
      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    // Timeout with SIGTERM -> SIGKILL escalation (kills entire process group)
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      logger.error(
        { pid: proc.pid, timeoutMs: timeout, subagent, stdoutBytes, stderrBytes },
        "Claude CLI timed out"
      );

      if (!killProcessGroup("SIGTERM")) {
        logger.warn({ pid: proc.pid }, "Failed to SIGTERM Claude CLI process group");
      }

      killTimer = setTimeout(() => {
        if (proc.exitCode == null && proc.signalCode == null) {
          if (killProcessGroup("SIGKILL")) {
            logger.warn({ pid: proc.pid }, "Sent SIGKILL to Claude CLI process group");
          } else {
            logger.warn({ pid: proc.pid }, "Failed to SIGKILL Claude CLI process group");
          }
        }
      }, KILL_GRACE_MS);

      hardTimeoutTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          logger.error({ pid: proc.pid }, "Claude CLI did not exit after SIGKILL");
          reject(new Error(`Claude command timed out after ${timeout / 1000}s`));
        }
      }, KILL_GRACE_MS + CLOSE_GRACE_MS);
    }, timeout);
  });
}
