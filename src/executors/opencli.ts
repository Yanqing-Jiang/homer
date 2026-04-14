/**
 * OpenCLI Executor — wraps the opencli CLI binary.
 *
 * opencli converts websites to CLI commands via pre-built adapters
 * + Chrome Extension bridge. Zero LLM cost, ~2s execution, structured JSON.
 *
 * Primary scraping executor. Falls back to executeBrowserScrape() on infra errors.
 */

import { spawn } from "child_process";
import { logger } from "../utils/logger.js";

// ============================================
// TYPES
// ============================================

export interface OpenCLIOptions {
  timeout?: number;
  signal?: AbortSignal;
  format?: "json" | "table" | "md" | "csv" | "yaml";
}

export interface OpenCLIResult<T = unknown> {
  data: T | null;
  rawOutput: string;
  exitCode: number;
  duration: number;
  needsExtension: boolean;
  needsAuth: boolean;
  error?: string;
}

// Exit codes from opencli source
const EXIT_EMPTY = 66;
const EXIT_SERVICE_UNAVAIL = 69;
const EXIT_TIMEOUT = 75;
const EXIT_AUTH_REQUIRED = 77;
const EXIT_CONFIG = 78;

const OPENCLI_BIN = "opencli";
const DEFAULT_TIMEOUT = 30_000;

// Per-platform timeouts (ms) — Twitter bookmark scroll takes longer
const TWITTER_BOOKMARKS_TIMEOUT = 60_000;
const TWITTER_ARTICLE_TIMEOUT = 45_000;
const LINKEDIN_TIMEOUT = 45_000;
const MEDIUM_TIMEOUT = 30_000;

/** Returns true if the exit code means "infra down, try browser fallback" */
export function isRetryableOpenCLIError(exitCode: number): boolean {
  return exitCode === EXIT_SERVICE_UNAVAIL || exitCode === EXIT_TIMEOUT;
}

// ============================================
// CORE EXECUTOR
// ============================================

export async function executeOpenCLI<T = unknown>(
  args: string[],
  options: OpenCLIOptions = {},
): Promise<OpenCLIResult<T>> {
  const { timeout = DEFAULT_TIMEOUT, signal, format = "json" } = options;
  const startTime = Date.now();
  const fullArgs = [...args, "-f", format];

  logger.debug({ args: fullArgs }, "Executing opencli");

  return new Promise((resolve) => {
    const child = spawn(OPENCLI_BIN, fullArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000);
    }, timeout);

    if (signal) {
      const abort = () => child.kill("SIGTERM");
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }

    child.stdin?.end();
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code: number | null) => {
      clearTimeout(timeoutId);
      const duration = Date.now() - startTime;
      const exitCode = code ?? 1;

      if (timedOut) {
        resolve({ data: null, rawOutput: stdout, exitCode: EXIT_TIMEOUT, duration, needsExtension: false, needsAuth: false, error: `Timeout after ${timeout}ms` });
        return;
      }

      const needsExtension = exitCode === EXIT_SERVICE_UNAVAIL;
      const needsAuth = exitCode === EXIT_AUTH_REQUIRED;

      if (exitCode !== 0) {
        const error = needsExtension ? "Chrome extension not connected"
          : needsAuth ? "Auth required (cookies missing)"
          : exitCode === EXIT_EMPTY ? "Empty result"
          : exitCode === EXIT_CONFIG ? "Config error"
          : stderr.trim() || `Exit code ${exitCode}`;
        logger.warn({ exitCode, error, args }, "opencli failed");
        resolve({ data: null, rawOutput: stdout, exitCode, duration, needsExtension, needsAuth, error });
        return;
      }

      let data: T | null = null;
      try {
        const trimmed = stdout.trim();
        if (trimmed) data = JSON.parse(trimmed) as T;
      } catch {
        logger.warn({ outputLen: stdout.length }, "opencli returned non-JSON output");
      }

      logger.debug({ duration, items: Array.isArray(data) ? data.length : 1 }, "opencli OK");
      resolve({ data, rawOutput: stdout, exitCode: 0, duration, needsExtension: false, needsAuth: false });
    });

    child.on("error", (err: Error) => {
      clearTimeout(timeoutId);
      resolve({ data: null, rawOutput: "", exitCode: 1, duration: Date.now() - startTime, needsExtension: false, needsAuth: false, error: `Spawn error: ${err.message}` });
    });
  });
}

// ============================================
// HEALTH CHECK
// ============================================

export async function isOpenCLIHealthy(): Promise<boolean> {
  const result = await executeOpenCLI(["doctor"], { timeout: 10_000 });
  return result.rawOutput.includes("[OK] Daemon") && result.rawOutput.includes("[OK] Extension");
}

// ============================================
// TYPED PLATFORM METHODS
// ============================================

// ---- Twitter ----

export interface OpenCLIBookmark {
  id: string;
  author: string;
  name?: string;
  text: string;
  likes: number;
  retweets?: number;
  created_at?: string;
  url: string;
}

export interface OpenCLIArticle {
  author: string;
  content: string;
  title?: string;
  url: string;
}

export async function fetchTwitterBookmarks(limit = 20, options?: OpenCLIOptions): Promise<OpenCLIResult<OpenCLIBookmark[]>> {
  return executeOpenCLI<OpenCLIBookmark[]>(["twitter", "bookmarks", "--limit", String(limit)], { timeout: TWITTER_BOOKMARKS_TIMEOUT, ...options });
}

export async function fetchTwitterArticle(tweetId: string, options?: OpenCLIOptions): Promise<OpenCLIResult<OpenCLIArticle>> {
  // opencli returns [{...}] (array of one) — unwrap to single article
  const result = await executeOpenCLI<OpenCLIArticle | OpenCLIArticle[]>(
    ["twitter", "article", tweetId],
    { timeout: TWITTER_ARTICLE_TIMEOUT, ...options },
  );
  if (result.data && Array.isArray(result.data)) {
    return { ...result, data: result.data[0] ?? null };
  }
  return result as OpenCLIResult<OpenCLIArticle>;
}

export interface OpenCLIThreadTweet {
  id: string;
  author: string;
  text: string;
  likes?: number;
  retweets?: number;
  in_reply_to?: string;
  created_at?: string;
  url?: string;
}

export async function fetchTwitterThread(
  tweetId: string,
  limit = 50,
  options?: OpenCLIOptions,
): Promise<OpenCLIResult<OpenCLIThreadTweet[]>> {
  return executeOpenCLI<OpenCLIThreadTweet[]>(
    ["twitter", "thread", tweetId, "--limit", String(limit)],
    { timeout: TWITTER_ARTICLE_TIMEOUT, ...options },
  );
}

// ---- LinkedIn ----

export interface OpenCLILinkedInPost {
  rank: number;
  id?: string;
  author: string;
  author_url?: string;
  headline?: string;
  text: string;
  posted_at?: string;
  reactions?: number;
  comments?: number;
  url?: string;
}

export async function fetchLinkedInTimeline(limit = 10, options?: OpenCLIOptions): Promise<OpenCLIResult<OpenCLILinkedInPost[]>> {
  return executeOpenCLI<OpenCLILinkedInPost[]>(["linkedin", "timeline", "--limit", String(limit)], { timeout: LINKEDIN_TIMEOUT, ...options });
}

// ---- Medium ----

export interface OpenCLIMediumPost {
  rank?: number;
  title: string;
  author?: string;
  date?: string;
  readTime?: string;
  claps?: string | number;
  description?: string;
  url: string;
}

export async function fetchMediumFeed(limit = 10, options?: OpenCLIOptions): Promise<OpenCLIResult<OpenCLIMediumPost[]>> {
  return executeOpenCLI<OpenCLIMediumPost[]>(["medium", "feed", "--limit", String(limit)], { timeout: MEDIUM_TIMEOUT, ...options });
}

export async function fetchMediumUser(username: string, limit = 10, options?: OpenCLIOptions): Promise<OpenCLIResult<OpenCLIMediumPost[]>> {
  return executeOpenCLI<OpenCLIMediumPost[]>(["medium", "user", username, "--limit", String(limit)], { timeout: MEDIUM_TIMEOUT, ...options });
}

// ---- YouTube ----

export interface OpenCLITranscriptSegment {
  timestamp?: string;
  speaker?: string;
  text: string;
}

export async function fetchYouTubeTranscript(url: string, options?: OpenCLIOptions): Promise<OpenCLIResult<OpenCLITranscriptSegment[]>> {
  return executeOpenCLI<OpenCLITranscriptSegment[]>(["youtube", "transcript", url, "--mode", "grouped"], options);
}
