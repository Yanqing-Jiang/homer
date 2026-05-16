#!/usr/bin/env npx tsx
/**
 * One-time backfill: emit `lesson` knowledge_claims for already-done todos
 * whose notes look like AAR-worthy content (length ≥ LESSON_MIN_NOTES_LEN).
 *
 * Idempotent: dedups by source_url = "todo:{id}:done". Safe to re-run.
 *
 * Run: npx tsx scripts/backfill-todo-lessons.ts            # dry-run
 *      npx tsx scripts/backfill-todo-lessons.ts --apply    # write claims
 */

import Database from "better-sqlite3";
import { createHash, randomBytes } from "crypto";

const DB_PATH = "/Users/yj/homer/data/homer.db";
const LESSON_MIN_NOTES_LEN = 80;
const LESSON_MAX_CONTENT_LEN = 4000;

interface TodoRow {
  id: string;
  title: string;
  notes: string;
  category: "W" | "L";
  source: string;
  completed_at: string | null;
  updated_at: string;
}

function main() {
  const apply = process.argv.includes("--apply");
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  // Candidates: done, non-migration, notes long enough, and not already emitted.
  const candidates = db.prepare(`
    SELECT id, title, notes, category, source, completed_at, updated_at
    FROM todo_index
    WHERE status = 'done'
      AND source != 'migration'
      AND length(notes) >= ?
      AND NOT EXISTS (
        SELECT 1 FROM knowledge_claims
        WHERE source_url = 'todo:' || todo_index.id || ':done'
          AND status NOT IN ('rejected','archived','expired')
      )
    ORDER BY COALESCE(completed_at, updated_at) ASC
  `).all(LESSON_MIN_NOTES_LEN) as TodoRow[];

  console.log(`Found ${candidates.length} done todos eligible for lesson backfill`);
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN (pass --apply to write)"}\n`);

  if (candidates.length === 0) {
    db.close();
    return;
  }

  const insert = db.prepare(`
    INSERT INTO knowledge_claims (
      id, content, content_hash, target_file, section,
      claim_type, confidence, status, source_url, origin_channel, created_at
    ) VALUES (
      ?, ?, ?, ?, 'Lessons',
      'lesson', 0.85, 'approved', ?, 'todo', ?
    )
  `);

  interface Prepared {
    id: string;
    content: string;
    contentHash: string;
    targetFile: "work" | "me";
    sourceUrl: string;
    createdAt: string;
    title: string;
    notesLen: number;
    preview: string;
  }

  const prepared: Prepared[] = candidates.map((row) => {
    const notes = row.notes.trim();
    const body = `Completed: ${row.title}\n\n${notes}`;
    const content = body.length > LESSON_MAX_CONTENT_LEN
      ? body.slice(0, LESSON_MAX_CONTENT_LEN) + "\n\n[…truncated]"
      : body;
    const targetFile = row.category === "W" ? "work" : "me";
    const contentHash = createHash("md5").update(`${content}\n${targetFile}\nLessons`).digest("hex");
    const id = `claim_${randomBytes(8).toString("hex")}`;
    const sourceUrl = `todo:${row.id}:done`;
    // Preserve historical created_at — anchor the lesson at when the work
    // actually wrapped, not at backfill time.
    const createdAt = row.completed_at ?? row.updated_at ?? new Date().toISOString().slice(0, 19).replace("T", " ");
    const preview = notes.slice(0, 60).replace(/\s+/g, " ");
    return { id, content, contentHash, targetFile, sourceUrl, createdAt, title: row.title, notesLen: notes.length, preview };
  });

  for (const p of prepared) {
    console.log(`  [${p.targetFile}] → claim ${p.id}  (anchor: ${p.createdAt})`);
    console.log(`     title: ${p.title}`);
    console.log(`     notes: ${p.notesLen} chars — "${p.preview}…"\n`);
  }

  if (apply) {
    const tx = db.transaction(() => {
      for (const p of prepared) {
        insert.run(p.id, p.content, p.contentHash, p.targetFile, p.sourceUrl, p.createdAt);
      }
    });
    tx();
    console.log(`Inserted ${prepared.length} lesson claims.`);
    console.log(`Next: run memory_generate_embeddings to vectorize new rows.`);
  } else {
    console.log(`Dry-run complete. Re-run with --apply to insert.`);
  }

  db.close();
}

main();
