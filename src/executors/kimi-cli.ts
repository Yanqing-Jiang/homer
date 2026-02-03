import { spawn, ChildProcess } from "child_process";
import type { ExecutorResult } from "./types.js";
import { logger } from "../utils/logger.js";

// ============================================
// TYPES
// ============================================

export interface KimiCLIOptions {
  model?: string;
  timeout?: number;
  yolo?: boolean;
  workDir?: string;
}

export interface KimiCLIResult extends ExecutorResult {
  model: string;
}

// ============================================
// MAIN EXECUTOR
// ============================================

const KIMI_PATH = process.env.KIMI_PATH ?? "/opt/homebrew/bin/kimi";
const DEFAULT_TIMEOUT = 1200000; // 20 minutes

export async function executeKimiCLI(
  prompt: string,
  context: string = "",
  options: KimiCLIOptions = {}
): Promise<KimiCLIResult> {
  const {
    model = "k2", // Default to k2 model
    timeout = DEFAULT_TIMEOUT,
    yolo = true,
    workDir,
  } = options;

  const startTime = Date.now();

  logger.debug(
    { model, promptLength: prompt.length, contextLength: context.length },
    "Executing Kimi CLI"
  );

  return new Promise((resolve) => {
    // Build arguments
    const args: string[] = [];

    // Model
    args.push("-m", model);

    // Auto-approve actions
    if (yolo) {
      args.push("--yolo");
    }

    // Working directory
    if (workDir) {
      args.push("-w", workDir);
    }

    // Combine context and prompt
    const fullPrompt = context
      ? `Context:\n${context}\n\n---\n\nTask:\n${prompt}`
      : prompt;

    // Pass prompt via -p flag
    args.push("-p", fullPrompt);

    // Spawn process
    const child: ChildProcess = spawn(KIMI_PATH, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CI: "1",
        TERM: "dumb",
        NO_COLOR: "1",
      },
    });

    // State
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Timeout handling
    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Hard kill after grace period
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeout);

    // Close stdin
    child.stdin?.end();

    // Capture stdout
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
    }

    // Capture stderr
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        // Filter out deprecation warnings
        if (!chunk.includes("DeprecationWarning")) {
          stderr += chunk;
        }
      });
    }

    // Handle completion
    child.on("close", (code: number | null) => {
      clearTimeout(timeoutId);
      const duration = Date.now() - startTime;
      const output = stdout.trim();

      if (timedOut) {
        resolve({
          output: `Timeout after ${timeout}ms`,
          exitCode: 4,
          duration,
          executor: "kimi-cli",
          model,
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
          model,
        });
        return;
      }

      // Success
      logger.debug(
        { duration, outputLength: output.length },
        "Kimi CLI completed successfully"
      );

      resolve({
        output: output || "(No output)",
        exitCode: 0,
        duration,
        executor: "kimi-cli",
        model,
      });
    });

    child.on("error", (err: Error) => {
      clearTimeout(timeoutId);

      resolve({
        output: `Spawn error: ${err.message}`,
        exitCode: 1,
        duration: Date.now() - startTime,
        executor: "kimi-cli",
        model,
      });
    });
  });
}
