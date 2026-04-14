/**
 * Backfill: re-hydrate x-bookmark scrapes that never got thread expansion or
 * deep-link article fetch. Walks `scrapes` where source='x-bookmark' and
 * raw_content length < MIN_HYDRATED, calls:
 *   1. opencli twitter thread <id>  (primary)
 *   2. opencli twitter article <id> (fallback for X Articles)
 *   3. deep-fetch external URLs found in thread text (when original was link-only)
 *
 * Run (dry-run, no writes):  npx tsx src/scripts/backfill-bookmark-hydration.ts --dry
 * Run (live):                npx tsx src/scripts/backfill-bookmark-hydration.ts
 *
 * Safe to re-run: only rewrites when hydrated length > current length.
 */

import Database from "better-sqlite3";
import { PATHS } from "../config/paths.js";
import {
  fetchTwitterThread,
  fetchTwitterArticle,
} from "../executors/opencli.js";
import {
  mapOpenCLIThreadToText,
  mapOpenCLIArticleToText,
} from "../executors/opencli-mappers.js";
import { fetchAndExtract } from "../scraping/deep-fetch.js";

const MIN_HYDRATED = 1500;
const DEEP_FETCH_CAP = 6000;
const DRY = process.argv.includes("--dry");
const LIMIT = parseInt(
  process.argv.find(a => a.startsWith("--limit="))?.split("=")[1] ?? "0",
  10,
) || undefined;

interface Row {
  id: string;
  url: string;
  author: string | null;
  raw_content: string;
  metadata: string | null;
  len: number;
}

const SOCIAL = ["x.com", "twitter.com", "t.co", "linkedin.com", "instagram.com"];
function isExternal(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return !SOCIAL.some(d => h === d || h.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

function extractUrls(text: string): string[] {
  const re = /https?:\/\/[^\s"'<>\])}，。]+/g;
  return [...new Set(text.match(re) || [])];
}

function tweetIdFromUrl(url: string): string | null {
  const m = url.match(/status\/(\d+)/);
  return m ? m[1]! : null;
}

async function hydrate(row: Row): Promise<{ content: string; source: string; urls: string[] } | null> {
  const tweetId = tweetIdFromUrl(row.url);
  if (!tweetId) return null;
  const author = row.author ?? row.url.match(/x\.com\/([^/]+)\/status/)?.[1] ?? "";

  // 1) Thread first
  let hydrated = "";
  let method = "";
  try {
    const threadRes = await fetchTwitterThread(tweetId);
    if (threadRes.exitCode === 0 && threadRes.data && threadRes.data.length > 0) {
      hydrated = mapOpenCLIThreadToText(threadRes.data, author);
      method = "thread";
    }
  } catch (err) {
    console.warn(`  thread fetch failed for ${tweetId}:`, (err as Error).message);
  }

  // 2) Article fallback
  if (hydrated.length < row.len + 100) {
    try {
      const artRes = await fetchTwitterArticle(tweetId);
      if (artRes.exitCode === 0 && artRes.data) {
        const artText = mapOpenCLIArticleToText(artRes.data);
        if (artText.length > hydrated.length) {
          hydrated = artText;
          method = "article";
        }
      }
    } catch (err) {
      console.warn(`  article fetch failed for ${tweetId}:`, (err as Error).message);
    }
  }

  // 3) Deep-fetch external URLs found in hydrated text (if original was link-only)
  const source = hydrated || row.raw_content;
  const externalUrls = extractUrls(source).filter(isExternal);
  let deepAppendix = "";
  const wasLinkOnly = row.raw_content.trim().length < 200 && extractUrls(row.raw_content).length > 0;
  if (wasLinkOnly && externalUrls.length > 0) {
    const target = externalUrls[0]!;
    try {
      const r = await fetchAndExtract(target);
      if (r.method !== "failed" && r.content.length > 100) {
        const cap = r.content.slice(0, DEEP_FETCH_CAP);
        deepAppendix = `\n\n---\n[Deep-linked article]\n${r.title ? `# ${r.title}\n\n` : ""}${cap}`;
        method = method ? `${method}+deep` : "deep";
      }
    } catch (err) {
      console.warn(`  deep-fetch failed for ${target}:`, (err as Error).message);
    }
  }

  const finalContent = (hydrated || row.raw_content) + deepAppendix;
  // Only write if we actually gained material content
  if (finalContent.length <= row.len + 50) return null;

  return {
    content: `**@${author}**: ${finalContent.replace(new RegExp(`^\\*\\*@${author}\\*\\*:\\s*`), "")}`,
    source: method,
    urls: externalUrls,
  };
}

async function main() {
  const db = new Database(PATHS.db);

  const sql = `
    SELECT id, url, author, raw_content, metadata, LENGTH(raw_content) AS len
    FROM scrapes
    WHERE source = 'x-bookmark'
      AND LENGTH(raw_content) < ?
    ORDER BY LENGTH(raw_content) ASC
    ${LIMIT ? `LIMIT ${LIMIT}` : ""}
  `;
  const rows = db.prepare(sql).all(MIN_HYDRATED) as Row[];

  console.log(`Found ${rows.length} x-bookmark rows under ${MIN_HYDRATED} chars${DRY ? " [DRY RUN]" : ""}`);

  const update = db.prepare(`
    UPDATE scrapes
    SET raw_content = ?,
        metadata = json_patch(COALESCE(metadata, '{}'), ?)
    WHERE id = ?
  `);

  let hydratedCount = 0;
  let skipped = 0;
  let errored = 0;
  let totalGain = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    process.stdout.write(`[${i + 1}/${rows.length}] ${row.id} (${row.len}ch) ... `);
    try {
      const result = await hydrate(row);
      if (!result) {
        console.log("skipped (no gain)");
        skipped++;
        continue;
      }
      const gain = result.content.length - row.len;
      totalGain += gain;
      if (DRY) {
        console.log(`would write +${gain}ch via ${result.source}`);
      } else {
        const patch = JSON.stringify({
          backfill_hydrated_at: new Date().toISOString(),
          backfill_method: result.source,
          backfill_prev_len: row.len,
          backfill_new_len: result.content.length,
        });
        update.run(result.content, patch, row.id);
        console.log(`+${gain}ch via ${result.source}`);
      }
      hydratedCount++;
    } catch (err) {
      console.log(`ERROR: ${(err as Error).message}`);
      errored++;
    }
    // Gentle pacing to avoid hammering opencli/browser
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nDone. hydrated=${hydratedCount} skipped=${skipped} errored=${errored} total_chars_gained=${totalGain}${DRY ? " [DRY]" : ""}`);
  db.close();
}

main().catch(err => {
  console.error("fatal:", err);
  process.exit(1);
});
