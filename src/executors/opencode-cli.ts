import { spawn, ChildProcess } from "child_process";
import { mkdirSync } from "fs";
import * as readline from "readline";
import type { ExecutorResult } from "./types.js";
import { logger } from "../utils/logger.js";
import { executeKimiCLI } from "./kimi-cli.js";
import { executeClaudeCommand } from "./claude.js";
import { executeGeminiCLIDirect, GEMINI_CLI_FLASH_MODEL } from "./gemini-cli.js";
import { processRegistry } from "../process/registry.js";

// ============================================
// TYPES
// ============================================

interface OpenCodeStreamEvent {
  type: "step_start" | "text" | "tool_use" | "tool_result" | "step_finish" | "error";
  timestamp?: number;
  sessionID?: string;
  part?: {
    id?: string;
    sessionID?: string;
    messageID?: string;
    type?: string;
    text?: string;
    name?: string;
    input?: Record<string, unknown>;
    output?: string;
    reason?: string;
    cost?: number;
    tokens?: {
      input: number;
      output: number;
      reasoning?: number;
      cache?: { read: number; write: number };
    };
    error?: string;
    time?: { start: number; end: number };
  };
}

export interface OpenCodeCLIOptions {
  model?: string;
  timeout?: number;
  signal?: AbortSignal;
  researchOnly?: boolean;
  browserOnly?: boolean;
  cwd?: string;
  /** OpenCode agent mode: "build" (default) or "plan" */
  agent?: string;
  /** Called with cumulative text as response streams in */
  onPartial?: (text: string) => void;
  // Legacy options accepted for backward compatibility (ignored by OpenCode)
  resume?: string;
  yolo?: boolean;
  sandbox?: boolean;
  includeDirectories?: string[];
  accountId?: number;
  /** Skip flash→Gemini CLI routing and use OpenCode directly */
  forceOpenCode?: boolean;
}

export interface OpenCodeCLIResult extends ExecutorResult {
  sessionId: string;
  model: string;
  accountId: number;
  stats?: {
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    cached: number;
    duration_ms: number;
    tool_calls: number;
  };
}

// Backward-compatible aliases
export type GeminiCLIOptions = OpenCodeCLIOptions;
export type GeminiCLIResult = OpenCodeCLIResult;

// ============================================
// QUOTA DETECTION
// ============================================

export function isQuotaError(text: string): boolean {
  return /exhausted.*quota|quota.*reset|\b429\b.*rate|rate.limit|capacity.*exhausted/i.test(text);
}

export function isAuthError(text: string): boolean {
  return /\b401\b.*error|\b403\b.*forbidden|unauthorized|invalid.*credential|auth.*fail/i.test(text);
}

// ============================================
// RESEARCH-ONLY PROMPT INJECTION
// ============================================

/** @deprecated Use role-based agent files for Gemini CLI */
export const RESEARCH_ONLY_PREFIX = `CRITICAL CONSTRAINTS - You MUST follow these rules:

ALLOWED:
- READ any files for context and analysis
- CREATE or UPDATE .md (markdown) files for reports, ideas, summaries, digests
- CREATE or UPDATE .json files in ~/memory/ for data storage
- Use MCP tools for memory operations (memory_append, memory_promote, idea_add)
- Web searches and API calls for research

PROHIBITED:
- DO NOT modify source code files: .ts, .js, .py, .tsx, .jsx, .go, .rs, .java, .c, .cpp, .h, .swift, .kt, .rb, .php, .vue, .svelte
- DO NOT use Edit or Write tools on code files
- DO NOT create new code files
- If code changes are needed, DESCRIBE them in a markdown file instead of implementing them

Focus on research, analysis, information extraction, and documentation.

Now proceed with the task:

`;

/** @deprecated Use role-based agent files for Gemini CLI */
export const BROWSER_ONLY_PREFIX = `CRITICAL CONSTRAINTS:

ALLOWED:
- Run agent-browser commands via bash (connect, snapshot, open, click, scroll)
- Return data as text/JSON in your response

PROHIBITED:
- DO NOT create, write, or modify any files on disk
- DO NOT use bash commands that create files (no >, >>, tee, touch, mkdir, cp, mv, curl -o, wget)
- DO NOT save screenshots unless explicitly asked
- ALL output must be in your response text, not written to files

Now proceed:

`;

// ============================================
// MAIN EXECUTOR
// ============================================

export async function executeOpenCodeCLI(
  prompt: string,
  context: string = "",
  options: OpenCodeCLIOptions = {}
): Promise<OpenCodeCLIResult> {
  const {
    model: rawModel = `google/${GEMINI_CLI_FLASH_MODEL}`,
    timeout = 1200000, // 20 minutes default
    signal,
    researchOnly = true,
    browserOnly = false,
    cwd,
    agent,
  } = options;

  // Normalize model name: callers may pass "gemini-3-flash-preview" without provider prefix
  const model = rawModel.includes("/") ? rawModel : `google/${rawModel}`;

  // Route Google/Flash/Pro models to Gemini CLI (OpenCode Google account ToS-blocked)
  if (model.includes("flash") || model.includes("pro") || model.startsWith("google/") || model.startsWith("google-aistudio/")) {
    const geminiModel = model.replace(/^google(-aistudio)?\//, "");
    const geminiRole = "research" as const;
    const effectivePrompt = context ? `${context}\n\n---\n\n${prompt}` : prompt;
    const result = await executeGeminiCLIDirect(effectivePrompt, {
      model: geminiModel,
      timeout,
      signal,
      cwd: cwd || (browserOnly ? "/tmp/homer-scrape" : process.env.HOME || "/Users/yj"),
      role: geminiRole,
    });
    return {
      output: result.output,
      exitCode: result.exitCode,
      duration: result.duration,
      executor: "gemini-cli",
      sessionId: "",
      model: geminiModel,
      accountId: 0,
    } as OpenCodeCLIResult;
  }

  const prefix = browserOnly ? BROWSER_ONLY_PREFIX : researchOnly ? RESEARCH_ONLY_PREFIX : "";
  const effectivePrompt = prefix + prompt;
  const startTime = Date.now();

  logger.debug({ model, promptLength: effectivePrompt.length, contextLength: context.length, researchOnly }, "Executing OpenCode CLI");

  return new Promise((resolve) => {
    // Build the full message: context + prompt combined via stdin if context exists
    const fullMessage = context
      ? `${context}\n\n---\n\n${effectivePrompt}`
      : effectivePrompt;

    const args: string[] = [
      "run",
      fullMessage,
      "-m", model,
      "--format", "json",
      ...(agent ? ["--agent", agent] : []),
    ];

    // Sandbox browserOnly agents to /tmp to prevent file writes to home directory
    const effectiveCwd = cwd || (browserOnly ? "/tmp/homer-scrape" : (process.env.HOME || "/Users/yj"));
    if (browserOnly) mkdirSync(effectiveCwd, { recursive: true });

    const child: ChildProcess = spawn("opencode", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: effectiveCwd,
      detached: true, // own process group so SIGTERM kills all children
    });

    // Register with process lifecycle management
    processRegistry.register(child, {
      command: "opencode",
      type: "executor",
      timeoutMs: timeout,
      source: "cli-runner",
      detached: true,
    });

    // State
    let sessionId = "";
    const responseChunks: string[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCached = 0;
    let toolCallCount = 0;
    let stderrOutput = "";
    let timedOut = false;
    let aborted = false;

    /** Build metrics from accumulated token counts (available on all exit paths) */
    const buildMetrics = () => ({
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cachedTokens: totalCached,
      toolCalls: toolCallCount,
    });

    // Kill the entire process group (including opencode's child processes)
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        child.kill(signal); // fallback if process group kill fails
      }
    };

    // Timeout handling
    const timeoutId = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 5000);
    }, timeout);

    const abortHandler = () => {
      if (aborted) return;
      aborted = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 5000);
    };

    if (signal) {
      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    child.stdin?.end();

    // Parse streaming NDJSON output
    const rl = readline.createInterface({
      input: child.stdout!,
      terminal: false,
    });

    rl.on("line", (line: string) => {
      if (!line.trim()) return;
      if (child.pid) processRegistry.touch(child.pid);

      try {
        const event: OpenCodeStreamEvent = JSON.parse(line);

        switch (event.type) {
          case "step_start":
            if (event.sessionID && !sessionId) {
              sessionId = event.sessionID;
              logger.debug({ sessionId }, "OpenCode session initialized");
            }
            break;

          case "text":
            if (event.part?.text) {
              responseChunks.push(event.part.text);
              if (options.onPartial) {
                try { options.onPartial(responseChunks.join("")); } catch { /* don't crash executor */ }
              }
            }
            break;

          case "tool_use":
            toolCallCount++;
            break;

          case "tool_result":
            // Capture tool outputs so browser scraping results appear in final output
            if (event.part?.output) {
              responseChunks.push(event.part.output);
            }
            break;

          case "step_finish":
            if (event.part?.tokens) {
              totalInputTokens += event.part.tokens.input;
              totalOutputTokens += event.part.tokens.output;
              totalCached += event.part.tokens.cache?.read ?? 0;
            }
            break;

          case "error":
            stderrOutput += (event.part?.error || "") + "\n";
            break;
        }
      } catch {
        // Skip non-JSON lines
      }
    });

    // Capture stderr
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      if (!text.includes("DeprecationWarning") && !text.includes("ExperimentalWarning")) {
        stderrOutput += text;
      }
    });

    // Handle completion
    child.on("close", (code: number | null) => {
      clearTimeout(timeoutId);
      const duration = Date.now() - startTime;
      const output = responseChunks.join("");

      const allOutput = output + stderrOutput;

      if (aborted) {
        resolve({
          output: "Cancelled",
          exitCode: 130,
          duration,
          executor: "opencode",
          sessionId,
          model,
          accountId: 1,
          stats: {
            total_tokens: totalInputTokens + totalOutputTokens,
            input_tokens: totalInputTokens,
            output_tokens: totalOutputTokens,
            cached: totalCached,
            duration_ms: duration,
            tool_calls: toolCallCount,
          },
        });
        return;
      }

      if (isQuotaError(allOutput)) {
        resolve({
          output: `Quota exhausted: ${stderrOutput}`,
          exitCode: 2,
          duration,
          executor: "opencode",
          sessionId,
          model,
          accountId: 1,
          metrics: buildMetrics(),
        });
        return;
      }

      if (isAuthError(allOutput)) {
        resolve({
          output: `Auth error: ${stderrOutput}`,
          exitCode: 3,
          duration,
          executor: "opencode",
          sessionId,
          model,
          accountId: 1,
          metrics: buildMetrics(),
        });
        return;
      }

      if (timedOut) {
        resolve({
          output: `Timeout after ${timeout}ms`,
          exitCode: 4,
          duration,
          executor: "opencode",
          sessionId,
          model,
          accountId: 1,
          metrics: buildMetrics(),
        });
        return;
      }

      if (code !== 0 || code === null) {
        resolve({
          output: stderrOutput || `OpenCode CLI exited with code ${code ?? "null (signal kill)"}`,
          exitCode: code ?? 1,
          duration,
          executor: "opencode",
          sessionId,
          model,
          accountId: 1,
          metrics: buildMetrics(),
        });
        return;
      }

      // Success
      logger.debug(
        { sessionId, duration, inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        "OpenCode CLI completed successfully"
      );

      if (!output.trim()) {
        logger.warn("OpenCode CLI returned empty output despite exit code 0. Treating as quota/auth error.");
        resolve({
          output: "Empty output (possible silent auth failure)",
          exitCode: 2, // Map to quota error to trigger fallback/rotation
          duration,
          executor: "opencode",
          sessionId,
          model,
          accountId: 1,
          metrics: buildMetrics(),
        });
        return;
      }

      resolve({
        output,
        exitCode: 0,
        duration,
        executor: "opencode",
        sessionId,
        model,
        accountId: 1,
        metrics: buildMetrics(),
        stats: {
          total_tokens: totalInputTokens + totalOutputTokens,
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          cached: totalCached,
          duration_ms: duration,
          tool_calls: toolCallCount,
        },
      });
    });

    child.on("error", (err: Error) => {
      clearTimeout(timeoutId);
      resolve({
        output: `Spawn error: ${err.message}`,
        exitCode: 1,
        duration: Date.now() - startTime,
        executor: "opencode",
        sessionId: "",
        model,
        accountId: 1,
        metrics: buildMetrics(),
      });
    });
  });
}

// ============================================
// WITH RETRY + FALLBACK CHAIN
// ============================================

export async function executeOpenCodeWithFallback(
  prompt: string,
  context: string = "",
  options: OpenCodeCLIOptions = {}
): Promise<OpenCodeCLIResult> {
  const result = await executeOpenCodeCLI(prompt, context, options);

  if (result.exitCode === 0 || (result.exitCode !== 2 && result.exitCode !== 3)) {
    return result;
  }

  // Tier 1 fallback: quota/auth error — retry (Antigravity plugin handles account rotation internally)
  logger.info({ exitCode: result.exitCode }, "OpenCode quota/auth error, retrying");
  const retryResult = await executeOpenCodeCLI(prompt, context, options);
  if (retryResult.exitCode === 0) return retryResult;

  // Tier 2 fallback: all Flash/Google accounts exhausted — try Sonnet via Claude Code CLI
  if (retryResult.exitCode === 2 || retryResult.exitCode === 3) {
    logger.info("All Flash/Google accounts exhausted, falling back to Sonnet (Claude Code)");
    try {
      const fullPrompt = context ? `${context}\n\n---\n\n${prompt}` : prompt;
      const sonnetResult = await executeClaudeCommand(fullPrompt, {
        cwd: options.cwd ?? process.env.HOME ?? "/Users/yj",
        model: "sonnet",
        timeout: options.timeout,
        signal: options.signal,
      });
      if (sonnetResult.exitCode === 0) {
        return {
          output: sonnetResult.output,
          exitCode: 0,
          duration: sonnetResult.duration,
          executor: "claude",
          sessionId: sonnetResult.claudeSessionId ?? "",
          model: "claude-sonnet-4-6",
          accountId: 0,
        } as OpenCodeCLIResult;
      }
    } catch (err) {
      logger.warn({ err }, "Sonnet (Claude Code) fallback failed");
    }

    // Tier 3 emergency fallback: Kimi K2.5 (independent auth, native web tools)
    logger.warn("Sonnet fallback also failed, using Kimi K2.5 emergency fallback");
    const fullPrompt = context ? `${context}\n\n---\n\n${prompt}` : prompt;
    const kimiResult = await executeKimiCLI(fullPrompt, "", {
      timeout: options.timeout,
      signal: options.signal,
    });
    return {
      output: kimiResult.output,
      exitCode: kimiResult.exitCode,
      duration: kimiResult.duration,
      executor: "kimi-cli",
      sessionId: "",
      model: "moonshot-ai/kimi-k2.5",
      accountId: 0,
    } as OpenCodeCLIResult;
  }

  return retryResult;
}

// ============================================
// STREAMING VERSION
// ============================================

export async function* streamOpenCodeCLI(
  prompt: string,
  context: string = "",
  options: OpenCodeCLIOptions = {}
): AsyncGenerator<OpenCodeStreamEvent> {
  const {
    model = `google-aistudio/${GEMINI_CLI_FLASH_MODEL}`,
    cwd,
  } = options;

  const fullMessage = context
    ? `${context}\n\n---\n\n${prompt}`
    : prompt;

  const args: string[] = [
    "run",
    fullMessage,
    "-m", model,
    "--format", "json",
  ];

  const child = spawn("opencode", args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: cwd || process.env.HOME || "/Users/yj",
    env: { ...process.env },
  });

  // Register with process lifecycle management
  processRegistry.register(child, {
    command: "opencode",
    type: "executor",
    timeoutMs: 20 * 60 * 1000,
    source: "cli-runner",
  });

  child.stdin?.end();

  const rl = readline.createInterface({
    input: child.stdout!,
    terminal: false,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as OpenCodeStreamEvent;
    } catch {
      // Skip non-JSON lines
    }
  }
}

// ============================================
// ACCOUNT STATUS (simplified - OpenCode manages internally)
// ============================================

export function getAccountStatus(): Array<{
  id: number;
  available: boolean;
  cooldownRemaining: number;
  consecutiveFailures: number;
}> {
  // OpenCode manages auth rotation internally via the plugin.
  // Return a single "always available" account for compatibility.
  return [
    { id: 1, available: true, cooldownRemaining: 0, consecutiveFailures: 0 },
  ];
}

export function resetAccountCooldowns(): void {
  logger.info("OpenCode CLI manages account rotation internally - no cooldowns to reset");
}

