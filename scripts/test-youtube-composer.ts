#!/usr/bin/env npx tsx
/**
 * One-off: run YouTube summarizer for a single URL via link-processor stages
 * (Composer 2.5 primary, Codex sol-medium fallback).
 */
import Database from "better-sqlite3";
import { summarizeYouTubeVideo } from "../src/youtube/summarizer.js";
import type { RegisteredJob } from "../src/scheduler/types.js";
import type { YouTubeSummaryMetadata } from "../src/overnight/types.js";

async function main() {
  const videoUrl = process.argv[2] ?? "https://youtu.be/VQy50fuxI34";
  const videoIdMatch = videoUrl.match(/(?:youtu\.be\/|v=)([A-Za-z0-9_-]{11})/);
  if (!videoIdMatch) {
    console.error("Could not parse video id from", videoUrl);
    process.exit(1);
  }
  const videoId = videoIdMatch[1]!;

  const db = new Database("/Users/yj/homer/data/homer.db");
  db.pragma("journal_mode = WAL");

  const existing = db.prepare("SELECT video_id FROM youtube_videos WHERE video_id = ?").get(videoId);
  if (existing) {
    console.log(`Removing existing youtube_videos row for ${videoId} to force re-run`);
    db.prepare("DELETE FROM youtube_videos WHERE video_id = ?").run(videoId);
  }

  const job: RegisteredJob = {
    config: {
      id: "link-processor",
      name: "Link Processor (manual test)",
      cron: "0 0 * * *",
      query: "manual youtube scrape test",
      lane: "default",
      enabled: true,
      executor: "internal",
      handler: "link_processor",
      timeout: 1_200_000,
    },
    sourceFile: "manual-test",
    nextRun: null,
    lastRun: null,
    lastSuccess: null,
    consecutiveFailures: 0,
  };

  const now = new Date();
  const metadata: YouTubeSummaryMetadata = {
    videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
    queuedAt: now.toISOString(),
    queueSource: "manual-composer-test",
    queueLocalHour: now.getHours(),
    queueLocalDow: now.getDay(),
  };

  console.log(JSON.stringify({ videoId, videoUrl: metadata.videoUrl, startedAt: now.toISOString() }, null, 2));
  const t0 = Date.now();

  const result = await summarizeYouTubeVideo(
    metadata,
    db,
    job,
    now,
    { classify: "youtube_classify", analyze: "youtube_analyze" },
  );

  const elapsedMs = Date.now() - t0;
  const row = db.prepare(
    `SELECT video_id, title, channel_name, relevance_score, model_pass1, model_pass2,
            processing_ms, primary_category, intent_primary
     FROM youtube_videos WHERE video_id = ?`,
  ).get(videoId);

  console.log("\n=== RESULT ===");
  console.log(JSON.stringify({
    success: result.success,
    error: result.error,
    summaryPath: result.summaryPath,
    wallClockMs: elapsedMs,
    wallClockSec: Math.round(elapsedMs / 1000),
    pass1: result.pass1 ? {
      category: result.pass1.videoCategory,
      preScore: result.pass1.relevancePreScore,
      intent: result.pass1.intentInference,
      focus: result.pass1.analysisPlan?.focusCategories,
    } : null,
    pass2: result.pass2 ? {
      title: result.pass2.videoTitle,
      channel: result.pass2.channelName,
      relevance: result.pass2.overallRelevance,
      reason: result.pass2.overallRelevanceReason,
      degraded: result.pass2.degraded,
      actions: result.pass2.actions?.slice(0, 5),
      ideaCount: result.pass2.ideaCandidates?.length ?? 0,
      categories: result.pass2.analysisByCategory?.map(c => ({
        category: c.category,
        weight: c.weight,
        analysisChars: c.analysis?.length ?? 0,
        actionItems: c.actionItems?.length ?? 0,
      })),
    } : null,
    dbRow: row,
  }, null, 2));

  db.close();
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
