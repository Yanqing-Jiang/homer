/**
 * Repair: re-run deep-fetch for x-bookmark rows mis-flagged by the ingest
 * thread_read → deep_fetch.completed conflation (C1).
 *
 * Selects the exact 15-row root-cause set (source=ingest, completed, external
 * URLs present, neither article body marker). Clones metadata in memory,
 * deletes only deep_fetch from the clone, and passes it to deepFetchScrapes
 * so the skip check is bypassed without a preliminary DB flag clear.
 *
 * Does NOT touch processed_at, scraped_at, idea_id, or packet linkage.
 *
 * Dry-run:  npx tsx src/scripts/backfill-bookmark-deep-fetch.ts --dry-run
 * Live:     npx tsx src/scripts/backfill-bookmark-deep-fetch.ts
 */

import Database from "better-sqlite3";
import { PATHS } from "../config/paths.js";
import { deepFetchScrapes } from "../scraping/deep-fetch.js";
import type { StoredScrape } from "../scraping/scrape-store.js";

const DRY = process.argv.includes("--dry-run") || process.argv.includes("--dry");

const SELECT_SQL = `
  SELECT id, source, url, title, author, raw_content, metadata,
         scraped_at, processed_at, idea_id, quality_score
  FROM scrapes
  WHERE source='x-bookmark'
    AND json_valid(COALESCE(metadata,'{}'))
    AND json_type(metadata,'$.external_urls')='array'
    AND json_array_length(metadata,'$.external_urls')>0
    AND json_extract(metadata,'$.deep_fetch.source')='ingest'
    AND coalesce(json_extract(metadata,'$.deep_fetch.completed'),0)=1
    AND instr(raw_content,'[Deep-linked article]')=0
    AND instr(raw_content,'## Deep-Fetched Content')=0
  ORDER BY scraped_at
`;

async function main() {
  const db = new Database(PATHS.db);
  const rows = db.prepare(SELECT_SQL).all() as StoredScrape[];

  console.log(`Deep-fetch repair candidates: ${rows.length}${DRY ? " [DRY RUN]" : ""}`);
  for (const row of rows) {
    console.log(`  ${row.id}\tlen=${row.raw_content?.length ?? 0}\t${row.url ?? ""}`);
  }

  if (DRY) {
    console.log(`\nDry-run complete. Would process ${rows.length} rows. No writes.`);
    db.close();
    return;
  }

  let ok = 0;
  let fail = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    process.stdout.write(`[${i + 1}/${rows.length}] ${row.id} ... `);
    try {
      const meta = row.metadata ? JSON.parse(row.metadata) : {};
      // In-memory clone only — delete deep_fetch so deepFetchScrapes won't skip.
      const cloneMeta = { ...meta };
      delete cloneMeta.deep_fetch;
      const clone: StoredScrape = {
        ...row,
        metadata: JSON.stringify(cloneMeta),
      };
      const result = await deepFetchScrapes(db, [clone]);
      if (result.enriched > 0) {
        console.log(`enriched`);
        ok++;
      } else if (result.failed > 0) {
        console.log(`failed (attempt recorded)`);
        fail++;
      } else {
        console.log(`skipped`);
      }
    } catch (err) {
      console.log(`ERROR: ${(err as Error).message}`);
      fail++;
    }
  }

  console.log(`\nDone. enriched=${ok} failed=${fail} total=${rows.length}`);
  db.close();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
