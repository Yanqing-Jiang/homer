/**
 * Bi-weekly content scraper for Medium and LinkedIn profiles.
 * Scrapes Yanqing's published posts via RSS (Medium) and browser automation (LinkedIn),
 * diffs against existing corpus, tracks engagement metrics, and captures trending content.
 *
 * Schedule: Monday + Thursday 6am (0 6 * * 1,4)
 *
 * P0 fixes applied from 5-agent swarm review (2026-02-20):
 * - Medium RSS as primary source (browser fallback moved into Phase 2 parallel block)
 * - LinkedIn timeout reduced 300s → 90s; browser prompts: sleep 3→1, scrolls 20→10
 * - Explicit exitCode 4 (timeout) check before detectAuthOrBot — no silent laundering
 * - Telegram alert on AUTH_REQUIRED / BOT_DETECTED
 * - Deep-fetch: LinkedIn "see more" expansion + Medium For You article hook extraction
 * - Heuristic scoring for trending idea selection (replaces positional first-4)
 * - ingestTrendingIdeas() failure logged to results (was silently swallowed)
 * - writeRunSummaryMarkdown() moved to finally block — always runs
 * - Post-scrape pattern analysis: Gemini Flash API extracts content patterns → patterns.md
 * - Browser scraping via Codex GPT-5.4 medium reasoning (agent-browser CDP)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { createHash } from "crypto";
import type Database from "better-sqlite3";
import { executeCodexBrowserScrape } from "../../executors/codex-browser.js";
import { executeGeminiCLIDirect } from "../../executors/gemini-cli.js";
import {
  SCRAPE_OPTIONS,
  buildMediumScrapePrompt,
  buildMediumForYouScrapePrompt,
  buildLinkedInTopPostPrompt,
} from "../../scraping/browser-prompts.js";
import { cleanAgentOutput } from "../../scraping/clean-output.js";
import { htmlToMarkdown, extractDeepLinks, extractImages, type DeepLink, type ImageRef } from "../../scraping/html-to-markdown.js";
import { ensureCDP } from "../../scraping/chrome-launcher.js";
import { insertScrape } from "../../scraping/scrape-store.js";
import { LINKEDIN_CODEX_SKILLS, MEDIUM_CODEX_SKILLS } from "../../scraping/skill-paths.js";
import { StateManager } from "../../state/manager.js";
import { logger } from "../../utils/logger.js";
import { PATHS } from "../../config/paths.js";

const DB_PATH = PATHS.db;

// ============================================
// CONSTANTS
// ============================================

const SCRAPES_DIR = PATHS.scrapes;
const MEDIUM_FILE = `${SCRAPES_DIR}/medium-posts.json`;
const LINKEDIN_FILE = `${SCRAPES_DIR}/linkedin-posts.json`;
const MEDIUM_DIR = `${SCRAPES_DIR}/medium`;
const LINKEDIN_DIR = `${SCRAPES_DIR}/linkedin`;

const RUNS_DIR = `${SCRAPES_DIR}/runs`;
const TRENDING_DIR = `${SCRAPES_DIR}/trending`;
const MEDIUM_TRENDING_FILE = `${SCRAPES_DIR}/medium-trending.json`;
const MEDIUM_TRENDING_DIR = `${TRENDING_DIR}/medium`;

const MEDIUM_RSS_URL = "https://medium.com/feed/@yanqing_j";
// Disabled: Medium trending articles were low-signal clickbait polluting the ideas pipeline.
// Scraping + patterns continue; idea creation skipped. Re-enable with CONTENT_SCRAPER_IDEA_INGEST=1.
const PATTERNS_FILE = PATHS.patterns;

// ============================================
// TYPES
// ============================================

interface ScrapedPost {
  title: string;
  date?: string;
  read_time?: string;
  claps?: number | null;
  responses?: number | null;
  reactions?: number | null;
  comments?: number | null;
  content: string;
  link?: string;
  source?: string;
  author?: string;
  topic?: string;
  first_paragraph?: string;
  hook_analysis?: string;
  access?: string;
  deep_links?: DeepLink[];
  images?: ImageRef[];
}

// ============================================
// MEDIUM RSS FETCHERS
// ============================================

async function fetchMediumRSS(): Promise<ScrapedPost[]> {
  return fetchMediumRSSFeed(MEDIUM_RSS_URL, "medium-profile-rss");
}

async function fetchMediumRSSFeed(url: string, source: string): Promise<ScrapedPost[]> {
  try {
    logger.info({ url, source }, "Fetching Medium RSS feed");
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Homer/1.0; RSS reader)" },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      logger.warn({ status: response.status, url, source }, "Medium RSS fetch failed");
      return [];
    }

    const xml = await response.text();

    // Simple XML parsing — extract <item> blocks
    const items: ScrapedPost[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match: RegExpExecArray | null;

    while ((match = itemRegex.exec(xml)) !== null) {
      const itemXml = match[1]!;

      const title = extractXmlTag(itemXml, "title");
      const link = extractXmlTag(itemXml, "link");
      const pubDate = extractXmlTag(itemXml, "pubDate");
      const creator = extractXmlTag(itemXml, "dc:creator");
      // content:encoded contains full article HTML
      const contentEncoded = extractCdataTag(itemXml, "content:encoded")
        || extractXmlTag(itemXml, "description");

      if (!title) continue;

      const rawHtml = contentEncoded ?? "";
      const content = htmlToMarkdown(rawHtml);
      const deep_links = extractDeepLinks(rawHtml);
      const images = extractImages(rawHtml);
      const dateStr = pubDate ? formatRssDate(pubDate) : undefined;

      items.push({
        title: decodeXmlEntities(title),
        date: dateStr,
        content: content.slice(0, 50_000), // cap at 50K chars
        link: link || undefined,
        source,
        author: creator ? decodeXmlEntities(creator) : undefined,
        deep_links: deep_links.length > 0 ? deep_links : undefined,
        images: images.length > 0 ? images : undefined,
      });
    }

    logger.info({ count: items.length, url, source }, "Medium RSS parsed successfully");
    return dedupePosts(items);
  } catch (err) {
    logger.warn({ error: String(err), url, source }, "Medium RSS fetch error");
    return [];
  }
}

function extractXmlTag(xml: string, tag: string): string | null {
  // Handle both <tag>value</tag> and <tag><![CDATA[value]]></tag>
  const regex = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tag}>`, "i");
  const m = xml.match(regex);
  if (!m) return null;
  return (m[1] ?? m[2] ?? "").trim();
}

function extractCdataTag(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, "i");
  const m = xml.match(regex);
  return m ? m[1]!.trim() : null;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function formatRssDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ============================================
// HELPERS
// ============================================

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/['''\u2018\u2019`]/g, "") // strip apostrophes/quotes before replacing separators
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function normalizeUrl(url: string): string {
  return url
    .trim()
    .replace(/#.*$/, "")
    .replace(/[?&](utm_[^=]+|source|trk|li_fat_id)=[^&]*/gi, "")
    .replace(/[?&]$/, "");
}

function dedupePosts(posts: ScrapedPost[]): ScrapedPost[] {
  const seen = new Set<string>();
  const deduped: ScrapedPost[] = [];

  for (const post of posts) {
    const key = post.link
      ? `url:${normalizeUrl(post.link)}`
      : `text:${slugify(post.title)}:${contentHash(post.content).slice(0, 8)}`;

    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(post);
  }

  return deduped;
}

function parseMetricValue(value: unknown): number | null | undefined {
  if (value == null) return null;

  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value) : null;
  }

  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase().replace(/,/g, "");
  if (!normalized) return null;

  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*([km])?/i);
  if (!match) return null;

  let base = parseFloat(match[1]!);
  if (match[2] === "k") base *= 1_000;
  if (match[2] === "m") base *= 1_000_000;

  return Number.isFinite(base) ? Math.round(base) : null;
}

function parseScrapedJSON(output: string): ScrapedPost[] {
  // Clean agent narration before parsing
  const cleaned = cleanAgentOutput(output);

  // Try to extract JSON array from agent output
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = fenceMatch ? fenceMatch[1]! : cleaned;

  // Find the JSON array
  const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (!arrayMatch) {
    logger.warn({ preview: cleaned.slice(0, 300) }, "No JSON array found in scraped output");
    return [];
  }

  try {
    const parsed = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(parsed)) return [];

    const normalized = parsed
      .map((p: unknown): ScrapedPost | null => {
        if (typeof p !== "object" || p === null) return null;
        const obj = p as Record<string, unknown>;

        if (typeof obj.title !== "string" || typeof obj.content !== "string") return null;
        const title = obj.title.trim();
        const content = obj.content.trim();
        if (!title || content.length <= 10) return null;

        const link = typeof obj.link === "string" && obj.link.trim() ? obj.link.trim() : undefined;
        const date = typeof obj.date === "string" && obj.date.trim() ? obj.date.trim() : undefined;
        const read_time = typeof obj.read_time === "string" && obj.read_time.trim() ? obj.read_time.trim() : undefined;
        const source = typeof obj.source === "string" && obj.source.trim() ? obj.source.trim() : undefined;
        const topic = typeof obj.topic === "string" && obj.topic.trim() ? obj.topic.trim() : undefined;
        const author = typeof obj.author === "string" && obj.author.trim() ? obj.author.trim() : undefined;
        const first_paragraph = typeof obj.first_paragraph === "string" && obj.first_paragraph.trim()
          ? obj.first_paragraph.trim()
          : undefined;
        const hook_analysis = typeof obj.hook_analysis === "string" && obj.hook_analysis.trim()
          ? obj.hook_analysis.trim()
          : undefined;
        const access = typeof obj.access === "string" && obj.access.trim() ? obj.access.trim() : undefined;

        return {
          title,
          content,
          link,
          date,
          read_time,
          source,
          topic,
          author,
          first_paragraph,
          hook_analysis,
          access,
          claps: parseMetricValue(obj.claps),
          responses: parseMetricValue(obj.responses),
          reactions: parseMetricValue(obj.reactions),
          comments: parseMetricValue(obj.comments),
        };
      })
      .filter((p): p is ScrapedPost => p !== null);

    return dedupePosts(normalized);
  } catch (err) {
    logger.warn(
      { error: String(err), rawPreview: arrayMatch[0].slice(0, 300) },
      "Failed to parse scraped JSON",
    );
    return [];
  }
}

function buildJsonCorpus(
  posts: ScrapedPost[],
  platform: "medium" | "linkedin",
  options?: {
    title?: string;
    sourceUrl?: string;
    subtitle?: string;
  },
): string {
  const defaultUrl = platform === "medium"
    ? "https://medium.com/@yanqing_j"
    : "https://www.linkedin.com/in/jiangyanqing/";
  const defaultTitle = platform === "medium" ? "Medium Posts - Yanqing Jiang" : "LinkedIn Posts - Yanqing Jiang";

  const corpus = {
    title: options?.title ?? defaultTitle,
    platform,
    source_url: options?.sourceUrl ?? defaultUrl,
    subtitle: options?.subtitle ?? undefined,
    last_updated: new Date().toISOString().slice(0, 10),
    count: posts.length,
    posts: posts.map((post) => buildPostObject(post, platform)),
  };

  return JSON.stringify(corpus, null, 2);
}

function buildPostObject(post: ScrapedPost, platform: "medium" | "linkedin"): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    title: post.title,
    platform,
  };
  if (post.date) obj.date = post.date;
  if (post.author) obj.author = post.author;
  if (post.source) obj.source = post.source;
  if (post.link) obj.link = post.link;
  if (post.topic) obj.topic = post.topic;
  if (post.read_time) obj.read_time = post.read_time;
  if (post.first_paragraph) obj.first_paragraph = post.first_paragraph;
  if (post.hook_analysis) obj.hook_analysis = post.hook_analysis;
  if (post.access) obj.access = post.access;
  if (post.claps != null) obj.claps = post.claps;
  if (post.reactions != null) obj.reactions = post.reactions;
  if (post.responses != null) obj.responses = post.responses;
  if (post.comments != null) obj.comments = post.comments;
  obj.content = post.content;
  if (post.deep_links && post.deep_links.length > 0) obj.deep_links = post.deep_links;
  if (post.images && post.images.length > 0) obj.images = post.images;
  return obj;
}

function writeIndividualPosts(posts: ScrapedPost[], dir: string, platform: "medium" | "linkedin"): number {
  mkdirSync(dir, { recursive: true });
  let written = 0;
  const usedSlugs = new Set<string>();

  for (const post of posts) {
    let slug = slugify(post.title);
    if (!slug) continue;

    // Handle slug collisions
    if (usedSlugs.has(slug)) {
      slug = `${slug}-${contentHash(post.content).slice(0, 6)}`;
    }
    usedSlugs.add(slug);

    const filePath = `${dir}/${slug}.json`;
    const newContent = JSON.stringify(buildPostObject(post, platform), null, 2);

    // Only write if content changed
    if (existsSync(filePath)) {
      const existingHash = contentHash(readFileSync(filePath, "utf-8"));
      if (existingHash === contentHash(newContent)) continue;
      writeFileSync(filePath, newContent);
    } else {
      writeFileSync(filePath, newContent);
    }

    written++;
  }

  return written;
}

function recordMetrics(
  db: Database.Database,
  posts: ScrapedPost[],
  platform: "medium" | "linkedin",
  scrapeTime: string,
): number {
  const upsert = db.prepare(`
    INSERT INTO content_metrics (platform, post_slug, title, published_at, claps, reads, responses, reactions, comments, raw_content_hash, scraped_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, post_slug, scraped_at) DO UPDATE SET
      title = excluded.title,
      claps = excluded.claps,
      reactions = excluded.reactions,
      comments = excluded.comments,
      responses = excluded.responses,
      raw_content_hash = excluded.raw_content_hash
  `);

  let recorded = 0;

  for (const post of posts) {
    const slug = slugify(post.title);
    if (!slug) continue;

    try {
      upsert.run(
        platform,
        slug,
        post.title,
        post.date || null,
        post.claps ?? null,
        null, // reads not available from scrape
        post.responses ?? null,
        post.reactions ?? null,
        post.comments ?? null,
        contentHash(post.content),
        scrapeTime,
      );
      recorded++;
    } catch (err) {
      logger.warn({ err, slug, platform }, "Failed to record metric");
    }
  }

  return recorded;
}

function detectNewPosts(db: Database.Database, posts: ScrapedPost[], platform: string): ScrapedPost[] {
  const rows = db
    .prepare("SELECT DISTINCT post_slug FROM content_metrics WHERE platform = ?")
    .all(platform) as Array<{ post_slug: string }>;
  const existingSlugs = new Set(rows.map((r) => r.post_slug));

  return posts.filter((p) => {
    const slug = slugify(p.title);
    return slug.length > 0 && !existingSlugs.has(slug);
  });
}

// ============================================
// AUTH / BOT DETECTION
// ============================================

function detectAuthOrBot(output: string): "AUTH_REQUIRED" | "BOT_DETECTED" | null {
  const trimmed = output.trim();
  // Exact match or sentinel as first line (agent returned only the sentinel)
  if (trimmed === "AUTH_REQUIRED" || trimmed.startsWith("AUTH_REQUIRED\n")) return "AUTH_REQUIRED";
  if (trimmed === "BOT_DETECTED" || trimmed.startsWith("BOT_DETECTED\n")) return "BOT_DETECTED";
  // Short response containing the sentinel — avoids false-positives on long scraped content
  if (trimmed.length < 300 && trimmed.includes("AUTH_REQUIRED")) return "AUTH_REQUIRED";
  if (trimmed.length < 300 && trimmed.includes("BOT_DETECTED")) return "BOT_DETECTED";
  return null;
}

// ============================================
// TELEGRAM ALERT (best-effort)
// ============================================

async function sendScraperAlert(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `🔴 Content Scraper: ${message}` }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status }, "Telegram alert failed");
    }
  } catch {
    // best-effort — never crash the scraper for a notification failure
  }
}

// ============================================
// TRENDING IDEA SCORING
// ============================================

/**
 * Heuristic relevance scorer for trending posts.
 * Biases toward Yanqing's interests: AI agents, quant, TypeScript, building tools.
 * Penalizes generic clickbait.
 */
function scoreTrendingPost(post: ScrapedPost): number {
  const text = `${post.title} ${post.content ?? ""}`.toLowerCase();
  let score = 5; // base

  // Positive signals
  if (/\bagent\b|\bagentic\b|\bai agent/.test(text)) score += 3;
  if (/\bquant\b|\balgorithm\b|\bbacktest\b|\btrading\b/.test(text)) score += 2;
  if (/\btypescript\b|\bnode\.js\b|\bdeno\b/.test(text)) score += 1;
  if (/\bbuilding\b|\bopen.source\b|\barchitect/.test(text)) score += 1;
  if (/\bllm\b|\blarge language\b|\bgpt\b|\bclaude\b/.test(text)) score += 1;
  if ((post.claps ?? 0) > 500) score += 2;
  else if ((post.claps ?? 0) > 100) score += 1;

  // Negative signals (clickbait / off-topic)
  if (/chatgpt tips|\d+ tools|\d+ ways|you should never|beginner guide|mindset/.test(text)) score -= 3;
  if (/marketing|social media manager|seo tips|influencer|personal brand/.test(text)) score -= 2;
  if (/motivat|inspir|hustle|grind/.test(text)) score -= 1;

  return Math.max(0, score);
}

// ============================================
// DEEP FETCH (article full text)
// ============================================

// ============================================
// POST-SCRAPE PATTERN ANALYSIS
// ============================================

/**
 * Analyze scraped content with Gemini Flash and extract content patterns.
 * Appends discovered patterns to ~/memory/patterns.md.
 */
type ViralityPlatform = "medium" | "linkedin" | "x";

interface ViralityPattern {
  platform: ViralityPlatform;
  hookType: string;
  structure: string;
  emotionalTrigger: string;
  engagementSignal: string;
  pattern: string;
  evidence: string;
}

function stripCodeFence(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (m?.[1] ?? t).trim();
}

function escCell(v: string): string {
  return v.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
}

/** Ensure patterns.md has the required platform H2 sections + table headers. */
function ensurePatternSchema(md: string): string {
  let out = md.trim() || "# Content Virality Patterns\n\nAuto-maintained.\n";
  const TABLE_HEADER = "| hook_type | structure | emotional_trigger | engagement_signal | pattern |\n|---|---|---|---|---|";
  for (const platform of ["medium", "linkedin", "x"] as const) {
    if (!new RegExp(`^##\\s+${platform}\\b`, "im").test(out)) {
      out += `\n\n## ${platform}\n${TABLE_HEADER}\n`;
    }
  }
  if (!/^##\s+cross-platform/im.test(out)) {
    out += `\n\n## cross-platform\n`;
  }
  return out.endsWith("\n") ? out : `${out}\n`;
}

/** Upsert new rows into the platform's table section, deduplicating by row content. */
function upsertRows(md: string, platform: ViralityPlatform, rows: ViralityPattern[]): { markdown: string; added: number } {
  if (rows.length === 0) return { markdown: md, added: 0 };

  const re = new RegExp(`(^##\\s+${platform}\\b[\\s\\S]*?)(?=^##\\s+|\\z)`, "im");
  const match = md.match(re);
  if (!match) return { markdown: md, added: 0 };

  const section = match[1] ?? "";
  const existing = new Set(
    section
      .split("\n")
      .filter(l => l.startsWith("|") && !l.includes("---") && !/hook_type/i.test(l))
      .map(l => l.toLowerCase().replace(/\s+/g, " ").trim()),
  );

  const newLines: string[] = [];
  for (const row of rows) {
    const line = `| ${escCell(row.hookType)} | ${escCell(row.structure)} | ${escCell(row.emotionalTrigger)} | ${escCell(row.engagementSignal)} | ${escCell(row.pattern)} |`;
    const key = line.toLowerCase().replace(/\s+/g, " ").trim();
    if (!existing.has(key)) {
      existing.add(key);
      newLines.push(line);
    }
  }

  if (newLines.length === 0) return { markdown: md, added: 0 };
  const updated = `${section.trimEnd()}\n${newLines.join("\n")}\n`;
  return { markdown: md.replace(section, updated), added: newLines.length };
}

function buildViralityPrompt(digest: string): string {
  return `You are extracting PLATFORM-SPECIFIC virality patterns from scraped content.

INPUT:
${digest.slice(0, 45_000)}

TASK:
Extract 2-4 patterns per platform (medium, linkedin, x) when evidence exists.
Each pattern must include:
- platform: "medium" | "linkedin" | "x"
- hookType: opening angle (e.g., contrarian claim, personal failure, prediction)
- structure: content flow/template in arrow notation
- emotionalTrigger: dominant emotion(s) driving engagement
- engagementSignal: what engagement behavior this pattern tends to trigger
- pattern: concise reusable pattern statement (1-2 sentences)
- evidence: short quote/snippet/title from the input

RULES:
- Platform-specific: do not collapse into "general" patterns.
- Evidence-backed only; if weak evidence, skip.
- No generic filler ("AI is growing", "people like stories").
- Prefer patterns useful for drafting future posts.
- Focus on: AI agents, quant trading, TypeScript, content creation, career in tech.

OUTPUT:
Return ONLY a valid JSON array, no markdown, no commentary.
Example shape:
[{"platform":"medium","hookType":"...","structure":"...","emotionalTrigger":"...","engagementSignal":"...","pattern":"...","evidence":"..."}]`;
}

async function analyzeAndUpdatePatterns(
  ownPosts: ScrapedPost[],
  linkedinPosts: ScrapedPost[],
  trendingPosts: ScrapedPost[],
): Promise<{ message: string; patternsAdded: number }> {
  if (ownPosts.length === 0 && linkedinPosts.length === 0 && trendingPosts.length === 0) {
    return { message: "patterns: no content to analyze", patternsAdded: 0 };
  }

  const pack = (platform: string, posts: ScrapedPost[]) =>
    posts.slice(0, 15).map(p => `[${platform}] "${p.title}" — ${(p.content ?? "").slice(0, 700)}`).join("\n\n");

  const digest = [
    ownPosts.length > 0 ? `## medium\n${pack("medium", ownPosts)}` : "",
    linkedinPosts.length > 0 ? `## linkedin\n${pack("linkedin", linkedinPosts)}` : "",
    trendingPosts.length > 0 ? `## medium (trending)\n${pack("medium", trendingPosts.slice(0, 10))}` : "",
  ].filter(Boolean).join("\n\n");

  const prompt = buildViralityPrompt(digest);

  try {
    const result = await executeGeminiCLIDirect(prompt, {
      timeout: 120_000,
    });

    if (result.exitCode !== 0 || !result.output?.trim()) {
      return { message: "patterns: no new patterns found", patternsAdded: 0 };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFence(result.output));
    } catch {
      return { message: "patterns: model output not valid JSON", patternsAdded: 0 };
    }

    const rows = (Array.isArray(parsed) ? parsed : [])
      .map((r): ViralityPattern | null => {
        if (!r || typeof r !== "object") return null;
        const x = r as Record<string, unknown>;
        const platform = x.platform;
        if (platform !== "medium" && platform !== "linkedin" && platform !== "x") return null;
        const row: ViralityPattern = {
          platform,
          hookType: String(x.hookType ?? "").trim(),
          structure: String(x.structure ?? "").trim(),
          emotionalTrigger: String(x.emotionalTrigger ?? "").trim(),
          engagementSignal: String(x.engagementSignal ?? "").trim(),
          pattern: String(x.pattern ?? "").trim(),
          evidence: String(x.evidence ?? "").trim(),
        };
        if (!row.hookType || !row.structure || !row.pattern) return null;
        return row;
      })
      .filter((x): x is ViralityPattern => x !== null);

    if (rows.length === 0) return { message: "patterns: no valid patterns extracted", patternsAdded: 0 };

    let md = existsSync(PATTERNS_FILE) ? readFileSync(PATTERNS_FILE, "utf-8") : "";
    md = ensurePatternSchema(md);

    let added = 0;
    for (const platform of ["medium", "linkedin", "x"] as const) {
      const platformRows = rows.filter(r => r.platform === platform);
      const updated = upsertRows(md, platform, platformRows);
      md = updated.markdown;
      added += updated.added;
    }

    if (added > 0) writeFileSync(PATTERNS_FILE, md, "utf-8");
    logger.info({ count: added }, "Upserted new virality patterns to patterns.md");
    return { message: `patterns: ${added} new`, patternsAdded: added };
  } catch (err) {
    logger.warn({ error: String(err) }, "Pattern analysis failed");
    return { message: `patterns: analysis failed — ${String(err).slice(0, 100)}`, patternsAdded: 0 };
  }
}

// ============================================
// TRENDING -> IDEAS (OPTIONAL)
// ============================================

// ============================================
// RUN SUMMARY OUTPUT
// ============================================

function formatRunTimestamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, "")}`;
}

function writeRunSummaryMarkdown(runStartedAt: Date, lines: string[]): string | null {
  try {
    mkdirSync(RUNS_DIR, { recursive: true });
    const filePath = `${RUNS_DIR}/content-scrape-run-${formatRunTimestamp(runStartedAt)}.md`;
    const finishedAt = new Date().toISOString();

    const content = [
      "# Content Scraper Run Summary",
      "",
      `- Started at: ${runStartedAt.toISOString()}`,
      `- Finished at: ${finishedAt}`,
      "",
      "## Results",
      "",
      ...lines.map((line) => `- ${line}`),
      "",
    ].join("\n");

    writeFileSync(filePath, content);
    return filePath;
  } catch (err) {
    logger.warn({ error: String(err) }, "Failed to write run summary markdown");
    return null;
  }
}

// ============================================
// MAIN
// ============================================

export async function runContentScraper(db: Database.Database): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  const results: string[] = [];
  const runStartedAt = new Date();
  const scrapeTime = runStartedAt.toISOString();
  const scrapeOpts = { ...SCRAPE_OPTIONS };

  // Track scraped content for post-scrape analysis
  let ownMediumPosts: ScrapedPost[] = [];
  let ownLinkedInPosts: ScrapedPost[] = [];
  let mediumTrendingPosts: ScrapedPost[] = [];
  let scrapeSucceeded = false;
  let chromeHandle: { pid: number; cleanup: () => void } | null = null;

  try {
    // Ensure Chrome CDP is available for browser-based scraping
    try {
      chromeHandle = await ensureCDP();
      logger.info({ pid: chromeHandle.pid }, "Chrome CDP ready for content scraper");
    } catch (err) {
      logger.warn({ error: String(err) }, "Chrome CDP launch failed — browser scrapes may fail");
    }

    // =========================================================
    // PHASE 0: Pre-write snapshots of files we're about to overwrite
    // =========================================================
    try {
      const sm = new StateManager(DB_PATH);
      try {
        const filesToSnapshot = [MEDIUM_FILE, LINKEDIN_FILE, MEDIUM_TRENDING_FILE, PATTERNS_FILE];
        for (const filePath of filesToSnapshot) {
          if (existsSync(filePath)) {
            const content = readFileSync(filePath, "utf-8");
            const fileName = filePath.split("/").pop()!;
            sm.snapshotMemoryFile(fileName, content, "pre-content-scraper");
          }
        }
        logger.info("Pre-scrape snapshots saved");
      } finally {
        sm.close();
      }
    } catch (err) {
      logger.warn({ error: String(err) }, "Pre-scrape snapshot failed (non-fatal)");
    }

    // =========================================================
    // PHASE 1 + 2: All sources in parallel
    //   - Medium RSS (fast, ~2s)
    //   - Medium RSS fallback browser scrape (only if RSS empty)
    //   - Medium For You feed via Codex browser automation
    //   - LinkedIn activity via Codex browser automation
    // =========================================================

    logger.info("Starting Medium RSS scrape");
    const rssPostsRaw = await fetchMediumRSS();
    logger.info({ count: rssPostsRaw.length }, "Medium RSS complete");

    // Phase 2: parallel — Medium For You + LinkedIn + optional Medium browser fallback
    const [mediumFallbackResult, mediumTrendingResult, linkedinResult] = await Promise.allSettled([
      // Medium browser fallback (only if RSS was empty)
      rssPostsRaw.length > 0
        ? Promise.resolve(null)
        : (async () => {
            logger.info("Medium RSS empty — launching browser fallback in parallel");
            return executeCodexBrowserScrape(
              buildMediumScrapePrompt(),
              { ...scrapeOpts, timeout: 120_000, skillPaths: MEDIUM_CODEX_SKILLS },
            );
          })(),
      // Medium For You: signed-in browser feed via Codex
      (async () => {
        logger.info("Starting Medium For You scrape");
        return executeCodexBrowserScrape(
          buildMediumForYouScrapePrompt(5),
          { ...scrapeOpts, timeout: 300_000, skillPaths: MEDIUM_CODEX_SKILLS },
        );
      })(),
      // LinkedIn: signed-in browser activity via Codex
      (async () => {
        logger.info("Starting LinkedIn scrape");
        return executeCodexBrowserScrape(
          buildLinkedInTopPostPrompt(),
          { ...scrapeOpts, timeout: 300_000, skillPaths: LINKEDIN_CODEX_SKILLS },
        );
      })(),
    ]);

    // =========================================================
    // Process Medium own posts (RSS + optional browser fallback)
    // =========================================================
    try {
      let mediumPosts = rssPostsRaw;

      if (mediumPosts.length === 0 && mediumFallbackResult.status === "fulfilled" && mediumFallbackResult.value) {
        const r = mediumFallbackResult.value;
        if (r.exitCode === 4) {
          results.push("Medium: browser fallback TIMEOUT — no posts");
        } else if (r.exitCode === 0 && r.output) {
          const authStatus = detectAuthOrBot(r.output);
          if (authStatus) {
            results.push(`Medium: browser scrape blocked — ${authStatus}`);
            logger.warn({ status: authStatus }, "Medium browser scrape blocked");
            writeFileSync(MEDIUM_FILE, `# Medium Posts — ${new Date().toISOString().slice(0, 10)}\n\nStatus: ${authStatus}\nLast attempted: ${new Date().toISOString()}\n`);
            void sendScraperAlert(`Medium browser ${authStatus} — session may need refresh`);
          } else {
            mediumPosts = parseScrapedJSON(r.output);
          }
        } else if (r.exitCode !== 0) {
          results.push(`Medium: browser scrape failed — exit code ${r.exitCode}`);
        }
      } else if (mediumFallbackResult.status === "rejected") {
        results.push(`Medium: browser fallback error — ${mediumFallbackResult.reason}`);
      }

      mediumPosts = dedupePosts(mediumPosts);

      if (mediumPosts.length > 0) {
        ownMediumPosts = mediumPosts;
        const newPosts = detectNewPosts(db, mediumPosts, "medium");
        writeFileSync(MEDIUM_FILE, buildJsonCorpus(mediumPosts, "medium"));
        const written = writeIndividualPosts(mediumPosts, MEDIUM_DIR, "medium");
        const metrics = recordMetrics(db, mediumPosts, "medium", scrapeTime);
        results.push(`Medium: ${mediumPosts.length} posts scraped, ${newPosts.length} new, ${written} files updated, ${metrics} metrics recorded`);
        scrapeSucceeded = true;
        logger.info({ total: mediumPosts.length, new: newPosts.length }, "Medium scrape complete");
      } else if (!results.some((r) => r.startsWith("Medium:"))) {
        results.push("Medium: no posts found from RSS or browser");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push(`Medium: error — ${msg}`);
      logger.error({ error: msg }, "Medium processing error");
    }

    // =========================================================
    // Process Medium For You recommendations
    // =========================================================
    try {
      if (mediumTrendingResult.status === "fulfilled") {
        const r = mediumTrendingResult.value;
        if (r.exitCode === 4) {
          results.push(`Medium For You: TIMEOUT after ${r.duration}ms`);
          logger.error({ duration: r.duration }, "Medium For You scrape timed out");
        } else if (r.exitCode === 0 && r.output) {
          const trendingPosts = parseScrapedJSON(r.output);
          if (trendingPosts.length > 0) {
            mediumTrendingPosts = trendingPosts;

            let trendingScrapes = 0;
            for (const post of trendingPosts) {
              const key = `med_${slugify(post.title).slice(0, 30)}_${contentHash(post.content).slice(0, 8)}`;
              const inserted = insertScrape(db, {
                id: key,
                source: "medium-trending",
                url: post.link,
                title: post.title,
                author: post.author,
                raw_content: post.content,
                metadata: JSON.stringify({
                  topic: post.topic,
                  first_paragraph: post.first_paragraph,
                  hook_analysis: post.hook_analysis,
                  access: post.access,
                  claps: post.claps,
                  score: scoreTrendingPost(post),
                }),
              });
              if (inserted) trendingScrapes++;
            }
            if (trendingScrapes > 0) {
              logger.info({ count: trendingScrapes }, "Wrote Medium For You posts to scrapes table");
            }

            writeFileSync(
              MEDIUM_TRENDING_FILE,
              buildJsonCorpus(trendingPosts, "medium", {
                title: "Medium For You Content",
                sourceUrl: "https://medium.com/",
                subtitle: "Signed-in For you feed via Codex + CDP",
              }),
            );
            const written = writeIndividualPosts(trendingPosts, MEDIUM_TRENDING_DIR, "medium");
            results.push(`Medium For You: ${trendingPosts.length} articles scraped, ${written} files updated`);
          } else {
            results.push("Medium For You: no articles parsed from scrape output");
          }
        } else if (r.exitCode !== 0) {
          results.push(`Medium For You: scrape failed — exit code ${r.exitCode}`);
          logger.error({ exitCode: r.exitCode, output: r.output?.slice(0, 300) }, "Medium For You scrape failed");
        }
      } else {
        results.push(`Medium For You: error — ${mediumTrendingResult.reason}`);
        logger.error({ error: String(mediumTrendingResult.reason) }, "Medium For You error");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push(`Medium For You: error — ${msg}`);
    }

    // =========================================================
    // Process LinkedIn posts
    // =========================================================
    try {
      let linkedinPosts: ScrapedPost[] = [];

      if (linkedinResult.status === "fulfilled") {
        const r = linkedinResult.value;
        // Explicit timeout check — exitCode 4 = infrastructure failure, not empty result
        if (r.exitCode === 4) {
          results.push(`LinkedIn: TIMEOUT after ${r.duration}ms — agent-browser may be stalled`);
          logger.error({ duration: r.duration }, "LinkedIn scrape timed out");
        } else if (r.exitCode === 0 && r.output) {
          const authStatus = detectAuthOrBot(r.output);
          if (authStatus) {
            results.push(`LinkedIn: blocked — ${authStatus}`);
            logger.warn({ status: authStatus }, "LinkedIn auth wall");
            // Write tombstone so stale file doesn't appear current
            writeFileSync(LINKEDIN_FILE, `# LinkedIn Posts — ${new Date().toISOString().slice(0, 10)}\n\nStatus: ${authStatus}\nLast attempted: ${new Date().toISOString()}\n`);
            void sendScraperAlert(`LinkedIn ${authStatus} — session may need refresh`);
          } else {
            linkedinPosts = parseScrapedJSON(r.output);
          }
        } else if (r.exitCode !== 0) {
          results.push(`LinkedIn: scrape failed — exit code ${r.exitCode}`);
          logger.error({ exitCode: r.exitCode, output: r.output?.slice(0, 300) }, "LinkedIn scrape failed");
        }
      } else {
        results.push(`LinkedIn: error — ${linkedinResult.reason}`);
        logger.error({ error: String(linkedinResult.reason) }, "LinkedIn scrape error");
      }

      linkedinPosts = dedupePosts(linkedinPosts);

      if (linkedinPosts.length > 0) {
        ownLinkedInPosts = linkedinPosts;
        const newPosts = detectNewPosts(db, linkedinPosts, "linkedin");
        writeFileSync(LINKEDIN_FILE, buildJsonCorpus(linkedinPosts, "linkedin"));
        const written = writeIndividualPosts(linkedinPosts, LINKEDIN_DIR, "linkedin");
        const metrics = recordMetrics(db, linkedinPosts, "linkedin", scrapeTime);
        results.push(`LinkedIn: ${linkedinPosts.length} top post scraped via Codex, ${newPosts.length} new, ${written} files updated, ${metrics} metrics recorded`);
        scrapeSucceeded = true;
        logger.info({ total: linkedinPosts.length, new: newPosts.length }, "LinkedIn scrape complete");
      } else if (!results.some((r) => r.startsWith("LinkedIn:"))) {
        results.push("LinkedIn: no posts parsed from scrape output");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push(`LinkedIn: error — ${msg}`);
      logger.error({ error: msg }, "LinkedIn processing error");
    }

    // PHASE 3a: Trending idea creation now handled by idea-synthesizer (reads from scrapes table)
    results.push("Trending ideas: deferred to idea-synthesizer");

    // =========================================================
    // PHASE 3b: Post-scrape pattern analysis → patterns.md
    // =========================================================
    try {
      const patternResult = await analyzeAndUpdatePatterns(
        ownMediumPosts,
        ownLinkedInPosts,
        mediumTrendingPosts,
      );
      results.push(patternResult.message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push(`patterns: error — ${msg}`);
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push(`FATAL ERROR: ${msg}`);
    logger.error({ error: msg }, "Content scraper fatal error");
  } finally {
    // Clean up Chrome CDP if we launched it
    if (chromeHandle && chromeHandle.pid > 0) {
      chromeHandle.cleanup();
      logger.debug("Chrome CDP cleaned up");
    }

    // =========================================================
    // PHASE 4: Run summary — ALWAYS written (finally block)
    // =========================================================
    const summaryPath = writeRunSummaryMarkdown(runStartedAt, results);
    if (summaryPath) {
      results.push(`Run summary: ${summaryPath}`);
    } else {
      results.push("Run summary: failed to write markdown artifact");
    }
  }

  const output = results.join("\n");
  return { success: scrapeSucceeded, output, error: scrapeSucceeded ? undefined : output };
}
