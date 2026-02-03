import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { logger } from "../utils/logger.js";
import type { RegisteredJob, JobExecutionResult, ProgressCallback, ProgressEvent } from "./types.js";
import { LANE_CWD, DEFAULT_JOB_TIMEOUT } from "./types.js";
import { processMemoryUpdates } from "../memory/writer.js";
import { executeKimiCLI } from "../executors/kimi-cli.js";

/**
 * Load context files and combine into a single string
 */
function loadContextFiles(files: string[]): string {
  const contents: string[] = [];
  for (const file of files) {
    const path = file.startsWith("~") ? file.replace("~", process.env.HOME ?? "") : file;
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        contents.push(`# Context from ${file}\n\n${content}`);
      } catch (err) {
        logger.warn({ file, error: err }, "Failed to read context file");
      }
    } else {
      logger.debug({ file }, "Context file not found, skipping");
    }
  }
  return contents.join("\n\n---\n\n");
}

const CLAUDE_PATH = process.env.CLAUDE_PATH ?? "/Users/yj/.local/bin/claude";
const GEMINI_PATH = process.env.GEMINI_PATH ?? "/opt/homebrew/bin/gemini";
const KILL_GRACE_MS = 5_000;
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024; // 1MB capture cap

// Tool name mappings - super short for Telegram
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  WebSearch: "🔍 Search",
  WebFetch: "🌐 Fetch",
  Read: "📖 Read",
  Glob: "📂 Find",
  Grep: "🔎 Grep",
  Bash: "💻 Run",
  Task: "🤖 Agent",
  Edit: "✏️ Edit",
  Write: "📝 Write",
  TodoWrite: "📋 Todo",
};

/**
 * Execute a Kimi job via Kimi CLI (long-context, free tier)
 */
async function executeKimiJob(
  job: RegisteredJob,
  startedAt: Date,
  onProgress?: ProgressCallback
): Promise<JobExecutionResult> {
  const { config, sourceFile } = job;
  const timeout = config.timeout ?? 1200000; // 20 minutes default for kimi
  const cwd = LANE_CWD[config.lane] ?? LANE_CWD.default;

  // Load context files if specified
  const contextPrompt = config.contextFiles?.length
    ? loadContextFiles(config.contextFiles)
    : "";

  logger.info(
    { jobId: config.id, executor: "kimi-cli", queryLength: config.query.length },
    "Executing Kimi CLI job"
  );

  try {
    const result = await executeKimiCLI(config.query, contextPrompt, {
      timeout,
      yolo: true,
      workDir: cwd,
    });

    const completedAt = new Date();
    const duration = completedAt.getTime() - startedAt.getTime();
    const success = result.exitCode === 0;

    // Emit completed event
    onProgress?.({
      type: "completed",
      jobId: config.id,
      jobName: config.name,
      timestamp: completedAt,
      message: success
        ? `✅ Completed: ${config.name} (${Math.round(duration / 1000)}s, Kimi CLI)`
        : `❌ Failed: ${config.name}`,
      details: { duration, success },
    });

    logger.info(
      {
        jobId: config.id,
        success,
        duration,
        model: result.model,
      },
      "Kimi CLI job completed"
    );

    return {
      jobId: config.id,
      jobName: config.name,
      sourceFile,
      startedAt,
      completedAt,
      success,
      output: result.output,
      error: success ? undefined : result.output,
      exitCode: result.exitCode,
      duration,
    };
  } catch (error) {
    const completedAt = new Date();
    const duration = completedAt.getTime() - startedAt.getTime();
    const errorMessage = error instanceof Error ? error.message : String(error);

    onProgress?.({
      type: "completed",
      jobId: config.id,
      jobName: config.name,
      timestamp: completedAt,
      message: `❌ Failed: ${config.name}`,
      details: { duration, success: false },
    });

    logger.error({ jobId: config.id, error: errorMessage }, "Kimi CLI job failed");

    return {
      jobId: config.id,
      jobName: config.name,
      sourceFile,
      startedAt,
      completedAt,
      success: false,
      output: "",
      error: errorMessage,
      exitCode: 1,
      duration,
    };
  }
}

/**
 * Execute a Gemini job via Gemini CLI (free with subscription)
 */
async function executeGeminiJob(
  job: RegisteredJob,
  startedAt: Date,
  onProgress?: ProgressCallback
): Promise<JobExecutionResult> {
  const { config, sourceFile } = job;
  const timeout = config.timeout ?? 1200000; // 20 minutes default for gemini
  const cwd = LANE_CWD[config.lane] ?? LANE_CWD.default;

  // Load context files if specified
  const contextPrompt = config.contextFiles?.length
    ? loadContextFiles(config.contextFiles)
    : "";

  const fullQuery = contextPrompt
    ? `Context:\n${contextPrompt}\n\n---\n\nTask:\n${config.query}`
    : config.query;

  logger.info(
    { jobId: config.id, executor: "gemini", queryLength: fullQuery.length },
    "Executing Gemini job"
  );

  return new Promise((resolve) => {
    // Use gemini CLI in non-interactive mode with yolo for auto-approval
    const args = [
      "--yolo",
      "--sandbox",
      fullQuery,
    ];

    const proc = spawn(GEMINI_PATH, args, {
      cwd,
      env: {
        ...process.env,
        CI: "1",
        TERM: "dumb",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    const finalize = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimers();

      const completedAt = new Date();
      const duration = completedAt.getTime() - startedAt.getTime();
      const output = stdout.trim();
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

      onProgress?.({
        type: "completed",
        jobId: config.id,
        jobName: config.name,
        timestamp: completedAt,
        message: success
          ? `✅ Completed: ${config.name} (${Math.round(duration / 1000)}s, Gemini)`
          : `❌ Failed: ${config.name}`,
        details: { duration, success },
      });

      logger.info(
        { jobId: config.id, success, duration, exitCode },
        "Gemini job completed"
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

    if (proc.stdin) {
      proc.stdin.on("error", () => {});
      proc.stdin.end();
    }

    if (proc.stdout) {
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        if (stdout.length < MAX_OUTPUT_BYTES) {
          stdout += chunk;
        }
      });
    }

    if (proc.stderr) {
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk: string) => {
        if (stderr.length < MAX_OUTPUT_BYTES) {
          stderr += chunk;
        }
      });
    }

    proc.once("error", (err) => finalize(null, err.message));
    proc.once("close", (code) => finalize(code));

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      logger.warn({ jobId: config.id, timeout }, "Gemini job timed out");
      try { proc.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => {
        if (!settled) {
          try { proc.kill("SIGKILL"); } catch {}
        }
      }, KILL_GRACE_MS);
    }, timeout);
  });
}

/**
 * Execute a scheduled job via Claude CLI with optional progress streaming
 */
export async function executeScheduledJob(
  job: RegisteredJob,
  onProgress?: ProgressCallback
): Promise<JobExecutionResult> {
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

  // Emit started event
  onProgress?.({
    type: "started",
    jobId: config.id,
    jobName: config.name,
    timestamp: startedAt,
    message: `🚀 Starting: ${config.name}`,
  });

  // Route to Kimi executor for kimi jobs (cheap batch processing)
  if (config.executor === "kimi") {
    return executeKimiJob(job, startedAt, onProgress);
  }

  // Route to Gemini executor (free with subscription)
  if (config.executor === "gemini") {
    return executeGeminiJob(job, startedAt, onProgress);
  }

  // Default to sonnet for cost efficiency on scheduled jobs
  const model = config.model ?? "sonnet";

  // Load context files if specified
  const contextPrompt = config.contextFiles?.length
    ? loadContextFiles(config.contextFiles)
    : "";

  const args = [
    "-p", // Print mode - no session resume for scheduled jobs
    "--verbose", // Required for stream-json output
    "--output-format",
    "stream-json",
    "--model",
    model,
    "--dangerously-skip-permissions",
  ];

  // Inject context files as system prompt
  if (contextPrompt) {
    args.push("--append-system-prompt", contextPrompt);
    logger.info({ jobId: config.id, contextLength: contextPrompt.length }, "Injected context files");
  }

  args.push(config.query);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CODE_ENTRYPOINT: "homer-scheduler",
    CI: "1",
    TERM: "dumb",
    NO_COLOR: "1",
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
        logger.info({ tokenSet: true }, "Loaded CLAUDE_CODE_OAUTH_TOKEN from file");
      }
    } catch (err) {
      logger.warn({ error: err }, "Failed to read OAuth token file");
    }
  }

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

    // Track active tools to avoid duplicate progress messages
    const activeTools = new Set<string>();

    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    const emitProgress = (event: ProgressEvent) => {
      try {
        onProgress?.(event);
      } catch (err) {
        logger.warn({ error: err }, "Failed to emit progress event");
      }
    };

    const parseStreamEvent = (line: string): void => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as {
          type: string;
          subtype?: string;
          message?: {
            content?: string | Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
          };
          result?: string;
        };

        // Capture assistant message content (only if string, not array of blocks)
        if (event.type === "assistant" && typeof event.message?.content === "string") {
          resultContent += event.message.content;
        }

        // Capture final result
        if (event.type === "result" && event.result) {
          resultContent = event.result;
        }

        // Emit progress for tool usage (content is in event.message.content for stream-json)
        const contentBlocks = event.message?.content as Array<{ type: string; name?: string; input?: Record<string, unknown> }> | undefined;
        if (event.type === "assistant" && contentBlocks && Array.isArray(contentBlocks)) {
          for (const block of contentBlocks) {
            if (block.type === "tool_use") {
              const toolName = block.name || "unknown";

              // Skip if we already emitted for this tool
              if (activeTools.has(toolName)) continue;
              activeTools.add(toolName);

              const displayName = TOOL_DISPLAY_NAMES[toolName] || `🔧 ${toolName}`;
              let details = "";

              // Extract useful details from input
              if (block.input) {
                if (toolName === "WebSearch" && block.input.query) {
                  details = `: "${block.input.query}"`;
                } else if (toolName === "Read" && block.input.file_path) {
                  const path = String(block.input.file_path);
                  details = `: ${path.split("/").pop()}`;
                } else if (toolName === "Bash" && block.input.command) {
                  const cmd = String(block.input.command).slice(0, 30);
                  details = `: ${cmd}${String(block.input.command).length > 30 ? "..." : ""}`;
                } else if (toolName === "Task" && block.input.description) {
                  details = `: ${block.input.description}`;
                } else if (toolName === "Grep" && block.input.pattern) {
                  details = `: "${block.input.pattern}"`;
                }
              }

              emitProgress({
                type: toolName === "Task" ? "subagent_start" : "tool_use",
                jobId: config.id,
                jobName: config.name,
                timestamp: new Date(),
                message: `${displayName}${details}`,
                details: { tool: toolName },
              });
            }
          }
        }

        // Tool result - clear from active set
        if (event.type === "tool_result" || event.type === "user") {
          // Reset active tools on tool results
          activeTools.clear();
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

      // Emit completed event
      emitProgress({
        type: "completed",
        jobId: config.id,
        jobName: config.name,
        timestamp: completedAt,
        message: success
          ? `✅ Completed: ${config.name} (${Math.round(duration / 1000)}s)`
          : `❌ Failed: ${config.name}`,
        details: { duration, success },
      });

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
