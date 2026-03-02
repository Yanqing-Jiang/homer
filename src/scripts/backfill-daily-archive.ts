/**
 * One-time backfill: archive unarchived daily logs into daily_log_archive.
 * Run: npx tsx src/scripts/backfill-daily-archive.ts
 *
 * After this, daily_log_archive becomes read-only historical data.
 * No ongoing archiver needed — writer.ts and flush.ts now route to session_summaries.
 */

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "fs";
import { PATHS } from "../config/paths.js";

const DB_PATH = PATHS.db;
const DAILY_DIR = PATHS.daily;

const db = new Database(DB_PATH);

const archived = new Set(
  (db.prepare("SELECT date FROM daily_log_archive").all() as { date: string }[])
    .map(r => r.date)
);

const files = readdirSync(DAILY_DIR)
  .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
  .sort();

const insert = db.prepare(`
  INSERT OR IGNORE INTO daily_log_archive (date, raw_content, raw_size_bytes, archived_at)
  VALUES (?, ?, ?, datetime('now'))
`);

let count = 0;
for (const file of files) {
  const date = file.replace(".md", "");
  if (archived.has(date)) continue;

  const content = readFileSync(`${DAILY_DIR}/${file}`, "utf-8");
  insert.run(date, content, Buffer.byteLength(content));
  count++;
  console.log(`Archived: ${date} (${content.length} chars)`);
}

console.log(`\nDone. Archived ${count} daily logs. Total in DB: ${archived.size + count}`);
db.close();
