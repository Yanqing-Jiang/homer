/**
 * Quick test harness for X bookmarks, Medium trending, and LinkedIn scraping.
 * Runs all three in parallel with deep-link content extraction.
 *
 * Usage: npx tsx scripts/test-scrapers.ts
 */

import Database from "better-sqlite3";
import { ensureCDP } from "../src/scraping/chrome-launcher.js";
import { executeClaudeCommand } from "../src/executors/claude.js";
import { executeCodexBrowserScrape } from "../src/executors/codex-browser.js";
import {
  SCRAPE_OPTIONS,
  buildBookmarkScrapePrompt,
  buildMediumForYouScrapePrompt,
  buildLinkedInTopPostPrompt,
} from "../src/scraping/browser-prompts.js";
import { LINKEDIN_CODEX_SKILLS, MEDIUM_CODEX_SKILLS } from "../src/scraping/skill-paths.js";
import { fetchAndExtract } from "../src/scraping/deep-fetch.js";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { PATHS } from "../src/config/paths.js";

const TWITTER_SCRAPE_SKILL_PATH = `${process.env.HOME}/.claude/skills/twitter-scrape/SKILLS.md`;
const OUTPUT_DIR = `${process.env.HOME}/homer/output/scrape-test`;
mkdirSync(OUTPUT_DIR, { recursive: true });

interface ScrapeResult {
  platform: string;
  success: boolean;
  postCount: number;
  duration: number;
  error?: string;
  posts: Array<{ title: string; link?: string; contentPreview: string }>;
  deepLinks: Array<{ url: string; title: string; charCount: number; method: string }>;
}

function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s"'<>\])}]+/g;
  const urls = text.match(urlRegex) || [];
  // Filter out social media SPAs and common non-article URLs
  return urls.filter(u =>
    !u.includes("x.com") && !u.includes("twitter.com") &&
    !u.includes("linkedin.com/in/") && !u.includes("instagram.com") &&
    !u.includes("facebook.com") && !u.includes("threads.net") &&
    !u.endsWith(".jpg") && !u.endsWith(".png") && !u.endsWith(".gif")
  );
}

async function testXBookmarks(): Promise<ScrapeResult> {
  const start = Date.now();
  const result: ScrapeResult = {
    platform: "X Bookmarks",
    success: false,
    postCount: 0,
    duration: 0,
    posts: [],
    deepLinks: [],
  };

  try {
    console.log("[X] Starting bookmark extraction via Claude Sonnet...");
    const skillContent = existsSync(TWITTER_SCRAPE_SKILL_PATH)
      ? readFileSync(TWITTER_SCRAPE_SKILL_PATH, "utf-8")
      : "";

    const prompt = `${skillContent ? `SKILL REFERENCE:\n${skillContent}\n\n` : ""}${buildBookmarkScrapePrompt(8)}`;

    const r = await executeClaudeCommand(prompt, {
      ...SCRAPE_OPTIONS,
      model: "sonnet",
      timeout: 600_000, // 10 min — browser automation is slow
    });

    if (r.exitCode !== 0) {
      result.error = `Exit ${r.exitCode}: ${r.output?.slice(0, 200)}`;
      result.duration = Date.now() - start;
      return result;
    }

    // Parse bookmarks from output
    const output = r.output ?? "";
    const jsonMatch = output.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const bookmarks = JSON.parse(jsonMatch[0]);
        result.postCount = bookmarks.length;
        result.success = bookmarks.length > 0;
        result.posts = bookmarks.slice(0, 5).map((b: any) => ({
          title: b.title || b.text?.slice(0, 80) || "untitled",
          link: b.urls?.[0] || `https://x.com/status/${b.id}`,
          contentPreview: (b.text || b.content || "").slice(0, 150),
        }));

        // Collect external URLs for deep-fetch
        const allUrls = new Set<string>();
        for (const b of bookmarks) {
          if (b.urls) for (const u of b.urls) allUrls.add(u);
          if (b.text) for (const u of extractUrls(b.text)) allUrls.add(u);
        }

        // Deep-fetch up to 5 URLs
        const urlsToFetch = [...allUrls].slice(0, 5);
        console.log(`[X] Deep-fetching ${urlsToFetch.length} external links...`);
        for (const url of urlsToFetch) {
          const fetched = await fetchAndExtract(url);
          result.deepLinks.push({
            url: fetched.url,
            title: fetched.title,
            charCount: fetched.charCount,
            method: fetched.method,
          });
        }
      } catch (e) {
        result.error = `JSON parse failed: ${e}`;
      }
    } else {
      result.error = "No JSON array found in output";
    }
    // Always store raw output for debugging
    writeFileSync(`${OUTPUT_DIR}/x-raw-output.txt`, output || "(empty)");
  } catch (err) {
    result.error = String(err);
  }

  result.duration = Date.now() - start;
  return result;
}

async function testMediumTrending(): Promise<ScrapeResult> {
  const start = Date.now();
  const result: ScrapeResult = {
    platform: "Medium Trending (For You)",
    success: false,
    postCount: 0,
    duration: 0,
    posts: [],
    deepLinks: [],
  };

  try {
    console.log("[Medium] Starting For You feed scrape via Codex browser...");
    const r = await executeCodexBrowserScrape(
      buildMediumForYouScrapePrompt(5),
      { ...SCRAPE_OPTIONS, timeout: 600_000, skillPaths: MEDIUM_CODEX_SKILLS },
    );

    if (r.exitCode !== 0) {
      result.error = `Exit ${r.exitCode}: ${r.output?.slice(0, 200)}`;
      result.duration = Date.now() - start;
      return result;
    }

    const output = r.output ?? "";
    const jsonMatch = output.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const posts = JSON.parse(jsonMatch[0]);
        result.postCount = posts.length;
        result.success = posts.length > 0;
        result.posts = posts.slice(0, 5).map((p: any) => ({
          title: p.title || "untitled",
          link: p.link,
          contentPreview: (p.content || p.first_paragraph || "").slice(0, 150),
        }));

        // Deep-fetch article links
        const articleUrls = posts
          .filter((p: any) => p.link)
          .map((p: any) => p.link)
          .slice(0, 5);
        console.log(`[Medium] Deep-fetching ${articleUrls.length} article links...`);
        for (const url of articleUrls) {
          const fetched = await fetchAndExtract(url);
          result.deepLinks.push({
            url: fetched.url,
            title: fetched.title,
            charCount: fetched.charCount,
            method: fetched.method,
          });
        }
      } catch (e) {
        result.error = `JSON parse failed: ${e}`;
      }
    } else {
      result.error = "No JSON array found in output";
    }
    writeFileSync(`${OUTPUT_DIR}/medium-raw-output.txt`, output || "(empty)");
  } catch (err) {
    result.error = String(err);
  }

  result.duration = Date.now() - start;
  return result;
}

async function testLinkedIn(): Promise<ScrapeResult> {
  const start = Date.now();
  const result: ScrapeResult = {
    platform: "LinkedIn Activity",
    success: false,
    postCount: 0,
    duration: 0,
    posts: [],
    deepLinks: [],
  };

  try {
    console.log("[LinkedIn] Starting activity scrape via Codex browser...");
    const r = await executeCodexBrowserScrape(
      buildLinkedInTopPostPrompt(),
      { ...SCRAPE_OPTIONS, timeout: 600_000, skillPaths: LINKEDIN_CODEX_SKILLS },
    );

    if (r.exitCode !== 0) {
      result.error = `Exit ${r.exitCode}: ${r.output?.slice(0, 200)}`;
      result.duration = Date.now() - start;
      return result;
    }

    const output = r.output ?? "";
    const jsonMatch = output.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const posts = JSON.parse(jsonMatch[0]);
        result.postCount = posts.length;
        result.success = posts.length > 0;
        result.posts = posts.slice(0, 5).map((p: any) => ({
          title: p.title || "untitled",
          link: p.link,
          contentPreview: (p.content || p.first_paragraph || "").slice(0, 150),
        }));

        // Deep-fetch any external links in posts
        const allUrls = new Set<string>();
        for (const p of posts) {
          if (p.link && !p.link.includes("linkedin.com")) allUrls.add(p.link);
          if (p.content) for (const u of extractUrls(p.content)) allUrls.add(u);
        }
        const urlsToFetch = [...allUrls].slice(0, 5);
        if (urlsToFetch.length > 0) {
          console.log(`[LinkedIn] Deep-fetching ${urlsToFetch.length} external links...`);
          for (const url of urlsToFetch) {
            const fetched = await fetchAndExtract(url);
            result.deepLinks.push({
              url: fetched.url,
              title: fetched.title,
              charCount: fetched.charCount,
              method: fetched.method,
            });
          }
        }
      } catch (e) {
        result.error = `JSON parse failed: ${e}`;
      }
    } else {
      result.error = "No JSON array found in output";
    }
    writeFileSync(`${OUTPUT_DIR}/linkedin-raw-output.txt`, output || "(empty)");
  } catch (err) {
    result.error = String(err);
  }

  result.duration = Date.now() - start;
  return result;
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log("=== Scraper Test Harness ===\n");

  // Ensure Chrome is available for browser scraping
  let chromeHandle: { pid: number; cleanup: () => void } | null = null;
  try {
    chromeHandle = await ensureCDP({ headed: true });
    console.log(`Chrome CDP ready (PID ${chromeHandle.pid})\n`);
  } catch (err) {
    console.error(`Chrome CDP failed: ${err}`);
    console.log("Browser-based scrapers (Medium, LinkedIn) may fail.\n");
  }

  // Run all three in parallel
  const [xResult, mediumResult, linkedinResult] = await Promise.allSettled([
    testXBookmarks(),
    testMediumTrending(),
    testLinkedIn(),
  ]);

  const results: ScrapeResult[] = [];

  for (const [name, settled] of [
    ["X Bookmarks", xResult],
    ["Medium Trending", mediumResult],
    ["LinkedIn", linkedinResult],
  ] as const) {
    if (settled.status === "fulfilled") {
      results.push(settled.value);
    } else {
      results.push({
        platform: name,
        success: false,
        postCount: 0,
        duration: 0,
        error: String(settled.reason),
        posts: [],
        deepLinks: [],
      });
    }
  }

  // Write full results to file
  const report = results.map(r => {
    const lines: string[] = [];
    lines.push(`## ${r.platform}`);
    lines.push(`- **Status:** ${r.success ? "SUCCESS" : "FAILED"}`);
    lines.push(`- **Posts found:** ${r.postCount}`);
    lines.push(`- **Duration:** ${(r.duration / 1000).toFixed(1)}s`);
    if (r.error) lines.push(`- **Error:** ${r.error}`);
    if (r.posts.length > 0) {
      lines.push(`\n### Posts`);
      for (const p of r.posts) {
        lines.push(`- **${p.title}**${p.link ? ` — [link](${p.link})` : ""}`);
        lines.push(`  > ${p.contentPreview}`);
      }
    }
    if (r.deepLinks.length > 0) {
      lines.push(`\n### Deep-Fetched Links`);
      for (const dl of r.deepLinks) {
        lines.push(`- [${dl.title || dl.url}](${dl.url}) — ${dl.charCount} chars via ${dl.method}`);
      }
    }
    return lines.join("\n");
  }).join("\n\n---\n\n");

  const fullReport = `# Scraper Test Results — ${new Date().toISOString()}\n\n${report}`;
  const reportPath = `${OUTPUT_DIR}/scrape-test-${new Date().toISOString().slice(0, 16).replace(/:/g, "")}.md`;
  writeFileSync(reportPath, fullReport);

  // Print summary
  console.log("\n=== RESULTS ===\n");
  for (const r of results) {
    const status = r.success ? "✓" : "✗";
    console.log(`${status} ${r.platform}: ${r.postCount} posts, ${r.deepLinks.length} deep-links, ${(r.duration / 1000).toFixed(1)}s${r.error ? ` [${r.error.slice(0, 80)}]` : ""}`);
  }
  console.log(`\nFull report: ${reportPath}`);

  // Cleanup chrome if we started it
  // (Don't cleanup — other scrapers may need it)

  process.exit(results.every(r => r.success) ? 0 : 1);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(2);
});
