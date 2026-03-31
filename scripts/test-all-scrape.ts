/**
 * Full scrape test — all 3 platforms via executeBrowserScrape (Claude Sonnet).
 * X: 2-step (list → thread read per bookmark)
 * Medium: For You trending feed
 * LinkedIn: Activity page
 * All with deep-link content via Readability.js
 */

import { executeBrowserScrape } from "../src/executors/browser-scrape.js";
import {
  buildBookmarkScrapePrompt,
  buildTweetReadPrompt,
  buildMediumForYouScrapePrompt,
  buildLinkedInTopPostPrompt,
  BOOKMARK_JSON_START,
  BOOKMARK_JSON_END,
} from "../src/scraping/browser-prompts.js";
import { fetchAndExtract } from "../src/scraping/deep-fetch.js";
import { ensureCDP } from "../src/scraping/chrome-launcher.js";
import { writeFileSync, mkdirSync } from "fs";

const OUT = `${process.env.HOME}/homer/output/scrape-test`;
mkdirSync(OUT, { recursive: true });

function extractUrls(text: string): string[] {
  return (text.match(/https?:\/\/[^\s"'<>\])}，。]+/g) || []).filter(u =>
    !u.includes("x.com") && !u.includes("twitter.com") &&
    !u.includes("linkedin.com/in/") && !u.includes("instagram.com") &&
    !u.endsWith(".jpg") && !u.endsWith(".png") && !u.endsWith(".gif")
  );
}

interface DeepLink { url: string; title: string; content: string; chars: number; method: string }

async function deepFetch(urls: string[]): Promise<DeepLink[]> {
  const results: DeepLink[] = [];
  for (const url of [...new Set(urls)].slice(0, 8)) {
    const f = await fetchAndExtract(url);
    results.push({ url, title: f.title, content: f.content, chars: f.charCount, method: f.method });
    if (f.charCount > 0) console.log(`    deep: ${f.method} (${f.charCount} chars) ${f.title || url}`);
  }
  return results;
}

// ── X BOOKMARKS (2-step) ──

async function scrapeX(): Promise<string> {
  console.log("\n[X] Step 1: Scraping bookmark list...");
  const listR = await executeBrowserScrape(buildBookmarkScrapePrompt(8), "", { timeout: 600_000 });
  console.log(`  ${listR.executor} | exit ${listR.exitCode} | ${(listR.output || "").length} chars`);
  if (listR.exitCode !== 0) return `## X Bookmarks\n**FAILED** (exit ${listR.exitCode}): ${(listR.output || "").slice(0, 200)}`;

  const output = listR.output || "";
  let jsonStr: string;
  const s = output.indexOf(BOOKMARK_JSON_START), e = output.indexOf(BOOKMARK_JSON_END);
  if (s >= 0 && e > s) jsonStr = output.slice(s + BOOKMARK_JSON_START.length, e).trim();
  else jsonStr = output.match(/\[[\s\S]*\]/)?.[0] || "[]";

  let bookmarks: any[];
  try { bookmarks = JSON.parse(jsonStr); } catch { return "## X Bookmarks\n**FAILED**: JSON parse error"; }
  console.log(`  ${bookmarks.length} bookmarks found`);

  console.log("[X] Step 2: Reading full threads...");
  const sections: string[] = [];

  for (const b of bookmarks) {
    const url = b.url || `https://x.com/${b.author}/status/${b.id}`;
    console.log(`  @${b.author}/${b.id}...`);
    const tr = await executeBrowserScrape(buildTweetReadPrompt(url), "", { timeout: 300_000 });
    const fullText = (tr.exitCode === 0 && tr.output && tr.output !== "FAILED") ? tr.output.trim() : b.text;
    console.log(`    ${tr.executor}: ${fullText.length} chars`);

    const urls = [...new Set([...(b.external_urls || []), ...extractUrls(fullText)])];
    const deep = urls.length > 0 ? await deepFetch(urls) : [];

    const lines = [`### @${b.author}: ${(b.text || fullText).slice(0, 100)}`,
      `**${url}** | ${fullText.length} chars | ${tr.executor}\n`, fullText];
    if (deep.length > 0) {
      lines.push("\n**Deep Links:**");
      for (const d of deep) {
        if (d.chars > 0) lines.push(`\n#### ${d.title || d.url}`, `*${d.url} — ${d.chars} chars via ${d.method}*\n`, d.content.slice(0, 5000));
        else lines.push(`- ${d.url} — (not fetchable)`);
      }
    }
    sections.push(lines.join("\n"));
  }

  return `## X Bookmarks\n**${bookmarks.length} bookmarks, all threads read**\n\n${sections.join("\n\n---\n\n")}`;
}

// ── MEDIUM ──

async function scrapeMedium(): Promise<string> {
  console.log("\n[Medium] Scraping For You feed...");
  const r = await executeBrowserScrape(buildMediumForYouScrapePrompt(5), "", { timeout: 600_000 });
  console.log(`  ${r.executor} | exit ${r.exitCode} | ${(r.output || "").length} chars`);
  writeFileSync(`${OUT}/medium-raw.txt`, r.output || "(empty)");
  if (r.exitCode !== 0) return `## Medium Trending\n**FAILED** (${r.executor}, exit ${r.exitCode})`;

  const parsed = JSON.parse((r.output || "").match(/\[[\s\S]*\]/)?.[0] || "[]");
  if (parsed.length === 0) return "## Medium Trending\n**FAILED**: No articles found";

  const articleUrls = parsed.filter((p: any) => p.link).map((p: any) => p.link);
  console.log(`  ${parsed.length} articles. Deep-fetching ${articleUrls.length} links...`);
  const deep = await deepFetch(articleUrls);

  const sections = parsed.map((p: any) => {
    const d = deep.find(d => d.url === p.link);
    const lines = [`### ${p.title}`, `*${p.link}*\n`, p.content || p.first_paragraph || ""];
    if (p.hook_analysis) lines.push(`\n**Hook analysis:** ${p.hook_analysis}`);
    if (d && d.chars > 0) lines.push(`\n**Full article:** ${d.chars} chars via ${d.method}`);
    return lines.join("\n");
  });

  return `## Medium Trending\n**${parsed.length} articles** (${r.executor})\n\n${sections.join("\n\n---\n\n")}`;
}

// ── LINKEDIN ──

async function scrapeLinkedIn(): Promise<string> {
  console.log("\n[LinkedIn] Scraping activity...");
  const r = await executeBrowserScrape(buildLinkedInTopPostPrompt(), "", { timeout: 600_000 });
  console.log(`  ${r.executor} | exit ${r.exitCode} | ${(r.output || "").length} chars`);
  writeFileSync(`${OUT}/linkedin-raw.txt`, r.output || "(empty)");
  if (r.exitCode !== 0) return `## LinkedIn Activity\n**FAILED** (${r.executor}, exit ${r.exitCode})`;

  const parsed = JSON.parse((r.output || "").match(/\[[\s\S]*\]/)?.[0] || "[]");
  if (parsed.length === 0) return "## LinkedIn Activity\n**FAILED**: No posts found";

  const extUrls = parsed.flatMap((p: any) => extractUrls(p.content || ""));
  const deep = extUrls.length > 0 ? await deepFetch(extUrls) : [];

  const sections = parsed.map((p: any) => {
    const lines = [`### ${p.title}`, p.link ? `*${p.link}*` : "", `\n${p.content || p.first_paragraph || ""}`];
    if (p.reactions || p.comments) lines.push(`\n**Engagement:** ${p.reactions || 0} reactions, ${p.comments || 0} comments`);
    if (p.hook_analysis) lines.push(`\n**Hook analysis:** ${p.hook_analysis}`);
    return lines.join("\n");
  });

  let result = `## LinkedIn Activity\n**${parsed.length} posts** (${r.executor})\n\n${sections.join("\n\n---\n\n")}`;
  if (deep.length > 0) {
    result += "\n\n### Deep-Fetched Links\n";
    for (const d of deep) {
      if (d.chars > 0) result += `\n- [${d.title || d.url}](${d.url}) — ${d.chars} chars via ${d.method}`;
    }
  }
  return result;
}

// ── MAIN ──

async function main() {
  await ensureCDP({ headed: true });
  console.log("=== Full Scrape Test (executeBrowserScrape / Claude Sonnet) ===");

  // Run sequentially to avoid Gemini account contention
  const xReport = await scrapeX();
  const mediumReport = await scrapeMedium();
  const linkedinReport = await scrapeLinkedIn();

  const ts = new Date().toISOString();
  const report = `# Full Scrape Report — ${ts}\n\n${xReport}\n\n---\n\n${mediumReport}\n\n---\n\n${linkedinReport}`;
  const path = `${OUT}/full-scrape-${ts.slice(0, 16).replace(/:/g, "")}.md`;
  writeFileSync(path, report);

  console.log(`\n=== DONE ===\nReport: ${path}`);
}

main().catch(e => { console.error(e); process.exit(1); });
