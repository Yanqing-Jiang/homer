import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import type { ExecutorResult } from "./types.js";
import { logger } from "../utils/logger.js";

const DEFAULT_TIMEOUT = 1200_000; // 20 minutes
const KILL_GRACE_MS = 5_000;
const CLOSE_GRACE_MS = 1_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2MB capture cap
const CLAUDE_PATH = process.env.CLAUDE_PATH ?? "/Users/yj/.local/bin/claude";

// Note: Keychain token extraction was removed.
// In Aqua session, Claude CLI can access keychain directly and handle
// token refresh automatically. This is more reliable than extracting
// and injecting the (often expired) access token.

// Subagent-specific timeouts (longer for complex tasks)
const SUBAGENT_TIMEOUTS: Record<string, number> = {
  gemini: 15 * 60 * 1000, // 15 minutes
  codex: 20 * 60 * 1000,  // 20 minutes
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
}

export interface ClaudeExecutorResult extends ExecutorResult {
  claudeSessionId?: string;
}

interface StreamEvent {
  type: string;
  session_id?: string;
  message?: {
    content?: string;
  };
  content?: string;
  result?: string;
}

export async function executeClaudeCommand(
  query: string,
  options: ClaudeExecutorOptions
): Promise<ClaudeExecutorResult> {
  const startTime = Date.now();
  const { cwd, claudeSessionId, subagent, model, signal } = options;

  // Use subagent-specific timeout if applicable
  const timeout = subagent ? (SUBAGENT_TIMEOUTS[subagent] ?? DEFAULT_TIMEOUT) : DEFAULT_TIMEOUT;

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

  args.push(finalQuery);

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
    HOME: process.env.HOME ?? "/Users/yj",
  };
  // Load OAuth token from file if not in env
  const tokenFile = `${process.env.HOME ?? "/Users/yj"}/.homer-claude-token`;
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

  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_PATH, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // Create new process group for proper cleanup
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

        // Capture assistant message content
        if (event.type === "assistant" && event.message?.content) {
          resultContent += event.message.content;
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

        if (!stdoutTruncated) {
          if (stdoutBytes <= MAX_OUTPUT_BYTES) {
            stdout += chunk;
            // Parse streaming JSON events line by line
            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              parseStreamEvent(line);
            }
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
