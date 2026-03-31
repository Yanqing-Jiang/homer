import { executeBrowserScrape } from "../src/executors/browser-scrape.js";
import { buildBookmarkScrapePrompt } from "../src/scraping/browser-prompts.js";
import { fetchAndExtract } from "../src/scraping/deep-fetch.js";
import { ensureCDP } from "../src/scraping/chrome-launcher.js";
import { writeFileSync, mkdirSync } from "fs";

const OUT = `${process.env.HOME}/homer/output/scrape-test`;
mkdirSync(OUT, { recursive: true });

async function main() {
  await ensureCDP({ headed: true });
  console.log("Starting X bookmark scrape via executeBrowserScrape (Claude Sonnet → Gemini Flash)...");

  const r = await executeBrowserScrape(buildBookmarkScrapePrompt(8), "", { timeout: 600_000 });
  console.log(`Exit: ${r.exitCode} | Executor: ${r.executor} | Output: ${(r.output || "").length} chars`);
  writeFileSync(`${OUT}/x-bookmarks-raw.txt`, r.output || "(empty)");

  if (r.exitCode !== 0) {
    console.error("FAILED:", (r.output || "").slice(0, 500));
    process.exit(1);
  }

  const jsonMatch = (r.output || "").match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error("No JSON array found in output");
    process.exit(1);
  }

  const bookmarks = JSON.parse(jsonMatch[0]);
  console.log(`\nBookmarks found: ${bookmarks.length}\n`);

  for (const b of bookmarks) {
    console.log(`- @${b.author}: ${(b.title || b.text || "").slice(0, 100)}`);
    if (b.urls?.length) console.log(`  Links: ${b.urls.join(", ")}`);
  }

  // Deep-fetch external URLs
  const urls = new Set<string>();
  for (const b of bookmarks) {
    if (b.urls) for (const u of b.urls) urls.add(u);
  }
  const toFetch = [...urls].slice(0, 8);
  if (toFetch.length > 0) {
    console.log(`\nDeep-fetching ${toFetch.length} links...`);
    const fetched: Array<{ url: string; title: string; chars: number; method: string; content: string }> = [];
    for (const url of toFetch) {
      const f = await fetchAndExtract(url);
      fetched.push({ url, title: f.title, chars: f.charCount, method: f.method, content: f.content });
      console.log(`  ${f.method} (${f.charCount} chars): ${f.title || url}`);
    }

    // Write report with deep content
    const report = bookmarks.map((b: any) => {
      const lines = [`## ${b.title || b.text?.slice(0, 80)}`, `**@${b.author}**\n`, b.text || ""];
      if (b.urls?.length) {
        for (const u of b.urls) {
          const df = fetched.find(f => f.url === u);
          if (df && df.chars > 0) {
            lines.push(`\n### Deep Link: ${df.title || u}`, `*${df.url} — ${df.chars} chars via ${df.method}*\n`, df.content.slice(0, 3000));
          }
        }
      }
      return lines.join("\n");
    }).join("\n\n---\n\n");

    writeFileSync(`${OUT}/x-bookmarks-deep.md`,
      `# X Bookmarks with Deep Content — ${new Date().toISOString()}\n\n${report}`);
    console.log(`\nReport: ${OUT}/x-bookmarks-deep.md`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
