import { spawn } from "child_process";
import type { ExecutorResult } from "./types.js";
import { logger } from "../utils/logger.js";

const DEFAULT_TIMEOUT = 600_000; // 10 minutes
const KILL_GRACE_MS = 5_000;
const CLOSE_GRACE_MS = 1_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2MB capture cap
const CLAUDE_PATH = "/Users/yj/.local/bin/claude";

// Subagent-specific timeouts (longer for complex tasks)
const SUBAGENT_TIMEOUTS: Record<string, number> = {
  gemini: 10 * 60 * 1000, // 10 minutes
  codex: 15 * 60 * 1000,  // 15 minutes
};

// Subagent prompt templates
const SUBAGENT_PROMPTS: Record<string, string> = {
  gemini: "[Use the gemini subagent for this task] ",
  codex: "[Use the codex subagent for this task] ",
};

export interface ClaudeExecutorOptions {
  cwd: string;
  claudeSessionId?: string;
  subagent?: "gemini" | "codex";
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
  const { cwd, claudeSessionId, subagent } = options;

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

  if (claudeSessionId) {
    args.push("--resume", claudeSessionId);
    logger.debug({ claudeSessionId }, "Resuming Claude session");
  }

  args.push(finalQuery);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CODE_ENTRYPOINT: "homer",
    CI: process.env.CI ?? "1",
    TERM: process.env.TERM ?? "dumb",
    NO_COLOR: process.env.NO_COLOR ?? "1",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
  };

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

    // Timeout with SIGTERM -> SIGKILL escalation
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      logger.error(
        { pid: proc.pid, timeoutMs: timeout, subagent, stdoutBytes, stderrBytes },
        "Claude CLI timed out"
      );

      try {
        proc.kill("SIGTERM");
      } catch (error) {
        logger.warn({ error }, "Failed to SIGTERM Claude CLI");
      }

      killTimer = setTimeout(() => {
        if (proc.exitCode == null && proc.signalCode == null) {
          try {
            proc.kill("SIGKILL");
            logger.warn({ pid: proc.pid }, "Sent SIGKILL to Claude CLI");
          } catch (error) {
            logger.warn({ error }, "Failed to SIGKILL Claude CLI");
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
