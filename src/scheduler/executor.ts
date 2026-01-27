import { spawn } from "child_process";
import { logger } from "../utils/logger.js";
import type { RegisteredJob, JobExecutionResult } from "./types.js";
import { LANE_CWD, DEFAULT_JOB_TIMEOUT } from "./types.js";
import { processMemoryUpdates } from "../memory/writer.js";

const CLAUDE_PATH = "/Users/yj/.local/bin/claude";
const KILL_GRACE_MS = 5_000;
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024; // 1MB capture cap

/**
 * Execute a scheduled job via Claude CLI
 */
export async function executeScheduledJob(job: RegisteredJob): Promise<JobExecutionResult> {
  const startedAt = new Date();
  const { config, sourceFile } = job;
  const timeout = config.timeout ?? DEFAULT_JOB_TIMEOUT;
  const cwd = LANE_CWD[config.lane] ?? LANE_CWD.default;

  logger.info(
    {
      jobId: config.id,
      name: config.name,
      lane: config.lane,
      cwd,
      timeout,
    },
    "Executing scheduled job"
  );

  const args = [
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "-p", // Print mode - no session resume for scheduled jobs
    config.query,
  ];

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CODE_ENTRYPOINT: "homer-scheduler",
    CI: "1",
    TERM: "dumb",
    NO_COLOR: "1",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
  };

  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_PATH, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let resultContent = "";
    let timedOut = false;
    let settled = false;

    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    const parseStreamEvent = (line: string): void => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as {
          type: string;
          message?: { content?: string };
          result?: string;
        };
        if (event.type === "assistant" && event.message?.content) {
          resultContent += event.message.content;
        }
        if (event.type === "result" && event.result) {
          resultContent = event.result;
        }
      } catch {
        // Not JSON
      }
    };

    const finalize = async (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimers();

      const completedAt = new Date();
      const duration = completedAt.getTime() - startedAt.getTime();
      let output = resultContent.trim() || stdout.trim();
      const success = !timedOut && !error && exitCode === 0;

      let errorMessage = error;
      if (timedOut) {
        errorMessage = `Job timed out after ${timeout / 1000}s`;
      } else if (exitCode !== 0 && !error) {
        errorMessage = `Exit code ${exitCode}`;
      }

      if (stderr.trim()) {
        errorMessage = errorMessage
          ? `${errorMessage}\n\nStderr:\n${stderr.trim()}`
          : stderr.trim();
      }

      // Process memory updates from scheduled job output
      try {
        const { cleanedResponse, updatesWritten, targets } = await processMemoryUpdates(
          output,
          config.lane
        );
        if (updatesWritten > 0) {
          logger.info({ jobId: config.id, updatesWritten, targets }, "Memory updated from scheduled job");
        }
        output = cleanedResponse;
      } catch (memErr) {
        logger.warn({ error: memErr, jobId: config.id }, "Failed to process memory updates");
      }

      logger.info(
        {
          jobId: config.id,
          success,
          duration,
          exitCode,
          timedOut,
          outputLength: output.length,
        },
        "Scheduled job completed"
      );

      resolve({
        jobId: config.id,
        jobName: config.name,
        sourceFile,
        startedAt,
        completedAt,
        success,
        output: output || "(No output)",
        error: errorMessage,
        exitCode: exitCode ?? 1,
        duration,
      });
    };

    // Close stdin
    if (proc.stdin) {
      proc.stdin.on("error", () => {});
      proc.stdin.end();
    }

    if (proc.stdout) {
      proc.stdout.setEncoding("utf8");
      let buffer = "";

      proc.stdout.on("data", (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes <= MAX_OUTPUT_BYTES) {
          stdout += chunk;
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            parseStreamEvent(line);
          }
        }
      });

      proc.stdout.on("end", () => {
        if (buffer) parseStreamEvent(buffer);
      });
    }

    if (proc.stderr) {
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk: string) => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes <= MAX_OUTPUT_BYTES) {
          stderr += chunk;
        }
      });
    }

    proc.once("error", (err) => {
      void finalize(null, err.message);
    });

    proc.once("close", (code) => {
      void finalize(code);
    });

    // Timeout handling
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      logger.warn({ jobId: config.id, timeout }, "Scheduled job timed out");
      try {
        proc.kill("SIGTERM");
      } catch {}

      killTimer = setTimeout(() => {
        if (!settled) {
          try {
            proc.kill("SIGKILL");
          } catch {}
        }
      }, KILL_GRACE_MS);
    }, timeout);
  });
}
