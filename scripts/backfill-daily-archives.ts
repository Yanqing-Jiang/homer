#!/usr/bin/env npx tsx
/**
 * Backfill daily log archives to SQLite
 *
 * For each YYYY-MM-DD.md in ~/memory/daily/:
 * - Has `## Daily Summary`: Archive full content to SQLite, rewrite .md to summary-only
 * - No summary yet: Archive raw to SQLite, leave .md untouched (summary job will handle it)
 * - Already archived: Skip (idempotent)
 *
 * Usage:
 *   npx tsx scripts/backfill-daily-archives.ts [--dry-run]
 */

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { StateManager } from "../src/state/manager.js";
import { runMigrations } from "../src/state/migrations/index.js";
import Database from "better-sqlite3";

const DAILY_DIR = "/Users/yj/memory/daily";
const DB_PATH = "/Users/yj/homer/data/homer.db";
const DRY_RUN = process.argv.includes("--dry-run");

function main() {
  console.log(`Backfill daily log archives${DRY_RUN ? " (DRY RUN)" : ""}`);
  console.log(`Daily dir: ${DAILY_DIR}`);
  console.log(`Database:  ${DB_PATH}\n`);

  // Ensure migrations are applied (creates daily_log_archive table if needed)
  const rawDb = new Database(DB_PATH);
  runMigrations(rawDb);
  rawDb.close();

  const sm = new StateManager(DB_PATH);

  const files = readdirSync(DAILY_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort();

  let archived = 0;
  let stripped = 0;
  let skipped = 0;
  let rawOnly = 0;
  let totalRawBytes = 0;
  let totalNewBytes = 0;

  for (const file of files) {
    const date = file.replace(".md", "");
    const filePath = join(DAILY_DIR, file);
    const content = readFileSync(filePath, "utf-8");
    const sizeKB = Math.round(content.length / 1024);

    // Already archived?
    if (sm.isDailyLogArchived(date)) {
      console.log(`  SKIP  ${date} (already archived)`);
      skipped++;
      continue;
    }

    const hasSummary = content.includes("## Daily Summary");

    if (hasSummary) {
      // Archive full content, then strip .md to summary-only
      // Extract the summary block: starts at "## Daily Summary", ends before
      // any post-summary session dumps (### HH:MM [...] or <details> blocks)
      const summaryStart = content.indexOf("## Daily Summary");
      let summaryText = "";
      if (summaryStart !== -1) {
        const afterSummary = content.slice(summaryStart);
        // Find where post-summary raw content begins (session dumps appended after summary)
        const postSummaryMatch = afterSummary.match(/\n### \d{2}:\d{2} \[/);
        if (postSummaryMatch?.index) {
          summaryText = afterSummary.slice(0, postSummaryMatch.index).trim();
        } else {
          summaryText = afterSummary.trim();
        }
      }
      const newContent = `# ${date}\n\n---\n\n${summaryText}\n`;
      const newSizeKB = Math.round(newContent.length / 1024);

      if (!DRY_RUN) {
        sm.archiveDailyLog(date, content);
        sm.markDailyLogStripped(date, summaryText);
        writeFileSync(filePath, newContent, "utf-8");
      }

      totalRawBytes += content.length;
      totalNewBytes += newContent.length;
      archived++;
      stripped++;
      console.log(`  STRIP ${date} — ${sizeKB}KB → ${newSizeKB}KB`);
    } else {
      // No summary yet — archive raw, leave .md untouched
      if (!DRY_RUN) {
        sm.archiveDailyLog(date, content);
      }

      totalRawBytes += content.length;
      totalNewBytes += content.length; // unchanged
      archived++;
      rawOnly++;
      console.log(`  ARCHIVE ${date} — ${sizeKB}KB (no summary, .md unchanged)`);
    }
  }

  sm.close();

  console.log(`\n--- Results${DRY_RUN ? " (DRY RUN — no changes made)" : ""} ---`);
  console.log(`Total files:    ${files.length}`);
  console.log(`Archived:       ${archived}`);
  console.log(`  Stripped:     ${stripped}`);
  console.log(`  Raw only:     ${rawOnly}`);
  console.log(`Skipped:        ${skipped}`);
  console.log(`Raw total:      ${Math.round(totalRawBytes / 1024)}KB`);
  console.log(`New total:      ${Math.round(totalNewBytes / 1024)}KB`);
  console.log(`Saved:          ${Math.round((totalRawBytes - totalNewBytes) / 1024)}KB`);

  if (!DRY_RUN && stripped > 0) {
    console.log(`\nRun 'memory_reindex' MCP tool to update FTS5 with the smaller files.`);
  }
}

main();
