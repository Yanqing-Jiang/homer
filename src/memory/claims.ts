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

export type ClaimType = "fact" | "decision" | "preference" | "question" | "lesson";
export type ClaimStatus = "candidate" | "applying" | "approved" | "rejected" | "expired" | "stale" | "archived";
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

  const reviewAt = candidate.claimType === "decision"
    ? new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 19).replace("T", " ")
    : null;

  // Write session_id + source_url directly (inlined from former claim_sources table)
  const sessionId = candidate.sessionIds?.[0] ?? null;

  db.prepare(`
    INSERT INTO knowledge_claims (
      id, content, content_hash, target_file, section,
      claim_type, confidence, status, review_at, session_id, source_url, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, datetime('now'))
  `).run(id, candidate.content, hash, candidate.targetFile, candidate.section,
    candidate.claimType, candidate.confidence, reviewAt, sessionId, candidate.sourceUrl ?? null);

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
  if (!["candidate", "stale"].includes(claim.status)) return false;

  // Transition: candidate → applying (crash-safe intermediate state)
  db.prepare(`
    UPDATE knowledge_claims SET status = 'applying', updated_at = datetime('now') WHERE id = ?
  `).run(claimId);

  try {
    // Write to canonical memory file (preserve original source if known)
    const source = claim.status === "stale" ? "weekly" : "nightly";
    await canonicalMemory.promoteToFile(
      claim.content,
      claim.target_file,
      claim.section,
      source,
    );

    // Transition: applying → approved
    db.prepare(`
      UPDATE knowledge_claims
      SET status = 'approved', decided_at = datetime('now'), decided_by = 'user', updated_at = datetime('now')
      WHERE id = ?
    `).run(claimId);

    logger.info({ claimId, target: claim.target_file }, "Candidate approved and promoted");
    return true;
  } catch (err) {
    // Rollback: applying → candidate/stale (so user can retry)
    db.prepare(`
      UPDATE knowledge_claims SET status = 'candidate', updated_at = datetime('now') WHERE id = ? AND status = 'applying'
    `).run(claimId);

    const msg = err instanceof Error ? err.message : String(err);
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
): boolean {
  const result = db.prepare(`
    UPDATE knowledge_claims
    SET status = 'rejected', decided_at = datetime('now'), decided_by = 'user', updated_at = datetime('now')
    WHERE id = ? AND status = 'candidate'
  `).run(claimId);

  if (result.changes > 0) {
    logger.info({ claimId }, "Candidate rejected");
  }

  return result.changes > 0;
}

/**
 * Edit a claim's content and approve it. Works for candidate and stale claims (lint: update).
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

  if (!claim || !["candidate", "stale"].includes(claim.status)) return false;

  const newHash = contentHash(newContent, claim.target_file);

  // Update content + hash
  db.prepare(`
    UPDATE knowledge_claims
    SET content = ?, content_hash = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(newContent, newHash, claimId);

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

  // Last 7 days activity — derived from knowledge_claims directly
  const last7 = db.prepare(`
    SELECT
      SUM(CASE WHEN created_at > datetime('now', '-7 days') THEN 1 ELSE 0 END) as created,
      SUM(CASE WHEN decided_at > datetime('now', '-7 days') AND status = 'approved' THEN 1 ELSE 0 END) as approved,
      SUM(CASE WHEN decided_at > datetime('now', '-7 days') AND status = 'rejected' THEN 1 ELSE 0 END) as rejected,
      SUM(CASE WHEN decided_at > datetime('now', '-7 days') AND status = 'expired' THEN 1 ELSE 0 END) as expired
    FROM knowledge_claims
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
 * Mark a claim as validated (lint: keep). Works on any non-archived claim.
 */
export function markClaimValidated(db: Database.Database, claimId: string): boolean {
  const result = db.prepare(`
    UPDATE knowledge_claims
    SET status = 'approved', updated_at = datetime('now')
    WHERE id = ? AND status NOT IN ('archived', 'expired')
  `).run(claimId);

  return result.changes > 0;
}

/**
 * Archive a claim (lint: remove).
 */
export function archiveClaim(db: Database.Database, claimId: string): boolean {
  const result = db.prepare(`
    UPDATE knowledge_claims
    SET status = 'archived', updated_at = datetime('now'), decided_at = datetime('now'), decided_by = 'user'
    WHERE id = ? AND status IN ('approved', 'candidate')
  `).run(claimId);

  return result.changes > 0;
}

/**
 * Flag approved claims as stale based on lint findings from weekly consolidation.
 * Matches findings to claims by content substring + target file.
 * Returns matched claim IDs (for Telegram delivery).
 */
export function flagClaimsStale(
  db: Database.Database,
  findings: Array<{ file: string; stale_text: string; reason: string; suggestion: string }>,
): KnowledgeClaim[] {
  const staleClaims: KnowledgeClaim[] = [];

  for (const finding of findings) {
    const targetFile = finding.file.replace(/\.md$/, "");
    // Try to match by first 50 chars of the stale text
    const searchText = finding.stale_text.slice(0, 50).replace(/'/g, "''");

    const matched = db.prepare(`
      SELECT * FROM knowledge_claims
      WHERE status = 'approved' AND target_file = ? AND content LIKE ?
      LIMIT 1
    `).get(targetFile, `%${searchText}%`) as any | undefined;

    if (matched) {
      db.prepare(`
        UPDATE knowledge_claims SET status = 'stale', updated_at = datetime('now') WHERE id = ?
      `).run(matched.id);

      staleClaims.push({
        id: matched.id,
        content: matched.content,
        contentHash: matched.content_hash,
        targetFile: matched.target_file,
        section: matched.section,
        claimType: matched.claim_type,
        confidence: matched.confidence,
        status: "stale" as ClaimStatus,
        reviewAt: matched.review_at ?? null,
        telegramMessageId: matched.telegram_message_id ?? null,
        createdAt: matched.created_at,
        decidedAt: matched.decided_at ?? null,
        decidedBy: matched.decided_by ?? null,
      });
    } else {
      // No matching claim — create a synthetic one for the lint finding
      const id = claimId();
      const hash = contentHash(finding.stale_text, targetFile);
      db.prepare(`
        INSERT OR IGNORE INTO knowledge_claims (id, content, content_hash, target_file, section, claim_type, confidence, status, created_at)
        VALUES (?, ?, ?, ?, null, 'fact', 0.5, 'stale', datetime('now'))
      `).run(id, finding.stale_text, hash, targetFile);

      staleClaims.push({
        id,
        content: `${finding.stale_text} — ${finding.reason}`,
        contentHash: hash,
        targetFile: targetFile as TargetFile,
        section: null,
        claimType: "fact",
        confidence: 0.5,
        status: "stale" as ClaimStatus,
        reviewAt: null,
        telegramMessageId: null,
        createdAt: new Date().toISOString(),
        decidedAt: null,
        decidedBy: null,
      });
    }
  }

  if (staleClaims.length > 0) {
    logger.info({ count: staleClaims.length }, "Flagged claims as stale from lint findings");
  }

  return staleClaims;
}
