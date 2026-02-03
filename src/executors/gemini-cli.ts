import { spawn, ChildProcess } from "child_process";
import * as readline from "readline";
import type { ExecutorResult } from "./types.js";
import { logger } from "../utils/logger.js";

// ============================================
// TYPES
// ============================================

interface GeminiAccount {
  id: number;
  home: string;
  cooldownUntil: number;
  consecutiveFailures: number;
}

interface GeminiStreamEvent {
  type: "init" | "message" | "result" | "error";
  timestamp?: string;
  session_id?: string;
  model?: string;
  role?: "user" | "assistant";
  content?: string;
  delta?: boolean;
  status?: "success" | "error";
  message?: string;
  stats?: {
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    cached: number;
    duration_ms: number;
    tool_calls: number;
  };
}

export interface GeminiCLIOptions {
  model?: string;
  resume?: string;
  timeout?: number;
  yolo?: boolean;
  sandbox?: boolean;
  includeDirectories?: string[];
  accountId?: number; // Force specific account
  signal?: AbortSignal;
}

export interface GeminiCLIResult extends ExecutorResult {
  sessionId: string;
  model: string;
  accountId: number;
  stats?: GeminiStreamEvent["stats"];
}

// ============================================
// ACCOUNT ROTATION
// ============================================

// Account configuration - uses separate GEMINI_CLI_HOME directories
// GEMINI_CLI_HOME changes the "home" directory that Gemini CLI uses for .gemini/
const ACCOUNTS: GeminiAccount[] = [
  { id: 1, home: `${process.env.HOME}/.gemini-account1`, cooldownUntil: 0, consecutiveFailures: 0 },
  { id: 2, home: `${process.env.HOME}/.gemini-account2`, cooldownUntil: 0, consecutiveFailures: 0 },
  { id: 3, home: `${process.env.HOME}/.gemini-account3`, cooldownUntil: 0, consecutiveFailures: 0 },
];

let currentAccountIndex = 0;

function getNextAccount(): GeminiAccount | null {
  const now = Date.now();

  // Try each account starting from current index
  for (let i = 0; i < ACCOUNTS.length; i++) {
    const idx = (currentAccountIndex + i) % ACCOUNTS.length;
    const account = ACCOUNTS[idx];
    if (!account) continue;

    // Skip if in cooldown
    if (account.cooldownUntil > now) {
      logger.debug({ accountId: account.id, cooldownRemaining: account.cooldownUntil - now }, "Account in cooldown");
      continue;
    }

    // Skip if too many consecutive failures
    if (account.consecutiveFailures >= 5) {
      logger.debug({ accountId: account.id, failures: account.consecutiveFailures }, "Account disabled due to failures");
      continue;
    }

    currentAccountIndex = (idx + 1) % ACCOUNTS.length;
    return account;
  }

  return null; // All accounts exhausted
}

function getAccountById(id: number): GeminiAccount | null {
  return ACCOUNTS.find(a => a.id === id) ?? null;
}

function reportSuccess(account: GeminiAccount): void {
  account.consecutiveFailures = 0;
}

function reportQuotaError(account: GeminiAccount): void {
  // Set 1 hour cooldown on quota exhaustion
  account.cooldownUntil = Date.now() + 3600000;
  account.consecutiveFailures++;
  logger.warn({ accountId: account.id, cooldownUntil: new Date(account.cooldownUntil) }, "Account quota exhausted, setting cooldown");
}

function reportError(account: GeminiAccount): void {
  account.consecutiveFailures++;
  if (account.consecutiveFailures >= 3) {
    // Short cooldown on repeated errors
    account.cooldownUntil = Date.now() + 300000; // 5 min
  }
}

// ============================================
// QUOTA DETECTION
// ============================================

function isQuotaError(text: string): boolean {
  return /exhausted.*quota|quota.*reset|429|rate.limit|capacity.*exhausted/i.test(text);
}

function isAuthError(text: string): boolean {
  return /401|403|unauthorized|invalid.*credential|auth.*fail/i.test(text);
}

// ============================================
// MAIN EXECUTOR
// ============================================

export async function executeGeminiCLI(
  prompt: string,
  context: string = "",
  options: GeminiCLIOptions = {}
): Promise<GeminiCLIResult> {
  const {
    model = "gemini-3-flash-preview",
    resume,
    timeout = 1200000, // 20 minutes default
    yolo = false,
    sandbox = true,
    includeDirectories = [],
    accountId,
    signal,
  } = options;

  const startTime = Date.now();

  // Get account (specific or next available)
  const account = accountId ? getAccountById(accountId) : getNextAccount();

  if (!account) {
    logger.error("All Gemini CLI accounts exhausted");
    return {
      output: "Error: All Gemini CLI accounts exhausted",
      exitCode: 1,
      duration: Date.now() - startTime,
      executor: "gemini-cli",
      sessionId: "",
      model,
      accountId: 0,
    };
  }

  logger.debug({ accountId: account.id, model, promptLength: prompt.length, contextLength: context.length }, "Executing Gemini CLI");

  return new Promise((resolve) => {
    // Build arguments
    // When using stdin for context, we pass prompt via stdin too (context + prompt combined)
    // If no context, pass prompt as positional argument
    const args: string[] = context ? [] : [prompt];

    args.push("-m", model);
    args.push("--output-format", "stream-json");

    if (resume) {
      args.push("--resume", resume);
    }

    if (yolo) {
      args.push("--yolo");
    }

    if (sandbox) {
      args.push("--sandbox");
    }

    for (const dir of includeDirectories) {
      args.push("--include-directories", dir);
    }

    // Spawn process with account-specific GEMINI_CLI_HOME
    // This tells Gemini CLI to use a different "home" directory for its .gemini/ config
    const child: ChildProcess = spawn("gemini", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GEMINI_CLI_HOME: account.home,
      },
    });

    // State
    let sessionId = "";
    const responseChunks: string[] = [];
    let stats: GeminiStreamEvent["stats"] | undefined;
    let stderrOutput = "";
    let timedOut = false;
    let aborted = false;

    // Timeout handling
    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Hard kill after grace period
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeout);

    const abortHandler = () => {
      if (aborted) return;
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

    // Inject context + prompt via stdin when context is provided
    // Gemini CLI reads stdin and uses it as the prompt
    if (context) {
      // Combine context and prompt with clear separator
      const stdinContent = `${context}\n\n---\n\n${prompt}`;
      child.stdin?.write(stdinContent);
    }
    child.stdin?.end();

    // Parse streaming output (NDJSON)
    const rl = readline.createInterface({
      input: child.stdout!,
      terminal: false,
    });

    rl.on("line", (line: string) => {
      if (!line.trim()) return;

      try {
        const event: GeminiStreamEvent = JSON.parse(line);

        switch (event.type) {
          case "init":
            sessionId = event.session_id || "";
            logger.debug({ sessionId, model: event.model }, "Gemini session initialized");
            break;

          case "message":
            if (event.role === "assistant" && event.content) {
              responseChunks.push(event.content);
            }
            break;

          case "result":
            stats = event.stats;
            break;

          case "error":
            stderrOutput += (event.message || "") + "\n";
            break;
        }
      } catch {
        // Skip non-JSON lines (deprecation warnings, etc.)
      }
    });

    // Capture stderr
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      // Filter out Node.js deprecation warnings
      if (!text.includes("DeprecationWarning")) {
        stderrOutput += text;
      }
    });

    // Handle completion
    child.on("close", (code: number | null) => {
      clearTimeout(timeoutId);
      const duration = Date.now() - startTime;
      const output = responseChunks.join("");

      // Check for quota/auth errors
      const allOutput = output + stderrOutput;

      if (aborted) {
        resolve({
          output: "Cancelled",
          exitCode: 130,
          duration,
          executor: "gemini-cli",
          sessionId,
          model,
          accountId: account.id,
          stats,
        });
        return;
      }

      if (isQuotaError(allOutput)) {
        reportQuotaError(account);
        resolve({
          output: `Quota exhausted on account ${account.id}: ${stderrOutput}`,
          exitCode: 2, // Special code for quota
          duration,
          executor: "gemini-cli",
          sessionId,
          model,
          accountId: account.id,
          stats,
        });
        return;
      }

      if (isAuthError(allOutput)) {
        reportError(account);
        resolve({
          output: `Auth error on account ${account.id}: ${stderrOutput}`,
          exitCode: 3, // Special code for auth
          duration,
          executor: "gemini-cli",
          sessionId,
          model,
          accountId: account.id,
          stats,
        });
        return;
      }

      if (timedOut) {
        reportError(account);
        resolve({
          output: `Timeout after ${timeout}ms`,
          exitCode: 4, // Special code for timeout
          duration,
          executor: "gemini-cli",
          sessionId,
          model,
          accountId: account.id,
          stats,
        });
        return;
      }

      if (code !== 0 && code !== null) {
        reportError(account);
        resolve({
          output: stderrOutput || `Gemini CLI exited with code ${code}`,
          exitCode: code,
          duration,
          executor: "gemini-cli",
          sessionId,
          model,
          accountId: account.id,
          stats,
        });
        return;
      }

      // Success
      reportSuccess(account);
      logger.debug(
        { accountId: account.id, sessionId, duration, tokens: stats?.total_tokens },
        "Gemini CLI completed successfully"
      );

      resolve({
        output,
        exitCode: 0,
        duration,
        executor: "gemini-cli",
        sessionId,
        model,
        accountId: account.id,
        stats,
      });
    });

    child.on("error", (err: Error) => {
      clearTimeout(timeoutId);
      reportError(account);

      resolve({
        output: `Spawn error: ${err.message}`,
        exitCode: 1,
        duration: Date.now() - startTime,
        executor: "gemini-cli",
        sessionId: "",
        model,
        accountId: account.id,
      });
    });
  });
}

// ============================================
// CLI-FIRST WITH API FALLBACK
// ============================================

// Import will be added when gemini.ts is created
// import { executeGeminiAPI } from "./gemini.js";

export async function executeGeminiWithFallback(
  prompt: string,
  context: string = "",
  options: GeminiCLIOptions = {}
): Promise<GeminiCLIResult> {
  // Try CLI first with all available accounts
  for (let attempt = 0; attempt < ACCOUNTS.length; attempt++) {
    const result = await executeGeminiCLI(prompt, context, options);

    // Success or non-quota error - return
    if (result.exitCode === 0 || (result.exitCode !== 2 && result.exitCode !== 3)) {
      return result;
    }

    // Quota or auth error - try next account
    logger.info({ accountId: result.accountId, exitCode: result.exitCode }, "Trying next Gemini account");
  }

  // All CLI accounts failed - fallback to API
  logger.warn("All Gemini CLI accounts exhausted, falling back to API");

  // TODO: Import and call executeGeminiAPI when created
  // return executeGeminiAPI(prompt, context, options);

  return {
    output: "Error: All Gemini CLI accounts exhausted and API fallback not yet implemented",
    exitCode: 1,
    duration: 0,
    executor: "gemini-cli",
    sessionId: "",
    model: options.model || "gemini-3-flash-preview",
    accountId: 0,
  };
}

// ============================================
// STREAMING VERSION (for progress updates)
// ============================================

export async function* streamGeminiCLI(
  prompt: string,
  context: string = "",
  options: GeminiCLIOptions = {}
): AsyncGenerator<GeminiStreamEvent> {
  const {
    model = "gemini-3-flash-preview",
    resume,
    yolo = false,
    sandbox = true,
    includeDirectories = [],
    accountId,
  } = options;

  const account = accountId ? getAccountById(accountId) : getNextAccount();
  if (!account) {
    yield { type: "error", message: "All Gemini CLI accounts exhausted" };
    return;
  }

  const args: string[] = [prompt, "-m", model, "--output-format", "stream-json"];
  if (resume) args.push("--resume", resume);
  if (yolo) args.push("--yolo");
  if (sandbox) args.push("--sandbox");
  for (const dir of includeDirectories) {
    args.push("--include-directories", dir);
  }

  const child = spawn("gemini", args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GEMINI_CLI_HOME: account.home },
  });

  if (context) {
    child.stdin?.write(context);
  }
  child.stdin?.end();

  const rl = readline.createInterface({
    input: child.stdout!,
    terminal: false,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as GeminiStreamEvent;
    } catch {
      // Skip non-JSON lines
    }
  }
}

// ============================================
// ACCOUNT STATUS (for debugging/monitoring)
// ============================================

export function getAccountStatus(): Array<{
  id: number;
  available: boolean;
  cooldownRemaining: number;
  consecutiveFailures: number;
}> {
  const now = Date.now();
  return ACCOUNTS.map(account => ({
    id: account.id,
    available: account.cooldownUntil <= now && account.consecutiveFailures < 5,
    cooldownRemaining: Math.max(0, account.cooldownUntil - now),
    consecutiveFailures: account.consecutiveFailures,
  }));
}

export function resetAccountCooldowns(): void {
  for (const account of ACCOUNTS) {
    account.cooldownUntil = 0;
    account.consecutiveFailures = 0;
  }
  logger.info("All Gemini CLI account cooldowns reset");
}
