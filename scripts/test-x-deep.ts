/**
 * X bookmark deep scrape via executeBrowserScrape (Claude → Gemini Flash).
 * Step 1: Scrape bookmark list
 * Step 2: Click into each bookmark to read full thread
 * Step 3: Deep-fetch external URLs via Readability
 */

import { executeBrowserScrape } from "../src/executors/browser-scrape.js";
import { buildBookmarkScrapePrompt, buildTweetReadPrompt, BOOKMARK_JSON_START, BOOKMARK_JSON_END } from "../src/scraping/browser-prompts.js";
import { fetchAndExtract } from "../src/scraping/deep-fetch.js";
import { ensureCDP } from "../src/scraping/chrome-launcher.js";
import { writeFileSync, mkdirSync } from "fs";

const OUT = `${process.env.HOME}/homer/output/scrape-test`;
mkdirSync(OUT, { recursive: true });

interface Bookmark {
  id: string;
  author: string;
  url: string;
  text: string;
  external_urls: string[];
}

async function main() {
  await ensureCDP({ headed: true });

  // ── Step 1: Scrape bookmark list ──
  console.log("Step 1: Scraping bookmark list via executeBrowserScrape...");
  const listResult = await executeBrowserScrape(buildBookmarkScrapePrompt(8), "", { timeout: 600_000 });
  console.log(`  Executor: ${listResult.executor} | Exit: ${listResult.exitCode} | ${(listResult.output || "").length} chars`);

  if (listResult.exitCode !== 0) {
    console.error("Bookmark list scrape failed:", (listResult.output || "").slice(0, 300));
    process.exit(1);
  }

  // Parse bookmarks from marker-wrapped JSON
  const output = listResult.output || "";
  let jsonStr: string;
  const markerStart = output.indexOf(BOOKMARK_JSON_START);
  const markerEnd = output.indexOf(BOOKMARK_JSON_END);
  if (markerStart >= 0 && markerEnd > markerStart) {
    jsonStr = output.slice(markerStart + BOOKMARK_JSON_START.length, markerEnd).trim();
  } else {
    const match = output.match(/\[[\s\S]*\]/);
    jsonStr = match?.[0] || "[]";
  }

  let bookmarks: Bookmark[];
  try {
    bookmarks = JSON.parse(jsonStr);
  } catch {
    console.error("Failed to parse bookmark JSON");
    writeFileSync(`${OUT}/x-deep-raw.txt`, output);
    process.exit(1);
  }

  console.log(`  Found ${bookmarks.length} bookmarks\n`);
  for (const b of bookmarks) {
    console.log(`  - @${b.author}: ${b.text.slice(0, 80)}...`);
  }

  // ── Step 2: Read full thread for each bookmark ──
  console.log("\nStep 2: Reading full thread content for each bookmark...");
  const threads: Array<{ bookmark: Bookmark; fullText: string; urls: string[] }> = [];

  for (const b of bookmarks) {
    const tweetUrl = b.url || `https://x.com/${b.author}/status/${b.id}`;
    console.log(`  Reading @${b.author}/status/${b.id}...`);

    const threadResult = await executeBrowserScrape(buildTweetReadPrompt(tweetUrl), "", { timeout: 300_000 });

    let fullText = "";
    if (threadResult.exitCode === 0 && threadResult.output && threadResult.output !== "FAILED") {
      fullText = threadResult.output.trim();
      console.log(`    ${threadResult.executor}: ${fullText.length} chars`);
    } else {
      fullText = b.text; // fallback to card text
      console.log(`    Failed (using card text): ${fullText.length} chars`);
    }

    // Extract URLs from full text
    const urlRegex = /https?:\/\/[^\s"'<>\])}，。]+/g;
    const foundUrls = (fullText.match(urlRegex) || []).filter(u =>
      !u.includes("x.com") && !u.includes("twitter.com") &&
      !u.endsWith(".jpg") && !u.endsWith(".png")
    );
    const allUrls = [...new Set([...b.external_urls, ...foundUrls])];

    threads.push({ bookmark: b, fullText, urls: allUrls });
  }

  // ── Step 3: Deep-fetch external URLs ──
  const allExtUrls = new Set<string>();
  for (const t of threads) for (const u of t.urls) allExtUrls.add(u);

  console.log(`\nStep 3: Deep-fetching ${allExtUrls.size} external URLs...`);
  const deepResults = new Map<string, { title: string; content: string; chars: number; method: string }>();

  for (const url of allExtUrls) {
    const f = await fetchAndExtract(url);
    deepResults.set(url, { title: f.title, content: f.content, chars: f.charCount, method: f.method });
    console.log(`  ${f.method} (${f.charCount} chars): ${f.title || url}`);
  }

  // ── Write report ──
  const report = threads.map(t => {
    const lines = [
      `## @${t.bookmark.author}: ${(t.bookmark.text || t.fullText).slice(0, 100)}`,
      `**Tweet:** ${t.bookmark.url}`,
      `**Full text length:** ${t.fullText.length} chars\n`,
      t.fullText,
    ];

    if (t.urls.length > 0) {
      lines.push("\n### External Links");
      for (const u of t.urls) {
        const dr = deepResults.get(u);
        if (dr && dr.chars > 0) {
          lines.push(`\n#### ${dr.title || u}`, `*${u} — ${dr.chars} chars via ${dr.method}*\n`, dr.content.slice(0, 5000));
        } else {
          lines.push(`- ${u} — (not fetchable)`);
        }
      }
    }

    return lines.join("\n");
  }).join("\n\n---\n\n");

  const reportPath = `${OUT}/x-bookmarks-deep-${new Date().toISOString().slice(0, 16).replace(/:/g, "")}.md`;
  writeFileSync(reportPath, `# X Bookmarks — Deep Scrape via executeBrowserScrape\n${new Date().toISOString()}\n\n${report}`);

  console.log(`\nDone! ${bookmarks.length} bookmarks, ${threads.filter(t => t.fullText.length > 200).length} full threads, ${deepResults.size} deep-fetched links`);
  console.log(`Report: ${reportPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
