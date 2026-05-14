import { existsSync, readFileSync } from "fs";
// @ts-ignore
import type Database from "better-sqlite3";
import { z } from "zod";
import { parseIdeasMd, type ParsedIdea } from "./parser.js";
import * as dao from "./dao.js";
import { logger } from "../utils/logger.js";
import { fetchTwitterBookmarks, fetchTwitterArticle, isRetryableOpenCLIError } from "../executors/opencli.js";
import { mapOpenCLIBookmarks, mapOpenCLIArticleToText } from "../executors/opencli-mappers.js";
import { executeBrowserScrape } from "../executors/browser-scrape.js";
import {
  buildBookmarkScrapePrompt,
  buildTweetReadPrompt,
  BOOKMARK_JSON_START, BOOKMARK_JSON_END,
} from "../scraping/browser-prompts.js";
import { ensureCDP } from "../scraping/chrome-launcher.js";
import { cleanAgentOutput } from "../scraping/clean-output.js";
import { parseSwarmJSON } from "../executors/model-swarm.js";
import { insertScrape } from "../scraping/scrape-store.js";
import { fetchAndExtract } from "../scraping/deep-fetch.js";
import { PATHS } from "../config/paths.js";

const IDEAS_FILE = PATHS.ideasMd;

interface SyncState {
  id: string;
  last_synced_at: string | null;
  last_line_number: number;
  last_bookmark_id: string | null;
}

interface IngestResult {
  ingested: number;
  skipped: number;
  enriched: number;
  fromTwitter: number;
  errors: string[];
}

// ============================================
// BOOKMARK EXTRACTION — Zod Schema + Parsing
// ============================================

const ScrapedBookmarkSchema = z.object({
  id: z.string().regex(/^\d{8,25}$/),
  author: z.string().min(1).max(30),
  url: z.string().url(),
  text: z.string().min(15),
  external_urls: z.array(z.string().url()).optional().default([]),
});
const ScrapedBookmarksSchema = z.array(ScrapedBookmarkSchema);
type ScrapedBookmark = z.infer<typeof ScrapedBookmarkSchema>;

interface TwitterBookmark {
  id: string;
  text: string;
  author: string;
  authorName?: string;
  title: string;
  urls: string[];
  likes?: number;
  retweets?: number;
  createdAt?: string;
}

/** Extract content between unique markers from LLM output. */
function extractMarkedBlock(raw: string, startMarker: string, endMarker: string): string | null {
  const startIdx = raw.indexOf(startMarker);
  if (startIdx === -1) return null;
  const from = startIdx + startMarker.length;
  const endIdx = raw.indexOf(endMarker, from);
  if (endIdx === -1) return null;
  return raw.slice(from, endIdx).trim();
}

/** Generate a clean title from tweet text in TypeScript (deterministic). */
function deriveBookmarkTitle(text: string, author: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean || clean.length < 5) return `X: @${author} bookmark`;
  // URL-only tweets: the text IS a link, not a sentence
  if (/^https?:\/\/\S+$/.test(clean)) return `X: @${author} shared link`;
  // Strip leading URLs before deriving title (media tweets start with t.co links)
  const withoutLeadingUrl = clean.replace(/^https?:\/\/\S+\s*/, "").trim();
  const source = withoutLeadingUrl.length > 10 ? withoutLeadingUrl : clean;
  const firstSentence = source.split(/[.!?\n]/)[0]?.trim() || source;
  return firstSentence.length > 80
    ? `${firstSentence.slice(0, 77)}...`
    : firstSentence;
}

// ============================================
// T.CO RESOLUTION + DEEP CONTENT ENRICHMENT
// ============================================

const TCO_RESOLVE_TIMEOUT = 8_000;
const DEEP_FETCH_MAX_CHARS = 6_000;

/**
 * Resolve a t.co short URL to its final destination via HTTP redirect.
 * Returns the original URL if resolution fails.
 */
async function resolveTco(url: string): Promise<string> {
  if (!url.includes("t.co")) return url;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TCO_RESOLVE_TIMEOUT);
    const resp = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Homer/1.0)" },
    });
    clearTimeout(timer);
    return resp.url !== url ? resp.url : url;
  } catch {
    return url;
  }
}

/**
 * Enrich a bookmark with resolved URLs and deep-fetched article content.
 * Mirrors what Chrome CDP did implicitly: follow t.co → fetch article body.
 *
 * Returns augmented content and final resolved external URLs.
 */
async function enrichBookmark(bookmark: TwitterBookmark): Promise<{
  content: string;
  resolvedUrls: string[];
  deepContent: string | null;
}> {
  // Resolve all t.co URLs to their final destinations
  const resolvedUrls = await Promise.all(
    bookmark.urls.map(u => resolveTco(u))
  );

  // Filter to non-social external URLs
  const externalUrls = resolvedUrls.filter(u => {
    try {
      const h = new URL(u).hostname;
      return !["x.com", "twitter.com", "t.co", "linkedin.com", "instagram.com"].some(d => h === d || h.endsWith(`.${d}`));
    } catch { return false; }
  });

  // Deep-fetch article content when:
  // 1. Bookmark text is minimal (mostly just a URL) — the link IS the content
  // 2. OR we have external article URLs worth enriching
  const isLinkOnly = bookmark.text.trim().match(/^https?:\/\/\S+$/) != null
    || (bookmark.text.trim().length < 60 && externalUrls.length > 0);

  let deepContent: string | null = null;
  if (externalUrls.length > 0 && isLinkOnly) {
    const target = externalUrls[0]!;
    logger.debug({ url: target, author: bookmark.author }, "Deep-fetching bookmark article");
    const result = await fetchAndExtract(target);
    if (result.method !== "failed" && result.content.length > 100) {
      const cap = result.content.slice(0, DEEP_FETCH_MAX_CHARS);
      deepContent = result.title ? `# ${result.title}\n\n${cap}` : cap;
      logger.debug({ url: target, chars: result.content.length, method: result.method }, "Deep-fetch OK");
    }
  }

  return { content: bookmark.text, resolvedUrls: externalUrls, deepContent };
}

/** Parse bookmark scrape output: try markers first, fall back to parseSwarmJSON. */
function parseBookmarkOutput(raw: string): TwitterBookmark[] {
  // Tier 1: Extract from markers
  const marked = extractMarkedBlock(raw, BOOKMARK_JSON_START, BOOKMARK_JSON_END);
  // Tier 2: Clean raw output and try parsing
  const candidate = marked ?? cleanAgentOutput(raw);

  let parsed: ScrapedBookmark[];
  try {
    parsed = parseSwarmJSON(candidate, ScrapedBookmarksSchema);
  } catch {
    // Tier 2b: Try the full raw output if marker extraction failed
    if (marked) {
      try {
        parsed = parseSwarmJSON(cleanAgentOutput(raw), ScrapedBookmarksSchema);
      } catch {
        return [];
      }
    } else {
      return [];
    }
  }

  // Normalize + dedup
  const seen = new Set<string>();
  return parsed
    .map((b): TwitterBookmark | null => {
      const author = b.author.replace(/^@/, "");
      const text = b.text.replace(/\s+/g, " ").trim();
      if (text.length < 15) return null;
      if (seen.has(b.id)) return null;
      seen.add(b.id);

      const externalUrls = [...new Set(
        (b.external_urls ?? [])
          .map(u => u.trim())
          .filter(u => u && !u.includes("twitter.com") && !u.includes("x.com")),
      )];

      return {
        id: b.id,
        author,
        text,
        title: deriveBookmarkTitle(text, author),
        urls: externalUrls,
      };
    })
    .filter((b): b is TwitterBookmark => b !== null);
}

// ============================================
// SYNC STATE MANAGEMENT
// ============================================

function getSyncState(db: Database.Database): SyncState {
  const row = db.prepare("SELECT * FROM idea_sync_state WHERE id = 'default'").get() as SyncState | undefined;
  return row ?? { id: "default", last_synced_at: null, last_line_number: 0, last_bookmark_id: null };
}

function updateSyncState(db: Database.Database, lineNumber: number): void {
  db.prepare(`
    INSERT INTO idea_sync_state (id, last_synced_at, last_line_number)
    VALUES ('default', CURRENT_TIMESTAMP, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_synced_at = CURRENT_TIMESTAMP,
      last_line_number = excluded.last_line_number
  `).run(lineNumber);
}

function ensureIdeaId(idea: ParsedIdea): void {
  if (!idea.id || idea.id.length < 8) {
    const tsHash = idea.timestamp.replace(/[- :]/g, "").slice(-8);
    idea.id = `idea_${tsHash}_${Math.random().toString(36).slice(2, 6)}`;
  }
}

// ============================================
// TWITTER/X SCRAPING (via Claude Sonnet + agent-browser)
// ============================================

/**
 * Run bookmark extraction with a given target count.
 * Primary: opencli (zero cost, ~2s). Fallback: executeBrowserScrape on infra errors.
 */
async function runBookmarkExtraction(maxItems: number): Promise<TwitterBookmark[]> {
  // Try opencli first
  const cliResult = await fetchTwitterBookmarks(maxItems);
  if (cliResult.exitCode === 0 && cliResult.data && cliResult.data.length > 0) {
    const mapped = mapOpenCLIBookmarks(cliResult.data);
    logger.info({ count: mapped.length, source: "opencli", duration: cliResult.duration }, "Bookmark extraction via opencli");
    if (mapped.length > 0) return mapped;
  }

  // Fallback to browser scrape only on infra errors (extension down, timeout)
  if (cliResult.exitCode !== 0 && !isRetryableOpenCLIError(cliResult.exitCode)) {
    throw new Error(`opencli bookmarks failed (exit ${cliResult.exitCode}): ${cliResult.error}`);
  }

  logger.info({ opencliExit: cliResult.exitCode, error: cliResult.error }, "opencli unavailable, falling back to browser scrape");
  await ensureCDP({ headed: true }).catch(() => {});
  const result = await executeBrowserScrape(
    buildBookmarkScrapePrompt(maxItems), "", { timeout: 600_000 },
  );

  if (result.exitCode !== 0) {
    throw new Error(`Browser scrape fallback failed (${result.executor}, exit ${result.exitCode}): ${result.output?.slice(0, 200)}`);
  }

  const bookmarks = parseBookmarkOutput(result.output ?? "");
  if (bookmarks.length === 0) {
    throw new Error(`No valid bookmarks parsed from fallback output (${(result.output ?? "").length} chars)`);
  }

  return bookmarks;
}

/**
 * Read a single tweet/thread to get full text content.
 * Primary: opencli twitter article (zero cost, ~3s). Fallback: executeBrowserScrape.
 */
async function readTweetThread(tweetUrl: string): Promise<string | null> {
  // Extract tweet ID from URL
  const idMatch = tweetUrl.match(/status\/(\d+)/);
  if (!idMatch) return null;

  // Try opencli first
  try {
    const cliResult = await fetchTwitterArticle(idMatch[1]!);
    if (cliResult.exitCode === 0 && cliResult.data) {
      const text = mapOpenCLIArticleToText(cliResult.data);
      if (text.length > 0) {
        logger.debug({ tweetId: idMatch[1], chars: text.length, source: "opencli" }, "Thread read via opencli");
        return text;
      }
    }

    // Fallback on infra errors only
    if (cliResult.exitCode !== 0 && isRetryableOpenCLIError(cliResult.exitCode)) {
      const browserResult = await executeBrowserScrape(
        buildTweetReadPrompt(tweetUrl), "", { timeout: 300_000 },
      );
      if (browserResult.exitCode === 0 && browserResult.output && browserResult.output !== "FAILED") {
        return browserResult.output.trim();
      }
    }
  } catch (err) {
    logger.debug({ err, tweetUrl }, "Tweet thread read failed");
  }
  return null;
}

async function scrapeTwitterBookmarks(): Promise<ParsedIdea[]> {
  logger.info("Scraping Twitter/X bookmarks via opencli (browser fallback on infra errors)");

  try {
    let bookmarks: TwitterBookmark[] = [];
    let lastError = "";

    // Retry strategy: try full count, then smaller if it fails
    for (const maxItems of [10, 6]) {
      try {
        bookmarks = await runBookmarkExtraction(maxItems);
        logger.info({ count: bookmarks.length, target: maxItems }, "Bookmark extraction succeeded");
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger.warn({ maxItems, error: lastError }, "Bookmark extraction attempt failed, retrying smaller");
      }
    }

    // Fail closed — no regex fallback, no garbage scrapes
    if (bookmarks.length === 0) {
      logger.warn({ error: lastError }, "All bookmark extraction attempts failed — returning empty");
      return [];
    }

    const now = new Date();
    const timestamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;

    // Step 2: Enrich each bookmark — resolve t.co, deep-fetch linked articles,
    // then read full thread text. Sequential to avoid Chrome/network contention.
    // Thread reads for regular tweets capped at 5. Link-only tweets always get
    // a thread read because their entire content depends on it.
    const MAX_THREAD_READS = 5;
    const ideas: ParsedIdea[] = [];
    let threadReadsUsed = 0;
    for (const bookmark of bookmarks) {
      const tweetUrl = `https://x.com/${bookmark.author}/status/${bookmark.id}`;

      // Enrich: resolve t.co → deep-fetch article if link-only tweet
      const enriched = await enrichBookmark(bookmark);

      // Link-only tweets (entire text is a URL) have no content without a thread read —
      // always read those. Cap regular tweet thread reads at MAX_THREAD_READS.
      const isLinkOnly = /^https?:\/\/\S+$/.test(bookmark.text.trim());
      const fullText = (isLinkOnly || threadReadsUsed < MAX_THREAD_READS)
        ? await readTweetThread(tweetUrl)
        : null;
      if (fullText && !isLinkOnly) threadReadsUsed++;

      // Fix: when opencli truncated bookmark text to a t.co self-link,
      // the original enrichBookmark() finds no external URLs. Re-extract
      // from the full thread text and deep-fetch any article URLs found.
      if (fullText && fullText.length > bookmark.text.length && !enriched.deepContent) {
        const SOCIAL_DOMAINS = ["x.com", "twitter.com", "t.co", "linkedin.com", "instagram.com"];
        const threadUrlRe = /https?:\/\/[^\s"'<>\])}，。]+/g;
        const threadExtUrls = [...new Set(fullText.match(threadUrlRe) || [])]
          .filter(u => {
            try {
              const h = new URL(u).hostname;
              return !SOCIAL_DOMAINS.some(d => h === d || h.endsWith(`.${d}`));
            } catch { return false; }
          });
        if (threadExtUrls.length > 0) {
          const target = threadExtUrls[0]!;
          logger.debug({ url: target, author: bookmark.author }, "Deep-fetching from thread-read URL");
          const dfResult = await fetchAndExtract(target);
          if (dfResult.method !== "failed" && dfResult.content.length > 100) {
            const cap = dfResult.content.slice(0, DEEP_FETCH_MAX_CHARS);
            enriched.deepContent = dfResult.title ? `# ${dfResult.title}\n\n${cap}` : cap;
            enriched.resolvedUrls = [...new Set([...enriched.resolvedUrls, ...threadExtUrls])];
            logger.info({ url: target, chars: dfResult.content.length, method: dfResult.method }, "Thread-URL deep-fetch OK");
          }
        }
      }

      // Re-derive title from full text when original was truncated to "shared link"
      if (fullText && bookmark.title.includes("shared link")) {
        bookmark.title = deriveBookmarkTitle(fullText, bookmark.author);
      }

      // Best content: thread text > deep-fetched article > original bookmark text
      let content: string;
      if (fullText && fullText.length > bookmark.text.length) {
        content = fullText;
        // Append deep-fetched article if the thread references an external URL
        if (enriched.deepContent) {
          content += `\n\n---\n[Deep-linked article]\n${enriched.deepContent}`;
        }
      } else if (enriched.deepContent) {
        content = enriched.deepContent;
      } else {
        content = bookmark.text;
      }

      // Merge resolved external URLs with any URLs found in thread text
      const urlRegex = /https?:\/\/[^\s"'<>\])}，。]+/g;
      const textUrls = (content.match(urlRegex) || [])
        .filter((u: string) => !u.includes("x.com") && !u.includes("twitter.com") && !u.includes("t.co"));
      const allUrls = [...new Set([...enriched.resolvedUrls, ...textUrls])];
      const externalUrl = allUrls[0];

      logger.debug(
        { id: bookmark.id, author: bookmark.author, cardLen: bookmark.text.length, fullLen: content.length, urls: allUrls.length, deepFetched: enriched.deepContent != null },
        "Bookmark enrichment complete"
      );

      // Pack enrichment data for scrape insertion downstream
      const enrichmentPayload = JSON.stringify({
        external_urls: allUrls,
        likes: bookmark.likes,
        retweets: bookmark.retweets,
        created_at: bookmark.createdAt,
        author_name: bookmark.authorName,
        deep_fetched: enriched.deepContent != null,
        thread_read: fullText != null && fullText.length > bookmark.text.length,
      });

      ideas.push({
        id: `tweet_${bookmark.id}`,
        title: bookmark.title,
        status: "draft",
        source: "x-bookmarks",
        content: `**@${bookmark.author}**: ${content}`,
        link: tweetUrl,
        tags: ["x-bookmark"],
        timestamp,
        enrichment: enrichmentPayload,
        ...(externalUrl ? { context: `External link: ${externalUrl}` } : {}),
      });
    }

    return ideas;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg }, "Browser bookmark scrape error");
    return [];
  }
}

// YouTube scraping has been moved to Telegram → overnight pipeline.
// See src/youtube/transcript.ts and src/youtube/summarizer.ts

// Deep URL fetching removed — handled by synthesizer pipeline (deep-fetch.ts)

// ============================================
// MAIN INGESTION FUNCTION
// ============================================

export async function ingestIdeasFromLegacy(db: Database.Database): Promise<IngestResult> {
  const result: IngestResult = {
    ingested: 0,
    skipped: 0,
    enriched: 0,
    fromTwitter: 0,
    errors: [],
  };

  // Ensure Chrome CDP is available for bookmark scraping
  let chromeHandle: { pid: number; cleanup: () => void } | null = null;
  try {
    chromeHandle = await ensureCDP();
    logger.info({ pid: chromeHandle.pid }, "Chrome CDP ready for idea ingest");
  } catch (err) {
    logger.warn({ error: String(err) }, "Chrome CDP launch failed — bookmark scrape may fail");
  }

  try {

  // Load existing ideas from DB (fallback to files)
  const existingIdeas = dao.getAllIdeas(db);
  const existingIds = new Set(existingIdeas.map((i) => i.id));
  const existingTitles = new Set(existingIdeas.map((i) => i.title.toLowerCase()));

  // ========== SOURCE 1: Twitter/X Bookmarks ==========
  try {
    const twitterIdeas = await scrapeTwitterBookmarks();
    const newIdeas = twitterIdeas.filter(
      (idea) => !existingIds.has(idea.id) && !existingTitles.has(idea.title.toLowerCase()),
    );
    result.skipped += twitterIdeas.length - newIdeas.length;

    // Write new bookmarks to scrapes table only — synthesizer handles idea creation
    for (const idea of newIdeas) {
      // Unpack enrichment data from scrapeTwitterBookmarks
      const enrichment = idea.enrichment ? JSON.parse(idea.enrichment) : {};
      const externalUrls: string[] = enrichment.external_urls ?? (
        idea.context?.startsWith("External link:")
          ? [idea.context.replace("External link: ", "")]
          : []
      );

      const meta: Record<string, unknown> = {
        tags: idea.tags,
        external_urls: externalUrls,
        likes: enrichment.likes,
        retweets: enrichment.retweets,
        created_at: enrichment.created_at,
        author_name: enrichment.author_name,
      };

      // If ingest already deep-fetched, mark it so deep-fetch.ts skips re-processing
      if (enrichment.deep_fetched || enrichment.thread_read) {
        meta.deep_fetch = {
          completed: true,
          urls: externalUrls.map((u: string) => ({ url: u, method: "ingest-inline" })),
          source: "ingest",
        };
      }

      insertScrape(db, {
        id: idea.id,
        source: "x-bookmark",
        url: idea.link,
        title: idea.title,
        author: idea.content.match(/@(\w+)/)?.[1] ?? undefined,
        raw_content: idea.content,
        metadata: JSON.stringify(meta),
      });

      existingIds.add(idea.id);
      existingTitles.add(idea.title.toLowerCase());
      result.ingested++;
      result.fromTwitter++;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    result.errors.push(`Twitter scrape failed: ${msg}`);
    logger.error({ error }, "Twitter scraping failed");
  }

  // YouTube ingestion is now handled via Telegram → overnight pipeline
  // (see src/youtube/ and src/bot/handlers/youtube.ts)

  // ========== SOURCE 2: Legacy ideas.md ==========
  if (existsSync(IDEAS_FILE)) {
    const content = readFileSync(IDEAS_FILE, "utf-8");
    const lines = content.split("\n");
    const totalLines = lines.length;

    const syncState = getSyncState(db);
    const lastSyncedLine = syncState.last_line_number;

    if (totalLines > lastSyncedLine) {
      const allIdeas = parseIdeasMd(content);
      const newIdeas: ParsedIdea[] = [];

      let currentLine = 0;
      let currentIdea: ParsedIdea | null = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const ideaMatch = line.match(/^### \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] (.+)$/);
        if (ideaMatch) {
          if (currentIdea && currentLine > lastSyncedLine) {
            newIdeas.push(currentIdea);
          }
          currentLine = i;
          const matchingIdea = allIdeas.find(
            (idea) => idea.timestamp === ideaMatch[1] && idea.title === ideaMatch[2]
          );
          currentIdea = matchingIdea ?? null;
        }
      }

      if (currentIdea && currentLine > lastSyncedLine) {
        newIdeas.push(currentIdea);
      }

      for (const idea of newIdeas) {
        try {
          if (existingIds.has(idea.id) || existingTitles.has(idea.title.toLowerCase())) {
            result.skipped++;
            continue;
          }

          ensureIdeaId(idea);

          // Write to scrapes table only — synthesizer handles idea creation
          insertScrape(db, {
            id: idea.id,
            source: "legacy-ideas-md",
            url: idea.link,
            title: idea.title,
            raw_content: idea.content || "",
          });
          existingIds.add(idea.id);
          existingTitles.add(idea.title.toLowerCase());
          result.ingested++;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          result.errors.push(`Failed to ingest "${idea.title}": ${msg}`);
        }
      }

      updateSyncState(db, totalLines);
    }
  }

  logger.info({
    ingested: result.ingested,
    enriched: result.enriched,
    fromTwitter: result.fromTwitter,
    skipped: result.skipped,
    errors: result.errors.length,
  }, "Idea ingestion complete");

  return result;

  } finally {
    // Clean up Chrome CDP if we launched it
    if (chromeHandle && chromeHandle.pid > 0) {
      chromeHandle.cleanup();
      logger.debug("Chrome CDP cleaned up after idea ingest");
    }
  }
}
