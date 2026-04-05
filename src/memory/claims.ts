/**
 * Knowledge Claims Service — human-gated memory evolution.
 *
 * Manages the claim lifecycle: candidate → applying → approved / rejected / expired.
 * All memory promotions route through here when features.humanGatedMemory is enabled.
 */

import { createHash } from "crypto";
// @ts-ignore
import type Database from "better-sqlite3";
import { logger } from "../utils/logger.js";
import type { CanonicalMemoryService } from "./canonical-service.js";

// ── Types ────────────────────────────────────────────────────

export type ClaimType = "fact" | "decision" | "preference" | "hypothesis" | "insight" | "commitment" | "question" | "lesson";
export type ClaimStatus = "candidate" | "applying" | "approved" | "rejected" | "expired" | "superseded" | "stale" | "archived";
export type TargetFile = "me" | "work" | "life" | "preferences" | "tools";

export interface ClaimCandidate {
  content: string;
  targetFile: TargetFile;
  section: string;
  claimType: ClaimType;
  confidence: number;
  sessionIds?: string[];
  sourceUrl?: string;
}

export interface KnowledgeClaim {
  id: string;
  content: string;
  contentHash: string;
  targetFile: TargetFile;
  section: string | null;
  claimType: ClaimType;
  confidence: number;
  status: ClaimStatus;
  reviewAt: string | null;
  telegramMessageId: number | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface ClaimMetrics {
  candidate: number;
  approved: number;
  rejected: number;
  expired: number;
  total: number;
  medianQueueAgeDays: number | null;
  last7Days: { created: number; approved: number; rejected: number; expired: number };
}

// ── Helpers ──────────────────────────────────────────────────

function claimId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `kc_${ts}_${rand}`;
}

function contentHash(content: string, targetFile: string): string {
  return createHash("sha256")
    .update(content.trim().toLowerCase().replace(/\s+/g, " ") + "::" + targetFile)
    .digest("hex");
}

// ── Core Operations ──────────────────────────────────────────

/**
 * Insert a new candidate claim extracted by the nightly job.
 * Returns the claim ID, or null if duplicate (same content+target already pending/approved).
 */
export function insertCandidate(
  db: Database.Database,
  candidate: ClaimCandidate,
): string | null {
  const id = claimId();
  const hash = contentHash(candidate.content, candidate.targetFile);

  // Check for existing pending or approved claim with same hash
  const existing = db.prepare(`
    SELECT id FROM knowledge_claims
    WHERE content_hash = ? AND target_file = ? AND status NOT IN ('rejected', 'archived', 'expired')
    LIMIT 1
  `).get(hash, candidate.targetFile) as { id: string } | undefined;

  if (existing) {
    logger.debug({ hash, existingId: existing.id }, "Skipping duplicate claim candidate");
    return null;
  }

  const reviewAt = ["decision", "hypothesis", "commitment"].includes(candidate.claimType)
    ? new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 19).replace("T", " ")
    : null;

  db.prepare(`
    INSERT INTO knowledge_claims (
      id, content, content_hash, target_file, section,
      claim_type, confidence, status, review_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?, datetime('now'))
  `).run(id, candidate.content, hash, candidate.targetFile, candidate.section,
    candidate.claimType, candidate.confidence, reviewAt);

  // Insert provenance sources
  if (candidate.sessionIds?.length) {
    const stmt = db.prepare(`
      INSERT INTO claim_sources (claim_id, session_id, source_url, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `);
    for (const sessionId of candidate.sessionIds) {
      stmt.run(id, sessionId, candidate.sourceUrl ?? null);
    }
  } else if (candidate.sourceUrl) {
    db.prepare(`
      INSERT INTO claim_sources (claim_id, source_url, created_at)
      VALUES (?, ?, datetime('now'))
    `).run(id, candidate.sourceUrl);
  }

  // Log creation event
  db.prepare(`
    INSERT INTO claim_events (claim_id, event_type, actor, content, created_at)
    VALUES (?, 'created', 'nightly', ?, datetime('now'))
  `).run(id, `confidence=${candidate.confidence.toFixed(2)}, type=${candidate.claimType}`);

  logger.info({ claimId: id, type: candidate.claimType, confidence: candidate.confidence, target: candidate.targetFile },
    "Inserted candidate claim");

  return id;
}

/**
 * Approve a candidate claim. Promotes to canonical memory file.
 * Idempotent: returns true if approved (or already approved), false if not in approvable state.
 */
export async function approveCandidate(
  db: Database.Database,
  claimId: string,
  canonicalMemory: CanonicalMemoryService,
): Promise<boolean> {
  const claim = db.prepare(`
    SELECT id, content, target_file, section, status FROM knowledge_claims WHERE id = ?
  `).get(claimId) as { id: string; content: string; target_file: string; section: string | null; status: string } | undefined;

  if (!claim) return false;
  if (claim.status === "approved") return true; // idempotent
  if (claim.status !== "candidate") return false; // only candidates can be approved

  // Transition: candidate → applying
  db.prepare(`
    UPDATE knowledge_claims SET status = 'applying', updated_at = datetime('now') WHERE id = ?
  `).run(claimId);

  try {
    // Write to canonical memory file
    const promoted = await canonicalMemory.promoteToFile(
      claim.content,
      claim.target_file,
      claim.section,
      "mcp", // source: goes through the standard write path
    );

    // Transition: applying → approved
    db.prepare(`
      UPDATE knowledge_claims
      SET status = 'approved', decided_at = datetime('now'), decided_by = 'user', updated_at = datetime('now'),
          promoted_fact_hash = ?
      WHERE id = ?
    `).run(
      contentHash(claim.content, claim.target_file),
      claimId,
    );

    db.prepare(`
      INSERT INTO claim_events (claim_id, event_type, actor, content, created_at)
      VALUES (?, 'approved', 'user', ?, datetime('now'))
    `).run(claimId, promoted ? "promoted to file" : "already existed in file (CAS dedup)");

    logger.info({ claimId, target: claim.target_file }, "Candidate approved and promoted");
    return true;
  } catch (err) {
    // Rollback: applying → candidate (so user can retry)
    db.prepare(`
      UPDATE knowledge_claims SET status = 'candidate', updated_at = datetime('now') WHERE id = ? AND status = 'applying'
    `).run(claimId);

    const msg = err instanceof Error ? err.message : String(err);
    db.prepare(`
      INSERT INTO claim_events (claim_id, event_type, actor, content, created_at)
      VALUES (?, 'disputed', 'system', ?, datetime('now'))
    `).run(claimId, `approval failed: ${msg}`);

    logger.error({ claimId, error: msg }, "Candidate approval failed — rolled back to candidate");
    return false;
  }
}

/**
 * Reject a candidate claim with optional reason.
 */
export function rejectCandidate(
  db: Database.Database,
  claimId: string,
  reason?: string,
): boolean {
  const result = db.prepare(`
    UPDATE knowledge_claims
    SET status = 'rejected', decided_at = datetime('now'), decided_by = 'user', updated_at = datetime('now')
    WHERE id = ? AND status = 'candidate'
  `).run(claimId);

  if (result.changes === 0) return false;

  db.prepare(`
    INSERT INTO claim_events (claim_id, event_type, actor, content, created_at)
    VALUES (?, 'rejected', 'user', ?, datetime('now'))
  `).run(claimId, reason ?? null);

  logger.info({ claimId, reason }, "Candidate rejected");
  return true;
}

/**
 * Edit a candidate's content and approve it.
 */
export async function editAndApprove(
  db: Database.Database,
  claimId: string,
  newContent: string,
  canonicalMemory: CanonicalMemoryService,
): Promise<boolean> {
  const claim = db.prepare(`
    SELECT id, content, target_file, status FROM knowledge_claims WHERE id = ?
  `).get(claimId) as { id: string; content: string; target_file: string; status: string } | undefined;

  if (!claim || claim.status !== "candidate") return false;

  const newHash = contentHash(newContent, claim.target_file);

  // Update content + hash
  db.prepare(`
    UPDATE knowledge_claims
    SET content = ?, content_hash = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(newContent, newHash, claimId);

  // Log the edit
  db.prepare(`
    INSERT INTO claim_events (claim_id, event_type, actor, content, metadata_json, created_at)
    VALUES (?, 'edited', 'user', ?, ?, datetime('now'))
  `).run(claimId, newContent, JSON.stringify({ original: claim.content }));

  // Now approve the edited claim
  return approveCandidate(db, claimId, canonicalMemory);
}

/**
 * Expire stale candidates older than maxAgeDays. Returns count expired.
 */
export function expireStaleCandidates(db: Database.Database, maxAgeDays: number = 7): number {
  const result = db.prepare(`
    UPDATE knowledge_claims
    SET status = 'expired', decided_at = datetime('now'), decided_by = 'auto-expire', updated_at = datetime('now')
    WHERE status = 'candidate'
      AND created_at < datetime('now', ?)
  `).run(`-${maxAgeDays} days`);

  if (result.changes > 0) {
    // Bulk log expiry events
    db.prepare(`
      INSERT INTO claim_events (claim_id, event_type, actor, content, created_at)
      SELECT id, 'expired', 'system', 'auto-expired after ${maxAgeDays} days', datetime('now')
      FROM knowledge_claims
      WHERE status = 'expired' AND decided_by = 'auto-expire' AND decided_at > datetime('now', '-1 minute')
    `).run();

    logger.info({ expired: result.changes, maxAgeDays }, "Expired stale candidates");
  }

  // Also catch stuck 'applying' state (>1 hour = likely crash during approval)
  const stuck = db.prepare(`
    UPDATE knowledge_claims
    SET status = 'candidate', updated_at = datetime('now')
    WHERE status = 'applying'
      AND updated_at < datetime('now', '-1 hour')
  `).run();

  if (stuck.changes > 0) {
    logger.warn({ count: stuck.changes }, "Reset stuck 'applying' claims back to candidate");
  }

  return result.changes;
}

/**
 * Auto-approve high-confidence candidates when queue is backing up.
 * Called as a safety valve to prevent memory starvation.
 */
export async function autoApproveHighConfidence(
  db: Database.Database,
  canonicalMemory: CanonicalMemoryService,
  minConfidence: number = 0.8,
): Promise<number> {
  const candidates = db.prepare(`
    SELECT id FROM knowledge_claims
    WHERE status = 'candidate' AND confidence >= ?
    ORDER BY confidence DESC
    LIMIT 10
  `).all(minConfidence) as Array<{ id: string }>;

  let approved = 0;
  for (const c of candidates) {
    const ok = await approveCandidate(db, c.id, canonicalMemory);
    if (ok) {
      // Override decided_by to indicate auto-approval
      db.prepare(`UPDATE knowledge_claims SET decided_by = 'auto-approve' WHERE id = ?`).run(c.id);
      approved++;
    }
  }

  if (approved > 0) {
    logger.info({ approved, minConfidence }, "Auto-approved high-confidence candidates (queue health fallback)");
  }

  return approved;
}

// ── Queries ──────────────────────────────────────────────────

/**
 * Get pending candidates, ordered by confidence DESC.
 */
export function getPendingCandidates(
  db: Database.Database,
  limit: number = 10,
): KnowledgeClaim[] {
  return db.prepare(`
    SELECT
      id, content, content_hash as contentHash, target_file as targetFile, section,
      claim_type as claimType, confidence, status, review_at as reviewAt,
      telegram_message_id as telegramMessageId, created_at as createdAt,
      decided_at as decidedAt, decided_by as decidedBy
    FROM knowledge_claims
    WHERE status = 'candidate'
    ORDER BY confidence DESC, created_at ASC
    LIMIT ?
  `).all(limit) as KnowledgeClaim[];
}

/**
 * Get a single claim by ID.
 */
export function getClaim(db: Database.Database, claimId: string): KnowledgeClaim | null {
  return (db.prepare(`
    SELECT
      id, content, content_hash as contentHash, target_file as targetFile, section,
      claim_type as claimType, confidence, status, review_at as reviewAt,
      telegram_message_id as telegramMessageId, created_at as createdAt,
      decided_at as decidedAt, decided_by as decidedBy
    FROM knowledge_claims
    WHERE id = ?
  `).get(claimId) as KnowledgeClaim | undefined) ?? null;
}

/**
 * Find a claim by telegram_message_id.
 */
export function getClaimByTelegramMessage(db: Database.Database, messageId: number): KnowledgeClaim | null {
  return (db.prepare(`
    SELECT
      id, content, content_hash as contentHash, target_file as targetFile, section,
      claim_type as claimType, confidence, status, review_at as reviewAt,
      telegram_message_id as telegramMessageId, created_at as createdAt,
      decided_at as decidedAt, decided_by as decidedBy
    FROM knowledge_claims
    WHERE telegram_message_id = ?
  `).get(messageId) as KnowledgeClaim | undefined) ?? null;
}

/**
 * Update telegram_message_id on a claim (after sending the Telegram card).
 */
export function setClaimTelegramMessage(db: Database.Database, claimId: string, messageId: number): void {
  db.prepare(`UPDATE knowledge_claims SET telegram_message_id = ? WHERE id = ?`).run(messageId, claimId);
}

/**
 * Get queue health metrics.
 */
export function getClaimMetrics(db: Database.Database): ClaimMetrics {
  const statusCounts = db.prepare(`
    SELECT status, COUNT(*) as count FROM knowledge_claims GROUP BY status
  `).all() as Array<{ status: string; count: number }>;

  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of statusCounts) {
    counts[row.status] = row.count;
    total += row.count;
  }

  // Median queue age for pending candidates
  const ages = db.prepare(`
    SELECT julianday('now') - julianday(created_at) as ageDays
    FROM knowledge_claims WHERE status = 'candidate'
    ORDER BY ageDays
  `).all() as Array<{ ageDays: number }>;

  const medianEntry = ages.length > 0 ? ages[Math.floor(ages.length / 2)] : undefined;
  const medianAge = medianEntry?.ageDays ?? null;

  // Last 7 days activity
  const last7 = db.prepare(`
    SELECT
      SUM(CASE WHEN event_type = 'created' THEN 1 ELSE 0 END) as created,
      SUM(CASE WHEN event_type = 'approved' THEN 1 ELSE 0 END) as approved,
      SUM(CASE WHEN event_type = 'rejected' THEN 1 ELSE 0 END) as rejected,
      SUM(CASE WHEN event_type = 'expired' THEN 1 ELSE 0 END) as expired
    FROM claim_events
    WHERE created_at > datetime('now', '-7 days')
  `).get() as { created: number | null; approved: number | null; rejected: number | null; expired: number | null };

  return {
    candidate: counts["candidate"] ?? 0,
    approved: counts["approved"] ?? 0,
    rejected: counts["rejected"] ?? 0,
    expired: counts["expired"] ?? 0,
    total,
    medianQueueAgeDays: medianAge ? Math.round(medianAge * 10) / 10 : null,
    last7Days: {
      created: last7.created ?? 0,
      approved: last7.approved ?? 0,
      rejected: last7.rejected ?? 0,
      expired: last7.expired ?? 0,
    },
  };
}

/**
 * Mark a stale claim as validated (lint: keep).
 */
export function markClaimValidated(db: Database.Database, claimId: string): boolean {
  const result = db.prepare(`
    UPDATE knowledge_claims
    SET status = 'approved', updated_at = datetime('now')
    WHERE id = ? AND status = 'stale'
  `).run(claimId);

  if (result.changes > 0) {
    db.prepare(`
      INSERT INTO claim_events (claim_id, event_type, actor, content, created_at)
      VALUES (?, 'lint_resolved', 'user', 'marked as still valid', datetime('now'))
    `).run(claimId);
  }

  return result.changes > 0;
}

/**
 * Archive a claim (lint: remove).
 */
export function archiveClaim(db: Database.Database, claimId: string): boolean {
  const result = db.prepare(`
    UPDATE knowledge_claims
    SET status = 'archived', updated_at = datetime('now'), decided_at = datetime('now'), decided_by = 'user'
    WHERE id = ? AND status IN ('approved', 'stale')
  `).run(claimId);

  if (result.changes > 0) {
    db.prepare(`
      INSERT INTO claim_events (claim_id, event_type, actor, content, created_at)
      VALUES (?, 'lint_resolved', 'user', 'archived via lint review', datetime('now'))
    `).run(claimId);
  }

  return result.changes > 0;
}
