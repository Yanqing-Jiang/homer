/**
 * Bi-weekly content scraper for Medium and LinkedIn profiles.
 * Scrapes Yanqing's published posts via RSS (Medium) and browser automation (LinkedIn),
 * diffs against existing corpus, tracks engagement metrics, and captures trending content.
 *
 * Schedule: Monday + Thursday 6am (0 6 * * 1,4)
 *
 * P0 fixes applied from 3-agent swarm review (2026-02-17):
 * - Medium RSS as primary source (browser fallback)
 * - Imperative prompts with CRITICAL RULES + sleep commands
 * - AUTH_REQUIRED / BOT_DETECTED distinct return values
 * - DB-based dedup instead of markdown title matching
 * - cleanAgentOutput pre-processing before JSON parsing
 * - YAML-safe escaping + slug collision handling
 * - db parameter required, upsert metrics
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { createHash } from "crypto";
import type Database from "better-sqlite3";
import { executeOpenCodeCLI } from "../../executors/opencode-cli.js";
import {
  SCRAPE_OPTIONS,
  buildMediumScrapePrompt,
  buildLinkedInScrapePrompt,
} from "../../scraping/browser-prompts.js";
import { cleanAgentOutput } from "../../scraping/clean-output.js";
import type { ParsedIdea } from "../../ideas/parser.js";
import { smartSaveIdea, type SmartSaveResult } from "../../ideas/smart-save.js";
import { logger } from "../../utils/logger.js";

// ============================================
// CONSTANTS
// ============================================

const SCRAPES_DIR = "/Users/yj/memory/scrapes";
const MEDIUM_FILE = `${SCRAPES_DIR}/medium-posts.md`;
const LINKEDIN_FILE = `${SCRAPES_DIR}/linkedin-posts.md`;
const MEDIUM_DIR = `${SCRAPES_DIR}/medium`;
const LINKEDIN_DIR = `${SCRAPES_DIR}/linkedin`;

const RUNS_DIR = `${SCRAPES_DIR}/runs`;
const TRENDING_DIR = `${SCRAPES_DIR}/trending`;
const MEDIUM_TRENDING_FILE = `${SCRAPES_DIR}/medium-trending.md`;
const MEDIUM_TRENDING_DIR = `${TRENDING_DIR}/medium`;

const MEDIUM_RSS_URL = "https://medium.com/feed/@yanqing_j";
const MEDIUM_TAG_RSS_BASE = "https://medium.com/feed/tag";

const MEDIUM_TRENDING_TAGS: Array<{ tag: string; topic: string }> = [
  { tag: "artificial-intelligence", topic: "AI/ML" },
  { tag: "machine-learning", topic: "AI/ML" },
  { tag: "typescript", topic: "TypeScript" },
  { tag: "productivity", topic: "personal automation" },
  { tag: "career", topic: "career development" },
  { tag: "trading", topic: "quant trading" },
  { tag: "writing", topic: "content creation" },
];

const MAX_MEDIUM_TAG_ITEMS = 10;
const MAX_TRENDING_IDEAS_PER_PLATFORM = 4;
const ENABLE_TRENDING_IDEA_PIPELINE = process.env.CONTENT_SCRAPER_IDEA_INGEST !== "0";

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

      const content = sanitizeRssContent(contentEncoded ?? "");
      const dateStr = pubDate ? formatRssDate(pubDate) : undefined;

      items.push({
        title: decodeXmlEntities(title),
        date: dateStr,
        content: content.slice(0, 50_000), // cap at 50K chars
        link: link || undefined,
        source,
        author: creator ? decodeXmlEntities(creator) : undefined,
      });
    }

    logger.info({ count: items.length, url, source }, "Medium RSS parsed successfully");
    return dedupePosts(items);
  } catch (err) {
    logger.warn({ error: String(err), url, source }, "Medium RSS fetch error");
    return [];
  }
}

function sanitizeRssContent(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
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

async function fetchMediumTrendingByTags(): Promise<ScrapedPost[]> {
  const perTag = await Promise.all(
    MEDIUM_TRENDING_TAGS.map(async ({ tag, topic }) => {
      const url = `${MEDIUM_TAG_RSS_BASE}/${encodeURIComponent(tag)}`;
      const posts = await fetchMediumRSSFeed(url, `medium-tag:${tag}`);
      return posts.slice(0, MAX_MEDIUM_TAG_ITEMS).map((p) => ({ ...p, topic }));
    }),
  );

  return dedupePosts(perTag.flat());
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

function yamlEscape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ")
    .replace(/\r/g, "");
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

        return {
          title,
          content,
          link,
          date,
          read_time,
          source,
          topic,
          author,
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

function buildMarkdownCorpus(
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

  const header = `# ${options?.title ?? defaultTitle}\n\n*Scraped from ${options?.sourceUrl ?? defaultUrl}*\n${options?.subtitle ? `*${options.subtitle}*\n` : ""}*Last updated: ${new Date().toISOString().slice(0, 10)}*\n\n---\n`;

  const sections = posts.map((post) => {
    const meta: string[] = [];
    if (post.date) meta.push(`**Date:** ${post.date}`);
    if (post.read_time) meta.push(`**Read time:** ${post.read_time}`);
    if (post.claps != null) meta.push(`**Claps:** ${post.claps}`);
    if (post.reactions != null) meta.push(`**Reactions:** ${post.reactions}`);
    if (post.responses != null) meta.push(`**Responses:** ${post.responses}`);
    if (post.comments != null) meta.push(`**Comments:** ${post.comments}`);
    if (post.author) meta.push(`**Author:** ${post.author}`);
    if (post.topic) meta.push(`**Topic:** ${post.topic}`);
    if (post.source) meta.push(`**Source:** ${post.source}`);
    if (post.link) meta.push(`**Link:** ${post.link}`);

    return `\n## ${post.title}\n${meta.join(" | ")}\n\n${post.content}\n\n---\n`;
  });

  return header + sections.join("");
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

    const filePath = `${dir}/${slug}.md`;
    const newContent = buildPostFile(post, platform);

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

function buildPostFile(post: ScrapedPost, platform: "medium" | "linkedin"): string {
  const frontmatter = [
    "---",
    `title: "${yamlEscape(post.title)}"`,
    `platform: ${platform}`,
    post.date ? `date: "${yamlEscape(post.date)}"` : null,
    post.link ? `link: "${yamlEscape(post.link)}"` : null,
    post.source ? `source: "${yamlEscape(post.source)}"` : null,
    post.topic ? `topic: "${yamlEscape(post.topic)}"` : null,
    post.author ? `author: "${yamlEscape(post.author)}"` : null,
    post.claps != null ? `claps: ${post.claps}` : null,
    post.reactions != null ? `reactions: ${post.reactions}` : null,
    post.comments != null ? `comments: ${post.comments}` : null,
    post.responses != null ? `responses: ${post.responses}` : null,
    "---",
  ].filter(Boolean).join("\n");

  return `${frontmatter}\n\n# ${post.title}\n\n${post.content}\n`;
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
  if (trimmed === "AUTH_REQUIRED" || trimmed.includes("AUTH_REQUIRED")) return "AUTH_REQUIRED";
  if (trimmed === "BOT_DETECTED" || trimmed.includes("BOT_DETECTED")) return "BOT_DETECTED";
  return null;
}

// ============================================
// LINKEDIN FALLBACK + TRENDING
// ============================================

// ============================================
// TRENDING -> IDEAS (OPTIONAL)
// ============================================

function buildTrendingIdea(post: ScrapedPost, platform: "medium" | "linkedin", timestamp: string): ParsedIdea {
  const key = `${platform}:${post.link ?? post.title}:${post.date ?? ""}`;
  const id = `trend_${platform}_${contentHash(key).slice(0, 12)}`;

  const tags = [
    "trending",
    platform,
    "content-scraper",
    ...(post.topic ? [slugify(post.topic).slice(0, 30)] : []),
  ].filter(Boolean);

  const body = [
    `**Platform:** ${platform}`,
    post.topic ? `**Topic:** ${post.topic}` : null,
    post.source ? `**Source:** ${post.source}` : null,
    post.date ? `**Date:** ${post.date}` : null,
    post.link ? `**Link:** ${post.link}` : null,
    "",
    post.content,
  ].filter(Boolean).join("\n");

  return {
    id,
    title: post.title,
    status: "draft",
    source: `${platform}-trending`,
    content: body,
    context: "Captured by content-scraper trending pipeline based on Yanqing's stated writing interests.",
    link: post.link,
    tags,
    timestamp,
  };
}

function ingestTrendingIdeas(posts: ScrapedPost[], platform: "medium" | "linkedin"): SmartSaveResult[] {
  const now = new Date();
  const timestamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;
  const selected = dedupePosts(posts).slice(0, MAX_TRENDING_IDEAS_PER_PLATFORM);
  const results: SmartSaveResult[] = [];

  for (const post of selected) {
    try {
      const parsed = buildTrendingIdea(post, platform, timestamp);
      const saveResult = smartSaveIdea(parsed);
      results.push(saveResult);
    } catch (err) {
      logger.warn({ error: String(err), title: post.title, platform }, "Failed to ingest trending idea");
    }
  }

  return results;
}

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
  const scrapeOpts = { ...SCRAPE_OPTIONS, browserOnly: true, timeout: 900_000 };

  let mediumTrendingPosts: ScrapedPost[] = [];

  // --- Medium scrape (RSS primary, browser fallback) ---
  try {
    logger.info("Starting Medium scrape (RSS primary)");

    // Try RSS first
    let posts = await fetchMediumRSS();

    // Fall back to browser if RSS returns nothing
    if (posts.length === 0) {
      logger.info("RSS returned empty, falling back to browser scrape");
      const mediumResult = await executeOpenCodeCLI(
        buildMediumScrapePrompt(),
        "",
        scrapeOpts,
      );

      if (mediumResult.exitCode === 0 && mediumResult.output) {
        const authStatus = detectAuthOrBot(mediumResult.output);
        if (authStatus) {
          results.push(`Medium: browser scrape blocked — ${authStatus}`);
          logger.warn({ status: authStatus }, "Medium browser scrape blocked");
        } else {
          posts = parseScrapedJSON(mediumResult.output);
        }
      } else {
        results.push(`Medium: browser scrape failed — exit code ${mediumResult.exitCode}`);
        logger.error(
          { exitCode: mediumResult.exitCode, output: mediumResult.output?.slice(0, 300) },
          "Medium browser scrape failed",
        );
      }
    }

    posts = dedupePosts(posts);

    if (posts.length > 0) {
      const newPosts = detectNewPosts(db, posts, "medium");

      // Write full corpus file
      writeFileSync(MEDIUM_FILE, buildMarkdownCorpus(posts, "medium"));

      // Write individual post files
      const written = writeIndividualPosts(posts, MEDIUM_DIR, "medium");

      // Record metrics
      const metrics = recordMetrics(db, posts, "medium", scrapeTime);

      results.push(`Medium: ${posts.length} posts scraped, ${newPosts.length} new, ${written} files updated, ${metrics} metrics recorded`);
      logger.info({ total: posts.length, new: newPosts.length }, "Medium scrape complete");
    } else if (!results.some((r) => r.startsWith("Medium:"))) {
      results.push("Medium: no posts found from RSS or browser scrape");
      logger.warn("Medium scrape returned no posts from any source");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push(`Medium: error — ${msg}`);
    logger.error({ error: msg }, "Medium scrape error");
  }

  // --- Medium trending + LinkedIn own posts in PARALLEL (both independent) ---
  // LinkedIn trending web search dropped — Google doesn't index LinkedIn reliably (always returns 0)
  const [mediumTrendingResult, linkedinResult] = await Promise.allSettled([
    // Medium trending: tag RSS (instant ~1s per tag, all 7 parallel)
    fetchMediumTrendingByTags(),
    // LinkedIn own posts: agent-browser CDP via opencode flash (up to 5min)
    (async () => {
      logger.info("Starting LinkedIn scrape");
      return executeOpenCodeCLI(
        buildLinkedInScrapePrompt(),
        "",
        { ...scrapeOpts, timeout: 300_000 }, // 5 min — agent-browser CDP
      );
    })(),
  ]);

  // Process Medium trending result
  if (mediumTrendingResult.status === "fulfilled") {
    mediumTrendingPosts = mediumTrendingResult.value;
    if (mediumTrendingPosts.length > 0) {
      writeFileSync(
        MEDIUM_TRENDING_FILE,
        buildMarkdownCorpus(mediumTrendingPosts, "medium", {
          title: "Medium Trending Content",
          sourceUrl: "https://medium.com/tag",
          subtitle: `Interest tags: ${MEDIUM_TRENDING_TAGS.map((t) => t.tag).join(", ")}`,
        }),
      );
      const written = writeIndividualPosts(mediumTrendingPosts, MEDIUM_TRENDING_DIR, "medium");
      results.push(`Medium trending: ${mediumTrendingPosts.length} posts scraped from ${MEDIUM_TRENDING_TAGS.length} tags, ${written} files updated`);
    } else {
      results.push("Medium trending: no posts found from tag RSS feeds");
    }
  } else {
    results.push(`Medium trending: error — ${mediumTrendingResult.reason}`);
    logger.error({ error: String(mediumTrendingResult.reason) }, "Medium trending scrape error");
  }

  // Process LinkedIn own posts result
  try {
    let linkedinPosts: ScrapedPost[] = [];
    let linkedInSource = "browser";

    if (linkedinResult.status === "fulfilled") {
      const r = linkedinResult.value;
      if (r.exitCode === 0 && r.output) {
        const authStatus = detectAuthOrBot(r.output);
        if (authStatus) {
          logger.warn({ status: authStatus }, "LinkedIn browser scrape blocked");
          // Skip public fallback — also returns 0 consistently and wastes 3min
          results.push(`LinkedIn: blocked — ${authStatus}`);
        } else {
          linkedinPosts = parseScrapedJSON(r.output);
        }
      } else {
        results.push(`LinkedIn: scrape failed — exit code ${r.exitCode}`);
        logger.error({ exitCode: r.exitCode, output: r.output?.slice(0, 300) }, "LinkedIn scrape failed");
      }
    } else {
      results.push(`LinkedIn: error — ${linkedinResult.reason}`);
      logger.error({ error: String(linkedinResult.reason) }, "LinkedIn scrape error");
    }

    linkedinPosts = dedupePosts(linkedinPosts);

    if (linkedinPosts.length > 0) {
      const newPosts = detectNewPosts(db, linkedinPosts, "linkedin");
      writeFileSync(LINKEDIN_FILE, buildMarkdownCorpus(linkedinPosts, "linkedin"));
      const written = writeIndividualPosts(linkedinPosts, LINKEDIN_DIR, "linkedin");
      const metrics = recordMetrics(db, linkedinPosts, "linkedin", scrapeTime);
      results.push(`LinkedIn: ${linkedinPosts.length} posts scraped (${linkedInSource}), ${newPosts.length} new, ${written} files updated, ${metrics} metrics recorded`);
      logger.info({ total: linkedinPosts.length, new: newPosts.length, source: linkedInSource }, "LinkedIn scrape complete");
    } else if (!results.some((r) => r.startsWith("LinkedIn:"))) {
      results.push("LinkedIn: no posts parsed from scrape output");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push(`LinkedIn: error — ${msg}`);
    logger.error({ error: msg }, "LinkedIn scrape error");
  }

  // --- Optional: trending -> ideas pipeline (Medium only — LinkedIn trending dropped) ---
  if (ENABLE_TRENDING_IDEA_PIPELINE) {
    try {
      const ideaResults = ingestTrendingIdeas(mediumTrendingPosts, "medium");
      const created = ideaResults.filter((r) => r.action === "created").length;
      const enhanced = ideaResults.filter((r) => r.action === "enhanced").length;
      const skipped = ideaResults.filter((r) => r.action === "skipped").length;
      results.push(`Trending ideas: ${created} created, ${enhanced} enhanced, ${skipped} skipped`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push(`Trending ideas: error — ${msg}`);
      logger.error({ error: msg }, "Trending idea ingestion failed");
    }
  } else {
    results.push("Trending ideas: skipped (CONTENT_SCRAPER_IDEA_INGEST=0)");
  }

  // --- Per-run markdown summary artifact ---
  const summaryPath = writeRunSummaryMarkdown(runStartedAt, results);
  if (summaryPath) {
    results.push(`Run summary: ${summaryPath}`);
  } else {
    results.push("Run summary: failed to write markdown artifact");
  }

  const output = results.join("\n");
  const success = results.some((r) => r.includes("scraped"));

  return { success, output, error: success ? undefined : output };
}
