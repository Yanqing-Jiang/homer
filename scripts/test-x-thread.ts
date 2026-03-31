import { executeBrowserScrape } from "../src/executors/browser-scrape.js";
import { buildTweetReadPrompt } from "../src/scraping/browser-prompts.js";
import { fetchAndExtract } from "../src/scraping/deep-fetch.js";
import { ensureCDP } from "../src/scraping/chrome-launcher.js";
import { writeFileSync, mkdirSync } from "fs";

const OUT = `${process.env.HOME}/homer/output/scrape-test`;
mkdirSync(OUT, { recursive: true });

async function main() {
  await ensureCDP({ headed: true });

  const url = "https://x.com/xxxjzuo/status/2038404368819474933";
  console.log(`Reading thread via executeBrowserScrape: ${url}`);

  const r = await executeBrowserScrape(buildTweetReadPrompt(url), "", { timeout: 600_000 });
  console.log(`Executor: ${r.executor} | Exit: ${r.exitCode} | ${(r.output || "").length} chars`);

  const text = r.output || "";
  writeFileSync(`${OUT}/hermes-thread-raw.txt`, text);

  if (r.exitCode !== 0 || text === "FAILED") {
    console.error("Thread read failed");
    process.exit(1);
  }

  // Extract URLs for deep-fetch
  const urlRegex = /https?:\/\/[^\s"'<>\])}，。]+/g;
  const urls = (text.match(urlRegex) || []).filter(u =>
    !u.includes("x.com") && !u.includes("twitter.com") &&
    !u.endsWith(".jpg") && !u.endsWith(".png")
  );
  const unique = [...new Set(urls)];

  console.log(`\nFound ${unique.length} external URLs. Deep-fetching...`);
  const fetched: Array<{ url: string; title: string; content: string; chars: number; method: string }> = [];
  for (const u of unique) {
    const f = await fetchAndExtract(u);
    fetched.push({ url: u, title: f.title, content: f.content, chars: f.charCount, method: f.method });
    console.log(`  ${f.method} (${f.charCount} chars): ${f.title || u}`);
  }

  // Write report
  const report = [
    `# 从 Anthropic 的 Harness 演化看懂 Hermes Supervisor`,
    `**@xxxjzuo** | ${url}`,
    `**Scraped via:** ${r.executor} (executeBrowserScrape)`,
    `**Thread length:** ${text.length} chars\n`,
    `---\n`,
    text,
  ];

  if (fetched.length > 0) {
    report.push("\n---\n\n## Deep-Fetched Reference Links\n");
    for (const f of fetched) {
      if (f.chars > 0) {
        report.push(`### ${f.title || f.url}`, `*${f.url} — ${f.chars} chars via ${f.method}*\n`, f.content.slice(0, 8000), "\n");
      }
    }
  }

  const path = `${OUT}/hermes-supervisor-deep.md`;
  writeFileSync(path, report.join("\n"));
  console.log(`\nReport: ${path}`);
}

main().catch(e => { console.error(e); process.exit(1); });
