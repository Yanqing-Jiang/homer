#!/usr/bin/env npx tsx
/**
 * One-time backfill: populate youtube_videos table from existing .md files.
 *
 * Reads from:
 *   ~/homer/data/youtube-transcripts/{videoId}-{date}.md
 *   ~/homer/data/youtube-summaries/{videoId}-{date}.md
 *
 * Matches transcripts and summaries by videoId prefix.
 *
 * Run: npx tsx scripts/backfill-youtube.ts
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import Database from "better-sqlite3";
import { runMigrations } from "../src/state/migrations/index.js";

const DB_PATH = "/Users/yj/homer/data/homer.db";
const TRANSCRIPTS_DIR = "/Users/yj/homer/data/youtube-transcripts";
const SUMMARIES_DIR = "/Users/yj/homer/data/youtube-summaries";

interface ParsedFrontmatter {
  [key: string]: string;
}

function parseFrontmatter(content: string): { frontmatter: ParsedFrontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const fm: ParsedFrontmatter = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) {
      fm[kv[1]!] = kv[2]!.replace(/^"(.*)"$/, "$1"); // strip quotes
    }
  }
  return { frontmatter: fm, body: (match[2] ?? "").trim() };
}

/**
 * Extract YouTube video ID from filename like `{videoId}-YYYY-MM-DD.md`.
 * YouTube IDs are 11 chars [A-Za-z0-9_-] and can contain hyphens,
 * so we strip the date suffix rather than splitting on `-`.
 */
function extractVideoId(filename: string): string {
  // Strip .md extension and date suffix (e.g., -2026-02-23)
  const match = filename.match(/^(.+)-\d{4}-\d{2}-\d{2}\.md$/);
  if (match) return match[1]!;
  // Fallback: strip extension
  return filename.replace(/\.md$/, "");
}

async function main() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  runMigrations(db);

  const hasTable = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='youtube_videos'"
  ).get();
  if (!hasTable) {
    console.error("ERROR: youtube_videos table does not exist. Run migrations first.");
    process.exit(1);
  }

  // ============================================
  // Step 1: Read all transcripts
  // ============================================
  const transcripts = new Map<string, { text: string; method: string; charCount: number; extractedAt: string }>();

  if (existsSync(TRANSCRIPTS_DIR)) {
    const files = readdirSync(TRANSCRIPTS_DIR).filter((f) => f.endsWith(".md"));
    console.log(`Found ${files.length} transcript files`);

    for (const file of files) {
      const videoId = extractVideoId(file);
      const content = readFileSync(join(TRANSCRIPTS_DIR, file), "utf-8");
      const { frontmatter, body } = parseFrontmatter(content);

      transcripts.set(videoId, {
        text: body,
        method: frontmatter.method ?? "unknown",
        charCount: parseInt(frontmatter.charCount ?? "0", 10) || body.length,
        extractedAt: frontmatter.extractedAt ?? "",
      });
    }
  } else {
    console.log("No transcripts directory found");
  }

  // ============================================
  // Step 2: Read all summaries and upsert
  // ============================================
  const upsert = db.prepare(`
    INSERT INTO youtube_videos (
      video_id, url, title, channel_name, transcript, summary,
      relevance_score, metadata, transcript_method,
      processed_at, reviewed_at, created_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?
    )
    ON CONFLICT(video_id) DO UPDATE SET
      title = COALESCE(excluded.title, youtube_videos.title),
      channel_name = COALESCE(excluded.channel_name, youtube_videos.channel_name),
      transcript = COALESCE(excluded.transcript, youtube_videos.transcript),
      summary = COALESCE(excluded.summary, youtube_videos.summary),
      relevance_score = COALESCE(excluded.relevance_score, youtube_videos.relevance_score),
      metadata = COALESCE(excluded.metadata, youtube_videos.metadata),
      transcript_method = COALESCE(excluded.transcript_method, youtube_videos.transcript_method),
      reviewed_at = COALESCE(excluded.reviewed_at, youtube_videos.reviewed_at)
  `);

  let succeeded = 0;
  let failed = 0;
  let transcriptOnly = 0;

  if (existsSync(SUMMARIES_DIR)) {
    const files = readdirSync(SUMMARIES_DIR).filter((f) => f.endsWith(".md"));
    console.log(`Found ${files.length} summary files`);

    const runAll = db.transaction(() => {
      for (const file of files) {
        const videoId = extractVideoId(file);
        const content = readFileSync(join(SUMMARIES_DIR, file), "utf-8");
        const { frontmatter, body } = parseFrontmatter(content);

        const transcript = transcripts.get(videoId);
        const url = frontmatter.videoUrl ?? `https://youtube.com/watch?v=${videoId}`;
        const title = frontmatter.videoTitle ?? "";
        const channelName = frontmatter.channelName ?? null;
        const relevanceScore = parseFloat(frontmatter.relevanceScore ?? "0") || null;
        const processedAt = frontmatter.processedAt ?? new Date().toISOString();
        const status = frontmatter.status ?? "";
        const reviewedAt = status === "reviewed" ? processedAt : null;

        const metadata = JSON.stringify({
          method: transcript?.method ?? "unknown",
          charCount: transcript?.charCount ?? 0,
          extractedAt: transcript?.extractedAt ?? "",
          backfilledAt: new Date().toISOString(),
        });

        try {
          upsert.run(
            videoId, url, title, channelName,
            transcript?.text ?? null, body,
            relevanceScore, metadata, transcript?.method ?? null,
            processedAt, reviewedAt, processedAt,
          );
          succeeded++;
          transcripts.delete(videoId); // mark as processed
        } catch (err) {
          console.warn(`  FAIL: ${file}: ${err}`);
          failed++;
        }
      }
    });

    runAll();
  } else {
    console.log("No summaries directory found");
  }

  // ============================================
  // Step 3: Insert orphan transcripts (no summary)
  // ============================================
  if (transcripts.size > 0) {
    console.log(`Found ${transcripts.size} transcripts without summaries`);

    const insertTranscriptOnly = db.prepare(`
      INSERT OR IGNORE INTO youtube_videos (
        video_id, url, title, transcript, metadata, transcript_method, processed_at, created_at
      ) VALUES (?, ?, '', ?, ?, ?, ?, ?)
    `);

    const runOrphans = db.transaction(() => {
      for (const [videoId, t] of transcripts) {
        try {
          const metadata = JSON.stringify({
            method: t.method, charCount: t.charCount,
            extractedAt: t.extractedAt, backfilledAt: new Date().toISOString(),
          });
          insertTranscriptOnly.run(
            videoId, `https://youtube.com/watch?v=${videoId}`,
            t.text, metadata, t.method,
            t.extractedAt || new Date().toISOString(),
            t.extractedAt || new Date().toISOString(),
          );
          transcriptOnly++;
        } catch (err) {
          console.warn(`  FAIL transcript-only ${videoId}: ${err}`);
        }
      }
    });

    runOrphans();
  }

  // Validate
  const count = db.prepare("SELECT count(*) as cnt FROM youtube_videos").get() as { cnt: number };
  const withSummary = db.prepare("SELECT count(*) as cnt FROM youtube_videos WHERE summary IS NOT NULL").get() as { cnt: number };
  const withTranscript = db.prepare("SELECT count(*) as cnt FROM youtube_videos WHERE transcript IS NOT NULL").get() as { cnt: number };

  console.log(`\nBackfill complete:`);
  console.log(`  Summaries imported: ${succeeded}`);
  console.log(`  Transcript-only: ${transcriptOnly}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  DB total rows: ${count.cnt}`);
  console.log(`  With summary: ${withSummary.cnt}`);
  console.log(`  With transcript: ${withTranscript.cnt}`);

  // Verify FTS
  try {
    const ftsTest = db.prepare(
      "SELECT count(*) as cnt FROM youtube_videos_fts"
    ).get() as { cnt: number };
    console.log(`  FTS index entries: ${ftsTest.cnt}`);
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
