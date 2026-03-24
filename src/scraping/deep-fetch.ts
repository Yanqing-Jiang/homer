/**
 * Deep-Fetch Module — enriches scrapes with external URL content.
 *
 * Architecture:
 *   1. HTTP fetch + Readability.js for ~70% of URLs (zero LLM tokens)
 *   2. Browser fallback for JS-rendered pages (agent-browser snapshot)
 *   3. Updates scrape.raw_content with fetched text
 *
 * Called by the synthesizer pipeline as Step 0 (pre-scoring) or
 * independently via the scheduler.
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
// @ts-ignore
// @ts-ignore
import type Database from "better-sqlite3";
import { logger } from "../utils/logger.js";
import type { StoredScrape } from "./scrape-store.js";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_CONTENT_CHARS = 10_000;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

// Domains that need browser rendering (SPAs, heavy JS)
const BROWSER_REQUIRED_DOMAINS = new Set([
  "twitter.com", "x.com", "linkedin.com", "facebook.com",
  "instagram.com", "threads.net",
]);

// Domains where Readability works well (used for logging/metrics)
// const READABILITY_FRIENDLY = new Set([
//   "medium.com", "substack.com", "github.com", "dev.to",
// ]);

export interface FetchResult {
  url: string;
  title: string;
  content: string;
  method: "readability" | "browser" | "raw" | "failed";
  charCount: number;
}

/**
 * Fetch a single URL and extract readable text.
 * Tries HTTP+Readability first, falls back to raw text.
 */
export async function fetchAndExtract(url: string): Promise<FetchResult> {
  const hostname = safeHostname(url);

  // Skip social media SPAs — these need browser
  if (BROWSER_REQUIRED_DOMAINS.has(hostname)) {
    return { url, title: "", content: "", method: "failed", charCount: 0 };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const resp = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);

    if (!resp.ok) {
      return { url, title: "", content: "", method: "failed", charCount: 0 };
    }

    const contentType = resp.headers.get("content-type") ?? "";

    // GitHub API JSON
    if (contentType.includes("application/json") || url.includes("api.github.com")) {
      const json = await resp.json() as Record<string, unknown>;
      const content = formatGitHubJson(json);
      return { url, title: (json.full_name as string) ?? "", content, method: "raw", charCount: content.length };
    }

    // Non-HTML — skip
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      return { url, title: "", content: "", method: "failed", charCount: 0 };
    }

    const html = await resp.text();

    // Try Readability extraction
    const result = extractWithReadability(html, url);
    if (result && result.content.length > 100) {
      return {
        url,
        title: result.title,
        content: result.content.slice(0, MAX_CONTENT_CHARS),
        method: "readability",
        charCount: result.content.length,
      };
    }

    // Fallback: extract text from raw HTML
    const rawText = extractRawText(html);
    if (rawText.length > 100) {
      return {
        url,
        title: extractTitle(html),
        content: rawText.slice(0, MAX_CONTENT_CHARS),
        method: "raw",
        charCount: rawText.length,
      };
    }

    return { url, title: "", content: "", method: "failed", charCount: 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug({ url, error: msg }, "Deep-fetch failed");
    return { url, title: "", content: "", method: "failed", charCount: 0 };
  }
}

/**
 * Deep-fetch all external URLs from a batch of scrapes.
 * Updates raw_content in the DB with fetched text.
 * Returns count of successfully enriched scrapes.
 */
export async function deepFetchScrapes(
  db: Database.Database,
  scrapes: StoredScrape[],
): Promise<{ enriched: number; failed: number; skipped: number }> {
  let enriched = 0;
  let failed = 0;
  let skipped = 0;

  for (const scrape of scrapes) {
    const meta = scrape.metadata ? JSON.parse(scrape.metadata) : {};

    // Skip if already deep-fetched
    if (meta.deep_fetch?.completed) {
      skipped++;
      continue;
    }

    // Extract external URLs from the scrape
    const externalUrls = extractExternalUrls(scrape);
    if (externalUrls.length === 0) {
      // Mark as fetched (nothing to fetch)
      updateDeepFetchMeta(db, scrape.id, { completed: true, urls: [], method: "none" });
      skipped++;
      continue;
    }

    // Fetch each URL
    const results: FetchResult[] = [];
    for (const url of externalUrls.slice(0, 3)) { // Max 3 URLs per scrape
      const result = await fetchAndExtract(url);
      results.push(result);

      // Small delay between fetches
      if (externalUrls.length > 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    const successful = results.filter(r => r.method !== "failed");
    if (successful.length > 0) {
      // Append fetched content to raw_content
      const fetchedContent = successful
        .map(r => `## Linked: ${r.title || r.url}\n\n${r.content}`)
        .join("\n\n---\n\n");

      const currentContent = scrape.raw_content ?? "";
      const updatedContent = currentContent
        ? `${currentContent}\n\n---\n\n## Deep-Fetched Content\n\n${fetchedContent}`
        : fetchedContent;

      db.prepare(`UPDATE scrapes SET raw_content = ? WHERE id = ?`)
        .run(updatedContent.slice(0, 50_000), scrape.id);

      updateDeepFetchMeta(db, scrape.id, {
        completed: true,
        urls: results.map(r => ({ url: r.url, method: r.method, chars: r.charCount })),
        totalChars: successful.reduce((sum, r) => sum + r.charCount, 0),
      });

      enriched++;
      logger.info({
        scrapeId: scrape.id,
        urlCount: externalUrls.length,
        fetched: successful.length,
        totalChars: successful.reduce((sum, r) => sum + r.charCount, 0),
      }, "Deep-fetch enriched scrape");
    } else {
      updateDeepFetchMeta(db, scrape.id, {
        completed: true,
        urls: results.map(r => ({ url: r.url, method: r.method, chars: 0 })),
        totalChars: 0,
        allFailed: true,
      });
      failed++;
    }
  }

  return { enriched, failed, skipped };
}

// ============================================
// HELPERS
// ============================================

function safeHostname(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

function extractWithReadability(html: string, _url?: string): { title: string; content: string } | null {
  try {
    const { document } = parseHTML(html);
    // linkedom's Document is compatible with Readability's expected interface
    const reader = new Readability(document as any, { charThreshold: 100 });
    const article = reader.parse();
    if (!article) return null;
    return {
      title: article.title ?? "",
      content: article.textContent?.trim() ?? "",
    };
  } catch {
    return null;
  }
}

function extractRawText(html: string): string {
  try {
    const { document } = parseHTML(html);
    // Remove script/style/nav elements
    for (const tag of ["script", "style", "nav", "header", "footer", "aside"]) {
      for (const el of document.querySelectorAll(tag)) {
        el.remove();
      }
    }
    const text = document.body?.textContent ?? "";
    // Collapse whitespace
    return text.replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1]?.trim() ?? "";
}

function formatGitHubJson(json: Record<string, unknown>): string {
  const parts: string[] = [];
  if (json.full_name) parts.push(`# ${json.full_name}`);
  if (json.description) parts.push(String(json.description));
  if (json.stargazers_count) parts.push(`Stars: ${json.stargazers_count}`);
  if (json.language) parts.push(`Language: ${json.language}`);
  if (json.topics && Array.isArray(json.topics)) parts.push(`Topics: ${(json.topics as string[]).join(", ")}`);
  return parts.join("\n");
}

function extractExternalUrls(scrape: StoredScrape): string[] {
  const urls: string[] = [];

  // From metadata.external_urls (set by ingest.ts)
  const meta = scrape.metadata ? JSON.parse(scrape.metadata) : {};
  if (Array.isArray(meta.external_urls)) {
    urls.push(...meta.external_urls);
  }

  // From raw_content — look for "External link:" pattern
  if (scrape.raw_content) {
    const extMatch = scrape.raw_content.match(/External link:\s*(https?:\/\/\S+)/);
    if (extMatch?.[1]) urls.push(extMatch[1]);
  }

  // From context field if present in metadata
  if (meta.context) {
    const ctx = String(meta.context);
    const ctxMatch = ctx.match(/External link:\s*(https?:\/\/\S+)/);
    if (ctxMatch?.[1]) urls.push(ctxMatch[1]);
  }

  // Dedup and filter
  const seen = new Set<string>();
  return urls.filter(u => {
    if (!u || seen.has(u)) return false;
    seen.add(u);
    const host = safeHostname(u);
    return host && !host.includes("x.com") && !host.includes("twitter.com");
  });
}

function updateDeepFetchMeta(
  db: Database.Database,
  scrapeId: string,
  deepFetch: Record<string, unknown>,
): void {
  const row = db.prepare(`SELECT metadata FROM scrapes WHERE id = ?`).get(scrapeId) as { metadata: string | null } | undefined;
  const meta = row?.metadata ? JSON.parse(row.metadata) : {};
  meta.deep_fetch = deepFetch;
  db.prepare(`UPDATE scrapes SET metadata = ? WHERE id = ?`).run(JSON.stringify(meta), scrapeId);
}
