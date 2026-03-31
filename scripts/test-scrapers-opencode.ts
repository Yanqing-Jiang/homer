/**
 * Scraper test using executeBrowserScrape (Claude → Gemini Flash fallback).
 * Tests X bookmarks, Medium trending, and LinkedIn with deep-link extraction.
 *
 * Usage: npx tsx scripts/test-scrapers-opencode.ts
 */

import { executeBrowserScrape } from "../src/executors/browser-scrape.js";
import {
  buildBookmarkScrapePrompt,
  buildMediumForYouScrapePrompt,
  buildLinkedInTopPostPrompt,
} from "../src/scraping/browser-prompts.js";
import { fetchAndExtract } from "../src/scraping/deep-fetch.js";
import { ensureCDP } from "../src/scraping/chrome-launcher.js";
import { writeFileSync, mkdirSync } from "fs";

const OUTPUT_DIR = `${process.env.HOME}/homer/output/scrape-test`;
mkdirSync(OUTPUT_DIR, { recursive: true });

function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s"'<>\])}]+/g;
  return (text.match(urlRegex) || []).filter(u =>
    !u.includes("x.com") && !u.includes("twitter.com") &&
    !u.includes("linkedin.com/in/") && !u.includes("instagram.com") &&
    !u.endsWith(".jpg") && !u.endsWith(".png") && !u.endsWith(".gif")
  );
}

interface Result {
  platform: string;
  success: boolean;
  postCount: number;
  duration: number;
  executor?: string;
  error?: string;
  posts: Array<{ title: string; link?: string; preview: string }>;
  deepLinks: Array<{ url: string; title: string; chars: number; method: string }>;
}

async function scrape(platform: string, prompt: string): Promise<Result> {
  const start = Date.now();
  const result: Result = {
    platform, success: false, postCount: 0, duration: 0, posts: [], deepLinks: [],
  };

  try {
    console.log(`[${platform}] Starting via executeBrowserScrape (Claude → Gemini fallback)...`);
    const r = await executeBrowserScrape(prompt, "", { timeout: 600_000 });

    result.executor = r.executor;
    const output = r.output ?? "";
    const slug = platform.toLowerCase().replace(/[^a-z]+/g, "-");
    writeFileSync(`${OUTPUT_DIR}/${slug}-raw.txt`, output || "(empty)");

    if (r.exitCode !== 0) {
      result.error = `Exit ${r.exitCode} (${r.executor}): ${output.slice(0, 200)}`;
      result.duration = Date.now() - start;
      return result;
    }

    const jsonMatch = output.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      result.error = `No JSON array in output (${output.length} chars, executor: ${r.executor})`;
      result.duration = Date.now() - start;
      return result;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    result.postCount = parsed.length;
    result.success = parsed.length > 0;
    result.posts = parsed.slice(0, 5).map((p: any) => ({
      title: p.title || p.text?.slice(0, 80) || "untitled",
      link: p.link || p.urls?.[0],
      preview: (p.content || p.text || p.first_paragraph || "").slice(0, 150),
    }));

    // Deep-fetch external links
    const allUrls = new Set<string>();
    for (const p of parsed) {
      if (p.link && !p.link.includes("linkedin.com/feed") && !p.link.includes("x.com")) allUrls.add(p.link);
      if (p.urls) for (const u of p.urls) allUrls.add(u);
      for (const u of extractUrls(p.content || p.text || "")) allUrls.add(u);
    }

    const urlsToFetch = [...allUrls].slice(0, 5);
    if (urlsToFetch.length > 0) {
      console.log(`[${platform}] Deep-fetching ${urlsToFetch.length} links...`);
      for (const url of urlsToFetch) {
        const f = await fetchAndExtract(url);
        result.deepLinks.push({ url: f.url, title: f.title, chars: f.charCount, method: f.method });
      }
    }
  } catch (err) {
    result.error = String(err);
  }

  result.duration = Date.now() - start;
  return result;
}

async function main() {
  console.log("=== Scraper Test (executeBrowserScrape: Claude → Gemini Flash) ===\n");

  try {
    const h = await ensureCDP({ headed: true });
    console.log(`Chrome CDP ready (PID ${h.pid})\n`);
  } catch (err) {
    console.error(`Chrome CDP failed: ${err}\n`);
  }

  const [xR, medR, liR] = await Promise.allSettled([
    scrape("X Bookmarks", buildBookmarkScrapePrompt(8)),
    scrape("Medium Trending", buildMediumForYouScrapePrompt(5)),
    scrape("LinkedIn Activity", buildLinkedInTopPostPrompt()),
  ]);

  const results: Result[] = [xR, medR, liR].map((s, i) => {
    const names = ["X Bookmarks", "Medium Trending", "LinkedIn Activity"];
    return s.status === "fulfilled" ? s.value : {
      platform: names[i]!, success: false, postCount: 0, duration: 0,
      error: String(s.reason), posts: [], deepLinks: [],
    };
  });

  const report = results.map(r => {
    const lines = [`## ${r.platform}`,
      `- **Status:** ${r.success ? "SUCCESS" : "FAILED"}`,
      `- **Executor:** ${r.executor || "unknown"}`,
      `- **Posts:** ${r.postCount}`,
      `- **Duration:** ${(r.duration / 1000).toFixed(1)}s`,
    ];
    if (r.error) lines.push(`- **Error:** ${r.error}`);
    if (r.posts.length > 0) {
      lines.push("\n### Posts");
      for (const p of r.posts) lines.push(`- **${p.title}**${p.link ? ` — [link](${p.link})` : ""}\n  > ${p.preview}`);
    }
    if (r.deepLinks.length > 0) {
      lines.push("\n### Deep-Fetched Links");
      for (const dl of r.deepLinks) lines.push(`- [${dl.title || dl.url}](${dl.url}) — ${dl.chars} chars via ${dl.method}`);
    }
    return lines.join("\n");
  }).join("\n\n---\n\n");

  const ts = new Date().toISOString().slice(0, 16).replace(/:/g, "");
  const reportPath = `${OUTPUT_DIR}/browserscrape-test-${ts}.md`;
  writeFileSync(reportPath, `# Browser Scrape Test — ${new Date().toISOString()}\n\n${report}`);

  console.log("\n=== RESULTS ===\n");
  for (const r of results) {
    console.log(`${r.success ? "✓" : "✗"} ${r.platform}: ${r.postCount} posts, ${r.deepLinks.length} deep-links, ${(r.duration / 1000).toFixed(1)}s [${r.executor || "?"}]${r.error ? ` — ${r.error.slice(0, 80)}` : ""}`);
  }
  console.log(`\nReport: ${reportPath}`);
  process.exit(results.every(r => r.success) ? 0 : 1);
}

main().catch(e => { console.error("Fatal:", e); process.exit(2); });
