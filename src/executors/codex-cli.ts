import { spawn } from "child_process";
import type { ExecutorResult } from "./types.js";
import { logger } from "../utils/logger.js";

const DEFAULT_TIMEOUT = 1200_000; // 20 minutes
const KILL_GRACE_MS = 5_000;

export interface CodexCLIOptions {
  cwd: string;
  timeout?: number;
  signal?: AbortSignal;
}

export interface CodexCLIResult extends ExecutorResult {}

/**
 * Execute Codex CLI with a full prompt.
 * Command: codex --dangerously-bypass-approvals-and-sandbox <prompt>
 */
export async function executeCodexCLI(
  prompt: string,
  options: CodexCLIOptions
): Promise<CodexCLIResult> {
  const startTime = Date.now();
  const { cwd, timeout = DEFAULT_TIMEOUT, signal } = options;

  return new Promise((resolve, reject) => {
    const args = ["--dangerously-bypass-approvals-and-sandbox", prompt];

    const child = spawn("codex", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CI: process.env.CI ?? "1",
        TERM: process.env.TERM ?? "dumb",
        NO_COLOR: process.env.NO_COLOR ?? "1",
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",
      },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const finalize = (exitCode: number, output: string) => {
      if (settled) return;
      settled = true;
      resolve({
        output,
        exitCode,
        duration: Date.now() - startTime,
        executor: "codex",
      });
    };

    const killProcess = () => {
      if (child.exitCode == null && child.signalCode == null) {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
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
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("close", (code) => {
      clearTimeout(timeoutId);

      if (aborted) {
        finalize(130, "Cancelled");
        return;
      }

      if (timedOut) {
        finalize(124, "Timeout");
        return;
      }

      const output = stdout.trim() || stderr.trim() || "(No output)";
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
