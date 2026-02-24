#!/usr/bin/env npx tsx
/**
 * One-time backfill: populate ideas table raw_content from ~/memory/ideas/*.md files.
 *
 * The migration 037 seeds metadata from idea_index, but raw_content is NULL.
 * This script reads each .md file and fills in raw_content, notes, context,
 * exploration, link, canonical_url, and fingerprint.
 *
 * Run: npx tsx scripts/backfill-ideas.ts
 */

import { readdirSync, existsSync } from "fs";
import { join } from "path";
import Database from "better-sqlite3";
import { runMigrations } from "../src/state/migrations/index.js";

const DB_PATH = "/Users/yj/homer/data/homer.db";
const IDEAS_DIR = "/Users/yj/memory/ideas";

// Inline the parser logic to avoid import chain issues in standalone script
import { parseIdeaFile } from "../src/ideas/parser.js";
import { canonicalizeUrl } from "../src/ideas/canonical-url.js";
import { createFingerprint } from "../src/ideas/fingerprint.js";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { formatIdeaFile } from "../src/ideas/parser.js";

async function main() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  // Ensure migrations are applied
  runMigrations(db);

  const hasTable = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='ideas'"
  ).get();
  if (!hasTable) {
    console.error("ERROR: ideas table does not exist. Run migrations first.");
    process.exit(1);
  }

  if (!existsSync(IDEAS_DIR)) {
    console.error(`ERROR: Ideas directory not found: ${IDEAS_DIR}`);
    process.exit(1);
  }

  const files = readdirSync(IDEAS_DIR).filter((f) => f.endsWith(".md"));
  console.log(`Found ${files.length} idea files to backfill`);

  const upsert = db.prepare(`
    INSERT INTO ideas (
      id, title, status, source, tags, raw_content, link, canonical_url,
      notes, context, exploration, fingerprint,
      linked_exploration_thread_id, linked_plan_id,
      file_path, content_hash, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, datetime('now')
    )
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      status = excluded.status,
      source = excluded.source,
      tags = excluded.tags,
      raw_content = excluded.raw_content,
      link = excluded.link,
      canonical_url = excluded.canonical_url,
      notes = excluded.notes,
      context = excluded.context,
      exploration = excluded.exploration,
      fingerprint = excluded.fingerprint,
      linked_exploration_thread_id = COALESCE(excluded.linked_exploration_thread_id, ideas.linked_exploration_thread_id),
      linked_plan_id = COALESCE(excluded.linked_plan_id, ideas.linked_plan_id),
      file_path = excluded.file_path,
      content_hash = excluded.content_hash,
      updated_at = datetime('now')
  `);

  let succeeded = 0;
  let failed = 0;

  const runAll = db.transaction(() => {
    for (const file of files) {
      const filePath = join(IDEAS_DIR, file);
      const idea = parseIdeaFile(filePath);
      if (!idea) {
        console.warn(`  SKIP: ${file} (parse failed)`);
        failed++;
        continue;
      }

      const tags = idea.tags?.length ? JSON.stringify(idea.tags) : null;
      const canonical = idea.link ? canonicalizeUrl(idea.link).canonical || null : null;
      const fp = createFingerprint(idea.title);
      const contentStr = formatIdeaFile(idea);
      const hash = createHash("md5").update(contentStr).digest("hex");

      try {
        upsert.run(
          idea.id, idea.title, idea.status, idea.source || null, tags,
          idea.content || null, idea.link || null, canonical,
          idea.notes || null, idea.context || null, idea.exploration || null,
          fp.hash || null,
          idea.linkedExplorationThreadId || null, idea.linkedPlanId || null,
          filePath, hash, idea.timestamp || null,
        );
        succeeded++;
      } catch (err) {
        console.warn(`  FAIL: ${file}: ${err}`);
        failed++;
      }
    }
  });

  runAll();

  // Validate
  const count = db.prepare("SELECT count(*) as cnt FROM ideas").get() as { cnt: number };
  const withContent = db.prepare("SELECT count(*) as cnt FROM ideas WHERE raw_content IS NOT NULL").get() as { cnt: number };

  console.log(`\nBackfill complete:`);
  console.log(`  Files: ${files.length}`);
  console.log(`  Succeeded: ${succeeded}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  DB total rows: ${count.cnt}`);
  console.log(`  DB with content: ${withContent.cnt}`);

  // Verify FTS works
  try {
    const ftsTest = db.prepare(
      "SELECT count(*) as cnt FROM ideas_fts"
    ).get() as { cnt: number };
    console.log(`  FTS index entries: ${ftsTest.cnt}`);

    // Test a sample search
    const sample = db.prepare(
      "SELECT i.id, i.title FROM ideas_fts fts JOIN ideas i ON fts.rowid = i.rowid LIMIT 3"
    ).all();
    if (sample.length > 0) {
      console.log(`  FTS sample search OK (${sample.length} results)`);
    }
  } catch (err) {
    console.warn(`  FTS verification failed: ${err}`);
  }

  db.close();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
