/**
 * Outcome tracking hooks — auto-create outcome_checks from events.
 *
 * Call these after significant state changes in ideas, applications,
 * promotions, and improvements. Each creates a future check.
 */

import type Database from "better-sqlite3";
import { markContextBridgeDirty } from "../state/context-bridge-state.js";
import { logger } from "../utils/logger.js";

function insertOutcomeCheck(
  db: Database.Database,
  sourceType: string,
  sourceId: string,
  sourceTitle: string,
  daysOut: number,
): void {
  const id = `oc_${sourceType}_${Date.now()}`;
  try {
    const result = db.prepare(`
      INSERT OR IGNORE INTO outcome_checks (id, source_type, source_id, source_title, check_at)
      VALUES (?, ?, ?, ?, datetime('now', ?))
    `).run(id, sourceType, sourceId, sourceTitle, `+${daysOut} days`);
    if (result.changes > 0) {
      markContextBridgeDirty(db, `outcome_${sourceType}`);
    }
    logger.debug({ id, sourceType, sourceTitle, daysOut }, "Created outcome check");
  } catch (err) {
    // Table may not exist yet — gracefully degrade
    logger.debug({ error: err }, "Could not create outcome check (table may not exist)");
  }
}

/**
 * When an idea transitions to discussion/planning → 14-day check
 */
export function trackIdeaProgress(
  db: Database.Database,
  ideaId: string,
  ideaTitle: string,
): void {
  insertOutcomeCheck(db, "idea", ideaId, ideaTitle, 14);
}

/**
 * When an idea is archived → 30-day check ("did it resurface?")
 */
export function trackIdeaArchived(
  db: Database.Database,
  ideaId: string,
  ideaTitle: string,
): void {
  insertOutcomeCheck(db, "idea", ideaId, ideaTitle, 30);
}

/**
 * When a job application is submitted → 14-day check ("any response?")
 */
export function trackApplicationSubmitted(
  db: Database.Database,
  jobId: string,
  jobTitle: string,
): void {
  insertOutcomeCheck(db, "application", jobId, jobTitle, 14);
}

/**
 * When a memory fact is promoted → 30-day check ("was it referenced?")
 */
export function trackPromotion(
  db: Database.Database,
  factTitle: string,
  targetFile: string,
): void {
  insertOutcomeCheck(db, "promotion", targetFile, factTitle, 30);
}

/**
 * When a homer-improvement is proposed → 7-day check
 */
export function trackImprovement(
  db: Database.Database,
  improvementId: string,
  improvementTitle: string,
): void {
  insertOutcomeCheck(db, "improvement", improvementId, improvementTitle, 7);
}
