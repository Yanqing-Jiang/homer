import { spawn, ChildProcess } from "child_process";
import type { ExecutorResult } from "./types.js";
import { logger } from "../utils/logger.js";
import { processRegistry } from "../process/registry.js";

// ============================================
// TYPES
// ============================================

export interface KimiCLIOptions {
  model?: string;
  timeout?: number;
  yolo?: boolean;
  workDir?: string;
  signal?: AbortSignal;
}

export interface KimiCLIResult extends ExecutorResult {
  model: string;
}

// ============================================
// MAIN EXECUTOR
// ============================================

const KIMI_PATH = process.env.KIMI_PATH ?? "/opt/homebrew/bin/kimi";
const DEFAULT_TIMEOUT = 1200000; // 20 minutes

// Env vars that conflict with Kimi CLI
const ENV_BLOCKLIST = ["OPENAI_API_KEY", "CI"];

export async function executeKimiCLI(
  prompt: string,
  context: string = "",
  options: KimiCLIOptions = {}
): Promise<KimiCLIResult> {
  const {
    model,
    timeout = DEFAULT_TIMEOUT,
    yolo = true,
    workDir,
    signal,
  } = options;

  const resolvedModel = model ?? "moonshot-ai/kimi-k2.5";
  const startTime = Date.now();

  logger.debug(
    { model: resolvedModel, promptLength: prompt.length, contextLength: context.length },
    "Executing Kimi CLI"
  );

  return new Promise((resolve) => {
    const args: string[] = [];

    // Model (omit to use config default: moonshot-ai/kimi-k2.5)
    if (model) {
      args.push("-m", model);
    }

    // Thinking mode — always enable explicitly
    args.push("--thinking");

    // Auto-approve actions
    if (yolo) {
      args.push("--yolo");
    }

    // Quiet mode: --print --output-format text --final-message-only
    args.push("--quiet");

    // Working directory
    if (workDir) {
      args.push("-w", workDir);
    }

    // Combine context and prompt
    const fullPrompt = context
      ? `Context:\n${context}\n\n---\n\nTask:\n${prompt}`
      : prompt;

    args.push("-p", fullPrompt);

    // Clean env to prevent conflicts
    const cleanEnv = { ...process.env };
    for (const key of ENV_BLOCKLIST) {
      delete cleanEnv[key];
    }

    const child: ChildProcess = spawn(KIMI_PATH, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: cleanEnv,
    });

    // Register with process lifecycle management
    processRegistry.register(child, {
      command: "kimi",
      type: "executor",
      timeoutMs: timeout,
      source: "cli-runner",
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    // Timeout: SIGTERM then SIGKILL after grace period
    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeout);

    // AbortSignal support
    const abortHandler = () => {
      aborted = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    };
    if (signal) {
      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    child.stdin?.end();

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (child.pid) processRegistry.touch(child.pid);
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (!chunk.includes("DeprecationWarning")) {
          stderr += chunk;
        }
      });
    }

    child.on("close", (code: number | null) => {
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener("abort", abortHandler);
      const duration = Date.now() - startTime;
      const output = stdout.trim();

      if (aborted) {
        resolve({
          output: output || "Aborted by signal",
          exitCode: 5,
          duration,
          executor: "kimi-cli",
          model: resolvedModel,
        });
        return;
      }

      if (timedOut) {
        resolve({
          output: `Timeout after ${timeout}ms`,
          exitCode: 4,
          duration,
          executor: "kimi-cli",
          model: resolvedModel,
        });
        return;
      }

      if (code !== 0 && code !== null) {
        logger.warn(
          { code, stderr: stderr.slice(0, 500) },
          "Kimi CLI exited with non-zero code"
        );
        resolve({
          output: stderr || `Kimi CLI exited with code ${code}`,
          exitCode: code,
          duration,
          executor: "kimi-cli",
          model: resolvedModel,
        });
        return;
      }

      logger.debug(
        { duration, outputLength: output.length },
        "Kimi CLI completed successfully"
      );

      resolve({
        output: output || "(No output)",
        exitCode: 0,
        duration,
        executor: "kimi-cli",
        model: resolvedModel,
      });
    });

    child.on("error", (err: Error) => {
      clearTimeout(timeoutId);
      resolve({
        output: `Spawn error: ${err.message}`,
        exitCode: 1,
        duration: Date.now() - startTime,
        executor: "kimi-cli",
        model: resolvedModel,
      });
    });
  });
}
