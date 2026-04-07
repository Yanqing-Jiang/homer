/**
 * Overnight YouTube Processor
 *
 * Picks up queued youtube_summary tasks from the overnight_tasks table
 * and processes them through the existing YouTube summarizer pipeline.
 *
 * Schedule: 0 23 * * * (11pm, alongside link-processor)
 */

import { OvernightTaskStore } from "../../overnight/task-store.js";
import { summarizeYouTubeVideo, geminiSemaphore, videoExistsInDb } from "../../youtube/summarizer.js";
import { logger } from "../../utils/logger.js";
import type { StateManager } from "../../state/manager.js";
import type { YouTubeSummaryMetadata } from "../../overnight/types.js";

export async function runOvernightYoutube(
  stateManager: StateManager,
  _jobRunId?: number,
): Promise<{ success: boolean; output: string; error?: string }> {
  try {
    const db = stateManager.db;
    const taskStore = new OvernightTaskStore(db);
    const queued = taskStore.getQueuedTasks().filter(t => t.type === "youtube_summary");

    if (queued.length === 0) {
      return { success: true, output: "No queued YouTube tasks" };
    }

    logger.info({ count: queued.length }, "Processing overnight YouTube tasks");

    let processed = 0;
    let failed = 0;
    const results: Array<{ videoId: string; status: string; title?: string }> = [];

    for (const task of queued) {
      let metadata: YouTubeSummaryMetadata;
      try {
        metadata = JSON.parse(task.metadata ?? "{}") as YouTubeSummaryMetadata;
      } catch {
        taskStore.updateTaskStatus(task.id, "failed", { error: "Invalid metadata JSON" });
        failed++;
        results.push({ videoId: task.id, status: "bad_metadata" });
        continue;
      }

      const { videoId, videoUrl } = metadata;
      if (!videoId || !videoUrl) {
        taskStore.updateTaskStatus(task.id, "failed", { error: "Missing videoId or videoUrl in metadata" });
        failed++;
        results.push({ videoId: videoId ?? task.id, status: "missing_fields" });
        continue;
      }

      // Dedup: already in youtube_videos
      if (videoExistsInDb(db, videoId)) {
        taskStore.updateTaskStatus(task.id, "ready", { completedAt: new Date() });
        processed++;
        results.push({ videoId, status: "duplicate" });
        logger.info({ videoId }, "YouTube video already in DB, marking ready");
        continue;
      }

      // Process through summarizer pipeline
      taskStore.updateTaskStatus(task.id, "executing", { startedAt: new Date() });

      await geminiSemaphore.acquire();
      let ytResult;
      try {
        ytResult = await summarizeYouTubeVideo(metadata, db);
      } finally {
        geminiSemaphore.release();
      }

      if (ytResult.success) {
        taskStore.updateTaskStatus(task.id, "ready", { completedAt: new Date() });
        processed++;
        results.push({
          videoId,
          status: "done",
          title: ytResult.pass2?.videoTitle,
        });
        logger.info(
          { videoId, title: ytResult.pass2?.videoTitle, relevance: ytResult.pass2?.overallRelevance },
          "Overnight YouTube video processed"
        );
      } else {
        taskStore.updateTaskStatus(task.id, "failed", {
          error: ytResult.error ?? "YouTube pipeline failed",
          completedAt: new Date(),
        });
        failed++;
        results.push({ videoId, status: "failed" });
        logger.warn({ videoId, error: ytResult.error }, "Overnight YouTube video failed");
      }
    }

    const output = `Overnight YouTube: ${processed} processed, ${failed} failed (of ${queued.length} queued)`;
    logger.info({ output }, "Overnight YouTube processor complete");
    return { success: true, output };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Overnight YouTube processor failed");
    return { success: false, output: "", error: msg };
  }
}
