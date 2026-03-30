/**
 * Link Processor — Process URLs from the link inbox
 *
 * Picks up pending links, routes to Claude Sonnet with the link-processor skill,
 * extracts content, and inserts into the scrapes table for the idea pipeline.
 *
 * Schedule: 0 23 * * * (11pm, before midnight idea-ingest)
 */

import { readFileSync, existsSync } from "fs";
import { executeClaudeCommand } from "../../executors/claude.js";
import {
  getPendingLinks,
  markLinkProcessing,
  markLinkDone,
  markLinkFailed,
  insertScrape,
  type LinkInboxItem,
} from "../../scraping/scrape-store.js";
import { logger } from "../../utils/logger.js";
import { storeJobArtifact } from "./artifact-store.js";
import type { StateManager } from "../../state/manager.js";
import { extractVideoId } from "../../youtube/utils.js";
import { summarizeYouTubeVideo, geminiSemaphore, videoExistsInDb } from "../../youtube/summarizer.js";
import type { YouTubeSummaryMetadata } from "../../overnight/types.js";

const SKILL_PATH = "/Users/yj/.claude/skills/link-processor/SKILLS.md";
const PROCESS_TIMEOUT = 300_000; // 5min per link (YouTube/Medium need more time)
const MAX_LINK_RETRIES = 3;

// Backoff is handled in getPendingLinks SQL (30min, 2h, 8h)

const PERMANENT_ERRORS = [
  "404", "not found", "account suspended", "page doesn't exist",
  "this account doesn't exist", "something went wrong",
];

function isPermanentError(error: string): boolean {
  const lower = error.toLowerCase();
  return PERMANENT_ERRORS.some(p => lower.includes(p));
}

interface ExtractedContent {
  title: string;
  author?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

function buildPrompt(link: LinkInboxItem, skillContent: string): string {
  return `${skillContent}

---

Process this URL:
- URL: ${link.url}
- Link Type: ${link.link_type}
${link.title ? `- Title hint: ${link.title}` : ""}
${link.notes ? `- User notes: ${link.notes}` : ""}

Extract the full content and return ONLY a JSON object as specified in the skill. No markdown fences.`;
}

function parseExtractedContent(output: string): ExtractedContent | null {
  // Find JSON in the output
  const jsonMatch = output.match(/\{[\s\S]*"content"[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.content || parsed.content.startsWith("EXTRACTION_FAILED")) {
      return null;
    }
    return parsed as ExtractedContent;
  } catch {
    return null;
  }
}

export async function runLinkProcessor(
  stateManager: StateManager,
  jobRunId?: number,
): Promise<{ success: boolean; output: string; error?: string }> {
  try {
    const db = stateManager.db;
    const pending = getPendingLinks(db, 10, MAX_LINK_RETRIES);

    if (pending.length === 0) {
      return { success: true, output: "No pending links to process" };
    }

    logger.info({ count: pending.length }, "Processing link inbox");

    const skillContent = existsSync(SKILL_PATH)
      ? readFileSync(SKILL_PATH, "utf-8")
      : "";

    let processed = 0;
    let failed = 0;
    const results: Array<{ url: string; status: string; title?: string }> = [];

    for (const link of pending) {
      markLinkProcessing(db, link.id);

      try {
        // YouTube links: route through dedicated pipeline (cheaper + more reliable)
        if (link.link_type === "youtube") {
          const videoId = extractVideoId(link.url);
          if (!videoId) {
            markLinkFailed(db, link.id, "Could not extract video ID from URL", true);
            failed++;
            results.push({ url: link.url, status: "bad_url" });
            continue;
          }

          // Dedup: check if already in youtube_videos
          if (videoExistsInDb(db, videoId)) {
            markLinkDone(db, link.id, `yt_dedup_${videoId}`);
            processed++;
            results.push({ url: link.url, status: "duplicate" });
            logger.info({ url: link.url, videoId }, "YouTube link already processed, skipping");
            continue;
          }

          // Run through dedicated pipeline
          const now = new Date();
          const metadata: YouTubeSummaryMetadata = {
            videoUrl: link.url,
            videoId,
            queuedAt: now.toISOString(),
            queueSource: "link-inbox",
            queueLocalHour: now.getHours(),
            queueLocalDow: now.getDay(),
          };

          await geminiSemaphore.acquire();
          let ytResult;
          try {
            ytResult = await summarizeYouTubeVideo(metadata, db);
          } finally {
            geminiSemaphore.release();
          }

          if (ytResult.success) {
            // Create a thin scrapes row (summary pointer, not full transcript)
            const scrapeId = `inbox_${link.id}`;
            const summaryText = ytResult.pass2
              ? `[YouTube] ${ytResult.pass2.videoTitle ?? videoId}: ${ytResult.pass2.intentHypothesis ?? ""}`
              : `[YouTube] ${videoId} — processed via dedicated pipeline`;

            insertScrape(db, {
              id: scrapeId,
              source: "link-inbox-youtube",
              url: link.url,
              title: ytResult.pass2?.videoTitle ?? videoId,
              raw_content: summaryText,
              metadata: JSON.stringify({
                youtube_video_id: videoId,
                inbox_id: link.id,
                submitted_by: link.submitted_by,
                relevance_score: ytResult.pass2?.overallRelevance,
                pipeline: { step: "pending", source: "youtube_v2_direct" },
              }),
            });

            markLinkDone(db, link.id, scrapeId);
            processed++;
            results.push({ url: link.url, status: "done", title: ytResult.pass2?.videoTitle });
            logger.info({ url: link.url, videoId, relevance: ytResult.pass2?.overallRelevance }, "YouTube link processed via dedicated pipeline");
          } else {
            markLinkFailed(db, link.id, ytResult.error ?? "YouTube pipeline failed");
            failed++;
            results.push({ url: link.url, status: "failed" });
          }
          continue;
        }

        // Non-YouTube links: process via Claude Sonnet skill
        const prompt = buildPrompt(link, skillContent);
        const result = await executeClaudeCommand(prompt, {
          cwd: "/tmp",
          model: "sonnet",
          timeout: PROCESS_TIMEOUT,
        });

        if (result.exitCode !== 0 || !result.output) {
          const errMsg = `Exit code ${result.exitCode}: ${result.output?.slice(0, 200) ?? "no output"}`;
          markLinkFailed(db, link.id, errMsg, isPermanentError(errMsg));
          failed++;
          results.push({ url: link.url, status: "failed" });
          continue;
        }

        const extracted = parseExtractedContent(result.output);
        if (!extracted) {
          markLinkFailed(db, link.id, `Could not parse content from output (${result.output.length} chars)`);
          failed++;
          results.push({ url: link.url, status: "parse_failed" });
          continue;
        }

        // Insert into scrapes table
        const scrapeId = `inbox_${link.id}`;
        const inserted = insertScrape(db, {
          id: scrapeId,
          source: `link-inbox-${link.link_type ?? "website"}`,
          url: link.url,
          title: extracted.title,
          author: extracted.author,
          raw_content: extracted.content,
          metadata: JSON.stringify({
            ...extracted.metadata,
            inbox_id: link.id,
            submitted_by: link.submitted_by,
            notes: link.notes,
          }),
        });

        if (inserted) {
          markLinkDone(db, link.id, scrapeId);
          processed++;
          results.push({ url: link.url, status: "done", title: extracted.title });
          logger.info({ url: link.url, title: extracted.title, scrapeId }, "Link processed");
        } else {
          markLinkDone(db, link.id, scrapeId); // URL duplicate is still "done"
          processed++;
          results.push({ url: link.url, status: "duplicate" });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        markLinkFailed(db, link.id, msg.slice(0, 500), isPermanentError(msg));
        failed++;
        results.push({ url: link.url, status: "error" });
        logger.warn({ url: link.url, error: msg }, "Link processing failed");
      }
    }

    if (jobRunId) {
      storeJobArtifact(db, jobRunId, "link-processor", "results", "json",
        JSON.stringify(results), { processed, failed });
    }

    const output = `Link processor: ${processed} processed, ${failed} failed (of ${pending.length} pending)`;
    logger.info({ output }, "Link processor complete");
    return { success: true, output };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Link processor failed");
    return { success: false, output: "", error: msg };
  }
}
