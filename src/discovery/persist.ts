/**
 * Discovery Persistence
 *
 * Persists discovery proposals to the database for approval workflow.
 * Uses content_hash for deduplication to avoid presenting the same content twice.
 */

import { createHash } from "crypto";
import type Database from "better-sqlite3";
import type { DiscoveryProposal } from "./types.js";
import { logger } from "../utils/logger.js";

// Notification thresholds
const HIGH_SCORE_THRESHOLD = 70;    // Immediate Telegram notification
const MEDIUM_SCORE_THRESHOLD = 50;  // Include in daily digest

export interface PersistenceResult {
  inserted: number;
  skipped: number;  // Duplicates
  highPriority: DiscoveryProposal[];  // Score >= 70, for immediate notification
}

/**
 * Generate content hash from source URL for deduplication
 */
function generateContentHash(url: string): string {
  return createHash("sha256")
    .update(url)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Persist discovery proposals to the database.
 * Uses content_hash unique constraint for deduplication.
 *
 * @param proposals - Discovery proposals to persist
 * @param db - better-sqlite3 database instance
 * @returns Persistence result with counts and high-priority proposals
 */
export function persistDiscoveryResults(
  proposals: DiscoveryProposal[],
  db: Database.Database
): PersistenceResult {
  const result: PersistenceResult = {
    inserted: 0,
    skipped: 0,
    highPriority: [],
  };

  const insertStmt = db.prepare(`
    INSERT INTO proposals (
      id, title, summary, content, proposal_type, risk_level,
      source, source_detail, source_url, content_hash,
      relevance_score, stage, approval_status, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idea', 'pending', CURRENT_TIMESTAMP)
  `);

  for (const p of proposals) {
    const contentHash = generateContentHash(p.sourceItem.url);

    try {
      insertStmt.run(
        p.id,
        p.title,
        p.summary,
        JSON.stringify({
          connectionToGoals: p.connectionToGoals,
          suggestedAction: p.suggestedAction,
          sourceItem: p.sourceItem,
        }),
        determineProposalType(p),
        determineRiskLevel(p),
        "discovery",
        p.sourceItem.source,
        p.sourceItem.url,
        contentHash,
        p.priorityScore
      );

      result.inserted++;

      // Track high-priority proposals for immediate notification
      if (p.priorityScore >= HIGH_SCORE_THRESHOLD) {
        result.highPriority.push(p);
      }

      logger.debug({ id: p.id, score: p.priorityScore }, "Proposal persisted");
    } catch (e) {
      const error = e as Error;
      // Duplicate (content_hash unique constraint) - skip silently
      if (error.message?.includes("UNIQUE constraint failed")) {
        result.skipped++;
        logger.debug({ url: p.sourceItem.url }, "Duplicate proposal skipped");
      } else {
        // Re-throw unexpected errors
        throw e;
      }
    }
  }

  logger.info(
    {
      inserted: result.inserted,
      skipped: result.skipped,
      highPriority: result.highPriority.length,
    },
    "Discovery persistence complete"
  );

  return result;
}

/**
 * Determine proposal type from discovery source
 */
function determineProposalType(p: DiscoveryProposal): string {
  const source = p.sourceItem.source;

  if (source === "github_trending") {
    return "research";
  }
  if (source === "hackernews") {
    // Check if it's a Show HN or Ask HN
    const title = p.title.toLowerCase();
    if (title.includes("show hn")) return "feature";
    if (title.includes("ask hn")) return "research";
    return "research";
  }
  if (source === "twitter_bookmarks") {
    return "research";
  }

  return "research";
}

/**
 * Determine risk level based on proposal content
 */
function determineRiskLevel(p: DiscoveryProposal): string {
  // Higher scores = more relevant = lower risk of wasting time
  if (p.priorityScore >= HIGH_SCORE_THRESHOLD) return "low";
  if (p.priorityScore >= MEDIUM_SCORE_THRESHOLD) return "medium";
  return "low";  // Default to low - discovery items are just research
}

/**
 * Check if a URL has already been processed
 */
export function isAlreadyProcessed(url: string, db: Database.Database): boolean {
  const contentHash = generateContentHash(url);
  const result = db.prepare(
    "SELECT 1 FROM proposals WHERE content_hash = ?"
  ).get(contentHash);
  return !!result;
}

/**
 * Get pending proposals for Telegram notification
 * Returns proposals that:
 * - Have approval_status = 'pending'
 * - Are not snoozed (snooze_until is NULL or in the past)
 * - Have no message_id yet (not already sent)
 */
export function getPendingProposalsForNotification(
  db: Database.Database,
  limit: number = 10
): Array<{
  id: string;
  title: string;
  summary: string;
  relevanceScore: number;
  source: string;
  sourceUrl: string;
}> {
  return db.prepare(`
    SELECT id, title, summary, relevance_score as relevanceScore,
           source, source_url as sourceUrl
    FROM proposals
    WHERE approval_status = 'pending'
      AND (snooze_until IS NULL OR snooze_until <= datetime('now'))
      AND message_id IS NULL
    ORDER BY relevance_score DESC
    LIMIT ?
  `).all(limit) as Array<{
    id: string;
    title: string;
    summary: string;
    relevanceScore: number;
    source: string;
    sourceUrl: string;
  }>;
}

/**
 * Mark a proposal as notified (store message_id)
 */
export function markProposalNotified(
  proposalId: string,
  chatId: number,
  messageId: number,
  db: Database.Database
): void {
  db.prepare(`
    UPDATE proposals
    SET chat_id = ?, message_id = ?
    WHERE id = ?
  `).run(chatId, messageId, proposalId);
}
