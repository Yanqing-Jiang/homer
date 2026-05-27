/**
 * agent-browser CDP scrape executor.
 *
 * Replaces the OpenCLI executor (deleted 2026-05-26) — see decision file
 * ~/memory/decisions/2026-05-26-reverted-opencli-back-to-agent-browser.md.
 *
 * Architecture:
 *   - Direct `agent-browser` CLI over Chrome DevTools Protocol (port 9222)
 *   - Each scrape is a script file under ./scrape-scripts/, read + minified
 *     to a single-line expression and run via `agent-browser eval`
 *   - Serialized via a module-level mutex (agent-browser has one persistent
 *     CDP socket; concurrent open/eval would collide)
 *   - Executor owns the CDP lifecycle: ensureCDP({headed:true}) + connect
 *
 * Compatibility: returns a ScrapeResult<T> envelope that is a superset of
 * the old OpenCLIResult<T> shape so existing mappers/call sites keep working.
 */

import { execFile } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { ensureCDP } from "../scraping/chrome-launcher.js";
import { logger } from "../utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, "scrape-scripts");
const AGENT_BROWSER_BIN = "agent-browser";
const CDP_PORT = 9222;

// ============================================
// RESULT ENVELOPE
// ============================================

export type ScrapeStatus =
  | "ok"
  | "empty"
  | "timeout"
  | "auth"              // login wall / not signed in
  | "cdp_unavailable"   // Chrome CDP not reachable
  | "backend_error"     // agent-browser process crashed or socket lost
  | "parse_error"       // eval returned non-JSON / wrong shape
  | "selector_empty";   // page rendered but selector matched nothing

export interface ScrapeResult<T = unknown> {
  data: T | null;
  rawOutput: string;
  exitCode: number;     // 0 = ok, non-zero = failure (kept for OpenCLIResult compat)
  duration: number;
  status: ScrapeStatus;
  retryable: boolean;
  /** Legacy compat: callers that read needsAuth (e.g. content-scraper.ts) still work. */
  needsAuth: boolean;
  /** Legacy compat: always false for agent-browser (no extension dependency). */
  needsExtension: boolean;
  error?: string;
}

/** True if the failure is a "try the LLM fallback" class of error (not a permanent block). */
export function isRetryableScrapeError(result: ScrapeResult<unknown>): boolean {
  return result.retryable;
}

/** Back-compat alias so existing call sites that import isRetryableOpenCLIError keep working.
 *  Narrow semantics — mirrors the old OpenCLI behavior: only true for service-unavailable (69)
 *  or timeout (75). Auth (77), parse, and empty results are NOT retried automatically. */
export function isRetryableOpenCLIError(exitCode: number): boolean {
  return exitCode === EXIT_SERVICE_UNAVAIL || exitCode === EXIT_TIMEOUT;
}

// ============================================
// RAW DATA TYPES (schema matches old OpenCLI* aliases for mapper compat)
// ============================================

export interface RawBookmark {
  id: string;
  author: string;
  name?: string;
  text: string;
  likes: number;
  retweets?: number;
  created_at?: string;
  url: string;
}

export interface RawArticle {
  author: string;
  content: string;
  title?: string;
  url: string;
}

export interface RawThreadTweet {
  id: string;
  author: string;
  text: string;
  likes?: number;
  retweets?: number;
  in_reply_to?: string;
  created_at?: string;
  url?: string;
}

export interface RawMediumPost {
  rank?: number;
  title: string;
  author?: string;
  date?: string;
  readTime?: string;
  claps?: string | number;
  description?: string;
  url: string;
}

export interface RawLinkedInPost {
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

// Legacy type aliases — keep old import names working without renames in mappers.
export type OpenCLIBookmark = RawBookmark;
export type OpenCLIArticle = RawArticle;
export type OpenCLIThreadTweet = RawThreadTweet;
export type OpenCLIMediumPost = RawMediumPost;
export type OpenCLILinkedInPost = RawLinkedInPost;
export type OpenCLIResult<T = unknown> = ScrapeResult<T>;
export type OpenCLIOptions = ScrapeOptions;

// ============================================
// TIMEOUTS
// ============================================

// Exit codes preserved from OpenCLI surface so call-site classification still maps.
const EXIT_SERVICE_UNAVAIL = 69;
const EXIT_TIMEOUT = 75;
const EXIT_AUTH = 77;
const TWITTER_BOOKMARKS_TIMEOUT = 60_000;
const TWITTER_ARTICLE_TIMEOUT = 45_000;
const TWITTER_THREAD_TIMEOUT = 45_000;
const MEDIUM_TIMEOUT = 30_000;
const AGENT_BROWSER_CONNECT_TIMEOUT = 10_000;
// Pacing — small wait after open() so X SPA mounts tweets before eval probes the DOM.
const POST_OPEN_SETTLE_MS = 3_500;
// Bookmark scrolling — max passes and dwell.
const BOOKMARK_MAX_SCROLLS = 6;
const BOOKMARK_SCROLL_PX = 900;
const BOOKMARK_SCROLL_DWELL_MS = 2_500;

export interface ScrapeOptions {
  timeout?: number;
  signal?: AbortSignal;
}

// ============================================
// SERIALIZATION MUTEX
// ============================================

// agent-browser holds one CDP socket at ~/.agent-browser/default.sock. Concurrent
// `open` / `eval` calls race on the same browser tab. Serialize all scrapes.
let scrapeChain: Promise<unknown> = Promise.resolve();

function withScrapeLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = scrapeChain.then(() => fn(), () => fn());
  // Don't let an error in this scrape poison the chain.
  scrapeChain = next.catch(() => undefined);
  return next;
}

// ============================================
// LOW-LEVEL: agent-browser invocation
// ============================================

function execFileAsync(cmd: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
          e.stderr = stderr;
          reject(e);
        } else {
          resolve(stdout);
        }
      },
    );
    if (signal) {
      if (signal.aborted) child.kill("SIGTERM");
      else signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    }
  });
}

function minify(script: string): string {
  // agent-browser eval requires single-line JS. Only strip whole-line `//` comments
  // (leading-whitespace + //...). Mid-line `//` can appear inside regex literals so
  // we leave it alone — scripts under scrape-scripts/ MUST not use mid-line `//`.
  return script
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line.trimEnd()))
    .filter(Boolean)
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const scriptCache = new Map<string, string>();
function loadScript(name: string): string {
  let cached = scriptCache.get(name);
  if (cached) return cached;
  const raw = readFileSync(join(SCRIPTS_DIR, name), "utf8");
  cached = minify(raw);
  scriptCache.set(name, cached);
  return cached;
}

function parseAgentBrowserJson(stdout: string): unknown {
  // agent-browser prints any preamble + then the structured JSON value. We only accept
  // array/object/null payloads — extractor scripts never return bare numbers or strings,
  // and accepting them risks parsing a preamble port/pid/timestamp as the payload.
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  let startIdx = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === "[" || c === "{") {
      startIdx = i;
      break;
    }
    if (c === "n" && trimmed.slice(i, i + 4) === "null") {
      return null;
    }
  }
  if (startIdx === -1) return null;
  const candidate = trimmed.slice(startIdx);
  return JSON.parse(candidate);
}

// ============================================
// CDP + BACKEND READINESS
// ============================================

let connectedOnce = false;
async function ensureBackendReady(): Promise<{ ok: true } | { ok: false; status: ScrapeStatus; error: string }> {
  try {
    await ensureCDP({ headed: true });
  } catch (err) {
    return { ok: false, status: "cdp_unavailable", error: err instanceof Error ? err.message : String(err) };
  }
  // Connect agent-browser to the CDP port. Idempotent once the socket exists.
  if (!connectedOnce) {
    try {
      await execFileAsync(AGENT_BROWSER_BIN, ["connect", String(CDP_PORT)], AGENT_BROWSER_CONNECT_TIMEOUT);
      connectedOnce = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Re-try once more on next call — don't latch failure forever.
      return { ok: false, status: "backend_error", error: `agent-browser connect failed: ${msg}` };
    }
  }
  return { ok: true };
}

export async function isScrapeBackendHealthy(): Promise<boolean> {
  const ready = await ensureBackendReady();
  if (!ready.ok) return false;
  try {
    // Quick eval ping — confirms socket is responsive.
    await execFileAsync(AGENT_BROWSER_BIN, ["eval", "1+1"], 5_000);
    return true;
  } catch {
    connectedOnce = false; // force reconnect on next call
    return false;
  }
}

/** Legacy alias — old callers checked isOpenCLIHealthy(). */
export const isOpenCLIHealthy = isScrapeBackendHealthy;

// ============================================
// CORE: open + eval a script, return ScrapeResult
// ============================================

interface OpenAndEvalArgs {
  url: string;
  scriptName: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Optional post-open hook for scroll/wait sequences (already inside the lock). */
  postOpen?: (ctx: { deadline: number }) => Promise<void>;
}

async function openAndEval<T>({ url, scriptName, timeoutMs, signal, postOpen }: OpenAndEvalArgs): Promise<ScrapeResult<T>> {
  // Outer start tracks queue + work for duration reporting only; the per-target
  // deadline is set INSIDE the lock so queue wait doesn't eat the scrape budget.
  const queueStart = Date.now();
  return withScrapeLock(async () => {
    const start = Date.now();
    const deadline = start + timeoutMs;
    const ready = await ensureBackendReady();
    if (ready.ok === false) {
      return {
        data: null,
        rawOutput: "",
        exitCode: 1,
        duration: Date.now() - queueStart,
        status: ready.status,
        retryable: true,
        needsAuth: false,
        needsExtension: false,
        error: ready.error,
      } satisfies ScrapeResult<T>;
    }

    let rawOutput = "";
    const remaining = () => Math.max(2_000, deadline - Date.now());

    try {
      // Step 1: navigate
      await execFileAsync(AGENT_BROWSER_BIN, ["open", url], remaining(), signal);
      // Step 2: settle dwell (gives SPAs time to mount) — bounded by deadline
      await new Promise((r) => setTimeout(r, Math.min(POST_OPEN_SETTLE_MS, Math.max(0, deadline - Date.now()))));
      // Step 3: optional scroll/wait sequence — postOpen owns its own deadline checks
      if (postOpen) await postOpen({ deadline });
      // Step 4: eval extractor
      if (Date.now() >= deadline) throw new Error("Scrape deadline exceeded before final eval");
      const script = loadScript(scriptName);
      rawOutput = await execFileAsync(AGENT_BROWSER_BIN, ["eval", script], remaining(), signal);
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
      const isTimeout = e.killed || e.signal === "SIGTERM" || /timeout|deadline/i.test(e.message ?? "");
      const status: ScrapeStatus = isTimeout ? "timeout" : "backend_error";
      // On backend error, reset the connect latch so we re-handshake next call.
      if (status === "backend_error") connectedOnce = false;
      return {
        data: null,
        rawOutput,
        exitCode: isTimeout ? EXIT_TIMEOUT : 1,
        duration: Date.now() - queueStart,
        status,
        retryable: true,
        needsAuth: false,
        needsExtension: false,
        error: e.message,
      } satisfies ScrapeResult<T>;
    }

    // Parse
    let parsed: unknown;
    try {
      parsed = parseAgentBrowserJson(rawOutput);
    } catch (err) {
      return {
        data: null,
        rawOutput,
        exitCode: 2,
        duration: Date.now() - queueStart,
        status: "parse_error",
        retryable: false,
        needsAuth: false,
        needsExtension: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies ScrapeResult<T>;
    }

    // Auth-wall detection: extractors return null/empty when the page is a login interstitial.
    if (parsed === null || parsed === undefined) {
      const needsAuth = /login|sign[_-]?in/i.test(rawOutput);
      return {
        data: null,
        rawOutput,
        exitCode: needsAuth ? EXIT_AUTH : 1,
        duration: Date.now() - queueStart,
        status: needsAuth ? "auth" : "selector_empty",
        retryable: needsAuth ? false : true,
        needsAuth,
        needsExtension: false,
      } satisfies ScrapeResult<T>;
    }
    if (Array.isArray(parsed) && parsed.length === 0) {
      return {
        data: parsed as unknown as T,
        rawOutput,
        exitCode: 0,
        duration: Date.now() - queueStart,
        status: "empty",
        retryable: true,
        needsAuth: false,
        needsExtension: false,
      } satisfies ScrapeResult<T>;
    }

    return {
      data: parsed as T,
      rawOutput,
      exitCode: 0,
      duration: Date.now() - queueStart,
      status: "ok",
      retryable: false,
      needsAuth: false,
      needsExtension: false,
    } satisfies ScrapeResult<T>;
  });
}

// ============================================
// TWITTER
// ============================================

export async function fetchTwitterBookmarks(limit = 20, options?: ScrapeOptions): Promise<ScrapeResult<RawBookmark[]>> {
  const timeoutMs = options?.timeout ?? TWITTER_BOOKMARKS_TIMEOUT;
  let collected: RawBookmark[] = [];

  const postOpen = async ({ deadline }: { deadline: number }) => {
    // Initial extraction; then scroll loop until limit hit, deadline hit, or no new IDs.
    const seen = new Set<string>();
    for (let i = 0; i <= BOOKMARK_MAX_SCROLLS; i++) {
      const remaining = deadline - Date.now();
      if (remaining <= 2_000) break;
      const evalTimeout = Math.min(15_000, remaining);
      const script = loadScript("twitter-bookmarks.js");
      let raw = "";
      try {
        raw = await execFileAsync(AGENT_BROWSER_BIN, ["eval", script], evalTimeout);
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Bookmark scroll-eval failed mid-loop");
        break;
      }
      try {
        const batch = parseAgentBrowserJson(raw) as RawBookmark[] | null;
        if (Array.isArray(batch)) {
          let added = 0;
          for (const b of batch) {
            if (!seen.has(b.id)) {
              seen.add(b.id);
              collected.push(b);
              added++;
            }
          }
          if (collected.length >= limit) break;
          if (added === 0 && i > 0) break;
        }
      } catch {
        // Continue scrolling even if one batch parse fails.
      }
      if (i < BOOKMARK_MAX_SCROLLS) {
        const remainingAfterEval = deadline - Date.now();
        if (remainingAfterEval <= BOOKMARK_SCROLL_DWELL_MS + 2_000) break;
        try {
          await execFileAsync(AGENT_BROWSER_BIN, ["scroll", "down", String(BOOKMARK_SCROLL_PX)], Math.min(5_000, remainingAfterEval));
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, Math.min(BOOKMARK_SCROLL_DWELL_MS, Math.max(0, deadline - Date.now()))));
      }
    }
  };

  const result = await openAndEval<RawBookmark[]>({
    url: "https://x.com/i/bookmarks",
    scriptName: "twitter-bookmarks.js",
    timeoutMs,
    signal: options?.signal,
    postOpen,
  });

  // Override data with our scroll-accumulated batch (executor's eval is the last single batch).
  if (result.status === "ok" || result.status === "empty" || result.status === "selector_empty") {
    if (collected.length > 0) {
      const trimmed = collected.slice(0, limit);
      return {
        ...result,
        data: trimmed,
        status: trimmed.length > 0 ? "ok" : "empty",
        exitCode: 0,
        retryable: trimmed.length === 0,
      };
    }
  }
  return result;
}

export async function fetchTwitterArticle(tweetId: string, options?: ScrapeOptions): Promise<ScrapeResult<RawArticle>> {
  const timeoutMs = options?.timeout ?? TWITTER_ARTICLE_TIMEOUT;
  return openAndEval<RawArticle>({
    url: `https://x.com/i/web/status/${tweetId}`,
    scriptName: "twitter-article.js",
    timeoutMs,
    signal: options?.signal,
  });
}

export async function fetchTwitterThread(
  tweetId: string,
  _limit = 50,
  options?: ScrapeOptions,
): Promise<ScrapeResult<RawThreadTweet[]>> {
  const timeoutMs = options?.timeout ?? TWITTER_THREAD_TIMEOUT;
  return openAndEval<RawThreadTweet[]>({
    url: `https://x.com/i/web/status/${tweetId}`,
    scriptName: "twitter-thread.js",
    timeoutMs,
    signal: options?.signal,
  });
}

// ============================================
// MEDIUM
// ============================================

export async function fetchMediumFeed(limit = 10, options?: ScrapeOptions): Promise<ScrapeResult<RawMediumPost[]>> {
  const timeoutMs = options?.timeout ?? MEDIUM_TIMEOUT;
  const r = await openAndEval<RawMediumPost[]>({
    url: "https://medium.com/?source=home_for_you",
    scriptName: "medium-feed.js",
    timeoutMs,
    signal: options?.signal,
  });
  if (r.status === "ok" && r.data) return { ...r, data: r.data.slice(0, limit) };
  return r;
}

export async function fetchMediumUser(username: string, limit = 10, options?: ScrapeOptions): Promise<ScrapeResult<RawMediumPost[]>> {
  const timeoutMs = options?.timeout ?? MEDIUM_TIMEOUT;
  const handle = username.replace(/^@/, "");
  const r = await openAndEval<RawMediumPost[]>({
    url: `https://medium.com/@${handle}`,
    scriptName: "medium-feed.js",
    timeoutMs,
    signal: options?.signal,
  });
  if (r.status === "ok" && r.data) return { ...r, data: r.data.slice(0, limit) };
  return r;
}

// ============================================
// LINKEDIN (thin wrapper around LLM-mediated browser scrape)
// ============================================

// LinkedIn feed posts don't render reliably in the CDP debug profile; selectors
// rotate fast. Keep the named entrypoint but delegate to the existing
// executeBrowserScrape (Claude/Gemini-mediated) path. When a direct selector
// implementation becomes viable, swap the body here.

interface LLMLinkedInPost {
  title?: string;
  date?: string;
  reactions?: number;
  comments?: number;
  link?: string;
  first_paragraph?: string;
  hook_analysis?: string;
  content?: string;
  source?: string;
  author?: string;
}

/** Map the LLM's LinkedIn scrape output shape into the RawLinkedInPost shape callers expect. */
function normalizeLinkedInLLMPost(p: LLMLinkedInPost, rank: number): RawLinkedInPost {
  return {
    rank,
    author: p.author ?? "",
    author_url: undefined,
    headline: p.title,
    text: p.content ?? p.first_paragraph ?? p.title ?? "",
    posted_at: p.date,
    reactions: typeof p.reactions === "number" ? p.reactions : undefined,
    comments: typeof p.comments === "number" ? p.comments : undefined,
    url: p.link,
  };
}

export async function fetchLinkedInTimeline(_limit = 10, options?: ScrapeOptions): Promise<ScrapeResult<RawLinkedInPost[]>> {
  const start = Date.now();
  const { executeBrowserScrape } = await import("./browser-scrape.js");
  const { buildLinkedInTopPostPrompt } = await import("../scraping/browser-prompts.js");
  const timeoutMs = options?.timeout ?? 600_000;
  try {
    const r = await executeBrowserScrape(buildLinkedInTopPostPrompt(), "", { timeout: timeoutMs, signal: options?.signal });
    const rawOut = (r.output ?? "").trim();

    if (r.exitCode !== 0) {
      return {
        data: null,
        rawOutput: rawOut,
        exitCode: r.exitCode,
        duration: Date.now() - start,
        status: "backend_error",
        retryable: true,
        needsAuth: false,
        needsExtension: false,
        error: `LinkedIn LLM-mediated scrape failed (exit ${r.exitCode})`,
      };
    }

    // Sentinel detection — prompt instructs the worker to return these exact strings.
    if (/^AUTH_REQUIRED\s*$/m.test(rawOut)) {
      return {
        data: null,
        rawOutput: rawOut,
        exitCode: EXIT_AUTH,
        duration: Date.now() - start,
        status: "auth",
        retryable: false,
        needsAuth: true,
        needsExtension: false,
        error: "LinkedIn auth wall — session may need refresh",
      };
    }
    if (/^BOT_DETECTED\s*$/m.test(rawOut)) {
      return {
        data: null,
        rawOutput: rawOut,
        exitCode: 1,
        duration: Date.now() - start,
        status: "backend_error",
        retryable: false,
        needsAuth: false,
        needsExtension: false,
        error: "LinkedIn bot/captcha wall",
      };
    }

    // Parse LLM JSON — buildLinkedInTopPostPrompt returns [{title, date, reactions, comments, link,
    // first_paragraph, hook_analysis, content, source, author}]. Normalize to RawLinkedInPost.
    let llmRows: LLMLinkedInPost[] | null = null;
    try {
      const candidate = parseAgentBrowserJson(rawOut);
      if (Array.isArray(candidate)) llmRows = candidate as LLMLinkedInPost[];
    } catch {
      // fall through to parse_error
    }
    if (llmRows === null) {
      return {
        data: null,
        rawOutput: rawOut,
        exitCode: 2,
        duration: Date.now() - start,
        status: "parse_error",
        retryable: true,
        needsAuth: false,
        needsExtension: false,
        error: "LinkedIn LLM output did not parse as JSON array",
      };
    }
    if (llmRows.length === 0) {
      return {
        data: [],
        rawOutput: rawOut,
        exitCode: 0,
        duration: Date.now() - start,
        status: "empty",
        retryable: true,
        needsAuth: false,
        needsExtension: false,
      };
    }
    const data = llmRows.slice(0, _limit).map((row, idx) => normalizeLinkedInLLMPost(row, idx + 1));
    return {
      data,
      rawOutput: rawOut,
      exitCode: 0,
      duration: Date.now() - start,
      status: "ok",
      retryable: false,
      needsAuth: false,
      needsExtension: false,
    };
  } catch (err) {
    return {
      data: null,
      rawOutput: "",
      exitCode: 1,
      duration: Date.now() - start,
      status: "backend_error",
      retryable: true,
      needsAuth: false,
      needsExtension: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================
// LEGACY NO-OPs (callers we couldn't fully migrate yet)
// ============================================

// fetchYouTubeTranscript was OpenCLI-only and unused — link-processor handles YouTube via yt-dlp.
// Export a stub for any straggler import; mark deprecated.
export async function fetchYouTubeTranscript(_url: string, _options?: ScrapeOptions): Promise<ScrapeResult<unknown[]>> {
  return {
    data: null,
    rawOutput: "",
    exitCode: 1,
    duration: 0,
    status: "backend_error",
    retryable: false,
    needsAuth: false,
    needsExtension: false,
    error: "fetchYouTubeTranscript removed — use link-processor / yt-dlp instead",
  };
}
