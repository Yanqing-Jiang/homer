/**
 * Conflict detection — guard against auto-approving a high-confidence claim
 * that semantically contradicts existing memory.
 *
 * The auto-approve gate trusts the extractor's confidence. But the extractor
 * sees one session in isolation: it can confidently emit "Yanqing is in SF"
 * even when memory already says "Yanqing lives in OKC". Both can be true at
 * the same time (travel) — but the human should resolve, not the daemon.
 *
 * Strategy: before auto-approving, run a vector search against existing memory
 * scoped to the target file. If any neighbor has cosine similarity above
 * SIMILARITY_THRESHOLD and is not a literal duplicate (which dedup catches
 * separately), demote the claim to HITL.
 */

import type { MemoryIndexer } from "./indexer.js";
import { logger } from "../utils/logger.js";

export const CONFLICT_SIMILARITY_THRESHOLD = 0.85;

export interface ConflictCheckResult {
  conflict: boolean;
  neighborContent?: string;
  neighborScore?: number;
  reason?: string;
}

export async function wouldConflict(
  newContent: string,
  targetFile: string,
  indexer: MemoryIndexer,
): Promise<ConflictCheckResult> {
  // Embeddings table key — context filter narrows to the right slice.
  const context = targetFile === "work" ? "work" : "general";

  let neighbors: Array<{ content: string; score?: number; filePath: string }>;
  try {
    neighbors = await indexer.hybridSearch(newContent, 5, context as "work" | "general");
  } catch (err) {
    // If embeddings aren't ready, fall through — better to auto-approve than to block on infrastructure.
    logger.debug({ err }, "Conflict check skipped: hybridSearch failed");
    return { conflict: false };
  }

  for (const n of neighbors) {
    const score = n.score ?? 0;
    if (score < CONFLICT_SIMILARITY_THRESHOLD) continue;
    // Skip neighbors that come from a different memory file (they're irrelevant overlap).
    if (!n.filePath.endsWith(`/${targetFile}.md`)) continue;
    // Skip exact substring matches — those are dedup's job.
    if (n.content.includes(newContent.trim())) continue;
    return {
      conflict: true,
      neighborContent: n.content,
      neighborScore: score,
      reason: `near-duplicate match in ${targetFile}.md (cosine ${score.toFixed(3)} >= ${CONFLICT_SIMILARITY_THRESHOLD})`,
    };
  }

  return { conflict: false };
}
