/**
 * Bi-weekly content scraper for Medium and LinkedIn profiles.
 * Scrapes Yanqing's published posts via RSS (Medium) and browser automation (LinkedIn),
 * diffs against existing corpus, and tracks engagement metrics.
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
import { logger } from "../../utils/logger.js";

// ============================================
// CONSTANTS
// ============================================

const SCRAPES_DIR = "/Users/yj/memory/scrapes";
const MEDIUM_FILE = `${SCRAPES_DIR}/medium-posts.md`;
const LINKEDIN_FILE = `${SCRAPES_DIR}/linkedin-posts.md`;
const MEDIUM_DIR = `${SCRAPES_DIR}/medium`;
const LINKEDIN_DIR = `${SCRAPES_DIR}/linkedin`;

const MEDIUM_RSS_URL = "https://medium.com/feed/@yanqing_j";

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
}

// ============================================
// MEDIUM RSS FETCHER (primary source)
// ============================================

async function fetchMediumRSS(): Promise<ScrapedPost[]> {
  try {
    logger.info("Fetching Medium RSS feed");
    const response = await fetch(MEDIUM_RSS_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Homer/1.0; RSS reader)" },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, "Medium RSS fetch failed");
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
      // content:encoded contains full article HTML
      const contentEncoded = extractCdataTag(itemXml, "content:encoded")
        || extractXmlTag(itemXml, "description");

      if (!title) continue;

      // Strip HTML tags for plain text content
      const content = contentEncoded
        ? contentEncoded.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim()
        : "";

      // Parse date to a readable format
      const dateStr = pubDate ? formatRssDate(pubDate) : undefined;

      items.push({
        title: decodeXmlEntities(title),
        date: dateStr,
        content: content.slice(0, 50_000), // cap at 50K chars
        link: link || undefined,
      });
    }

    logger.info({ count: items.length }, "Medium RSS parsed successfully");
    return items;
  } catch (err) {
    logger.warn({ error: String(err) }, "Medium RSS fetch error");
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
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return dateStr;
  }
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
    return parsed.filter((p: unknown) => {
      if (typeof p !== "object" || p === null) return false;
      const obj = p as Record<string, unknown>;
      return (
        typeof obj.title === "string" &&
        obj.title.length > 0 &&
        typeof obj.content === "string" &&
        obj.content.length > 10
      );
    });
  } catch (err) {
    logger.warn(
      { error: String(err), rawPreview: arrayMatch[0].slice(0, 300) },
      "Failed to parse scraped JSON",
    );
    return [];
  }
}

function buildMarkdownCorpus(posts: ScrapedPost[], platform: "medium" | "linkedin"): string {
  const url = platform === "medium"
    ? "https://medium.com/@yanqing_j"
    : "https://www.linkedin.com/in/jiangyanqing/";

  const header = `# ${platform === "medium" ? "Medium" : "LinkedIn"} Posts - Yanqing Jiang\n\n*Scraped from ${url}*\n*Last updated: ${new Date().toISOString().slice(0, 10)}*\n\n---\n`;

  const sections = posts.map((post) => {
    const meta: string[] = [];
    if (post.date) meta.push(`**Date:** ${post.date}`);
    if (post.read_time) meta.push(`**Read time:** ${post.read_time}`);
    if (post.claps != null) meta.push(`**Claps:** ${post.claps}`);
    if (post.reactions != null) meta.push(`**Reactions:** ${post.reactions}`);
    if (post.responses != null) meta.push(`**Responses:** ${post.responses}`);
    if (post.comments != null) meta.push(`**Comments:** ${post.comments}`);
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

    // Only write if content changed
    if (existsSync(filePath)) {
      const existingHash = contentHash(readFileSync(filePath, "utf-8"));
      const newContent = buildPostFile(post, platform);
      if (existingHash === contentHash(newContent)) continue;
      writeFileSync(filePath, newContent);
    } else {
      writeFileSync(filePath, buildPostFile(post, platform));
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
// MAIN
// ============================================

export async function runContentScraper(db: Database.Database): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  const results: string[] = [];
  const scrapeTime = new Date().toISOString();
  const scrapeOpts = { ...SCRAPE_OPTIONS, browserOnly: true, timeout: 900_000 };

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

  // --- LinkedIn scrape (browser only, expect frequent blocking) ---
  try {
    logger.info("Starting LinkedIn scrape");
    const linkedinResult = await executeOpenCodeCLI(
      buildLinkedInScrapePrompt(),
      "",
      { ...scrapeOpts, timeout: 300_000 }, // 5 min — fail fast, LinkedIn blocks often
    );

    if (linkedinResult.exitCode === 0 && linkedinResult.output) {
      const authStatus = detectAuthOrBot(linkedinResult.output);
      if (authStatus) {
        results.push(`LinkedIn: blocked — ${authStatus}`);
        logger.warn({ status: authStatus }, "LinkedIn scrape blocked");
      } else {
        const posts = parseScrapedJSON(linkedinResult.output);

        if (posts.length > 0) {
          const newPosts = detectNewPosts(db, posts, "linkedin");

          writeFileSync(LINKEDIN_FILE, buildMarkdownCorpus(posts, "linkedin"));
          const written = writeIndividualPosts(posts, LINKEDIN_DIR, "linkedin");
          const metrics = recordMetrics(db, posts, "linkedin", scrapeTime);

          results.push(`LinkedIn: ${posts.length} posts scraped, ${newPosts.length} new, ${written} files updated, ${metrics} recorded`);
          logger.info({ total: posts.length, new: newPosts.length }, "LinkedIn scrape complete");
        } else {
          results.push("LinkedIn: no posts parsed from scrape output");
          logger.warn("LinkedIn scrape returned no parseable posts");
        }
      }
    } else {
      results.push(`LinkedIn: scrape failed — exit code ${linkedinResult.exitCode}`);
      logger.error(
        { exitCode: linkedinResult.exitCode, output: linkedinResult.output?.slice(0, 300) },
        "LinkedIn scrape failed",
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push(`LinkedIn: error — ${msg}`);
    logger.error({ error: msg }, "LinkedIn scrape error");
  }

  const output = results.join("\n");
  const success = results.some((r) => r.includes("scraped"));

  return { success, output, error: success ? undefined : output };
}
