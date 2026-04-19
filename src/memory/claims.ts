/**
 * Knowledge Claims Service — human-gated memory evolution.
 *
 * Manages the claim lifecycle: candidate → applying → approved / rejected / expired.
 * All memory promotions route through here — HITL is permanent policy. Confidence-based routing:
 *   >= 0.95       → auto-approve (write directly, no Telegram prompt)
 *   0.20 … 0.95   → HITL (candidate queued for user review on Telegram)
 *   < 0.20        → dropped upstream as noise
 */

import { createHash } from "crypto";
// @ts-ignore
import type Database from "better-sqlite3";
import { logger } from "../utils/logger.js";
import type { CanonicalMemoryService } from "./canonical-service.js";

// ── Types ────────────────────────────────────────────────────

export type ClaimType =
  | "fact"
  | "decision"
  | "preference"
  | "hypothesis"
  | "insight"
  | "commitment"
  | "question"
  | "lesson"
  | "skill"
  | "cleanup"
  | "replace"
  | "remove";
export type ClaimStatus = "candidate" | "applying" | "approved" | "rejected" | "expired" | "stale" | "archived";

// Phase 0.9: TargetFile is derived from the canonical file registry (SSoT).
// Existing imports of TargetFile keep working; new code should prefer
// CanonicalFileKey from "./registry.js" directly.
import type { CanonicalFileKey } from "./registry.js";
export type TargetFile = CanonicalFileKey;

export type OriginChannel =
  | "nightly-extractor"
  | "weekly-consolidation"
  | "telegram-review"
  | "mcp-suggest"
  | "mcp-promote"
  | "mcp-replace"
  | "mcp-remove"
  | "canonical-backfill"
  | "weekly-audit"
  | "unknown";

export interface ClaimCandidate {
  content: string;
  targetFile: TargetFile;
  section: string;
  claimType: ClaimType;
  confidence: number;
  sessionIds?: string[];
  sourceUrl?: string;
  originChannel?: OriginChannel;
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

function contentHash(content: string, targetFile: string, section?: string | null): string {
  return createHash("sha256")
    .update(content.trim().toLowerCase().replace(/\s+/g, " ") + "::" + targetFile + "::" + (section ?? ""))
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
  const hash = contentHash(candidate.content, candidate.targetFile, candidate.section);

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
      claim_type, confidence, status, review_at, session_id, source_url, origin_channel, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, datetime('now'))
  `).run(id, candidate.content, hash, candidate.targetFile, candidate.section,
    candidate.claimType, candidate.confidence, reviewAt, sessionId, candidate.sourceUrl ?? null,
    candidate.originChannel ?? "unknown");

  logger.info({ claimId: id, type: candidate.claimType, confidence: candidate.confidence, target: candidate.targetFile },
    "Inserted candidate claim");

  return id;
}

/**
 * Claim types that still mirror to ~/memory/*.md on approval.
 *
 * Post-bridge-retirement (2026-04-17), operational facts (fact/decision/
 * question/insight/commitment/lesson/hypothesis) live in `knowledge_claims`
 * only and are reached via homer-memory MCP + knowledge_claims_fts. Preferences
 * remain file-backed because they're durable identity/workflow guidance that
 * belongs in human-readable `~/memory/preferences.md`.
 *
 * Special applicators (cleanup/skill/replace/remove) route through dedicated
 * handlers, not this set.
 */
const DURABLE_MARKDOWN_TYPES = new Set(["preference"]);

/**
 * Approve a candidate claim. Durable types still mirror to markdown;
 * operational types stay DB-only and are reached via knowledge_claims_fts.
 * Idempotent: returns true if approved (or already approved), false if not in approvable state.
 */
export async function approveCandidate(
  db: Database.Database,
  claimId: string,
  canonicalMemory: CanonicalMemoryService,
): Promise<boolean> {
  const claim = db.prepare(`
    SELECT id, content, target_file, section, claim_type, status FROM knowledge_claims WHERE id = ?
  `).get(claimId) as { id: string; content: string; target_file: string; section: string | null; claim_type: string; status: string } | undefined;

  if (!claim) return false;
  if (claim.status === "approved") return true; // idempotent
  if (!["candidate", "stale"].includes(claim.status)) return false;

  // Transition: candidate/stale → applying (crash-safe intermediate state, race-safe)
  const transition = db.prepare(`
    UPDATE knowledge_claims SET status = 'applying', updated_at = datetime('now')
    WHERE id = ? AND status IN ('candidate', 'stale')
  `).run(claimId);
  if (transition.changes === 0) return false; // lost race or already processing

  const originalStatus = claim.status; // preserve for rollback

  try {
    // Route by claim type
    if (claim.claim_type === "cleanup") {
      await applyCleanupClaim(claim, canonicalMemory);
    } else if (claim.claim_type === "skill") {
      await applySkillClaim(claim, canonicalMemory);
    } else if (claim.claim_type === "replace") {
      await applyReplaceClaim(claim, canonicalMemory);
    } else if (claim.claim_type === "remove") {
      await applyRemoveClaim(claim, canonicalMemory);
    } else if (DURABLE_MARKDOWN_TYPES.has(claim.claim_type)) {
      // Durable types (preference) still mirror to ~/memory/*.md
      const source = originalStatus === "stale" ? "weekly" : "nightly";
      const written = await canonicalMemory.promoteToFile(
        claim.content,
        claim.target_file,
        claim.section,
        source,
        { claimId, actor: "user" },
      );
      // promoteToFile returns false for security-scan blocks OR section-aware dedup hits.
      // Don't mark the claim 'approved' in that case — revert to candidate so the user
      // can retry after the duplicate clears or the content is edited.
      if (!written) {
        db.prepare(`
          UPDATE knowledge_claims SET status = 'candidate', updated_at = datetime('now')
          WHERE id = ? AND status = 'applying'
        `).run(claimId);
        logger.info({ claimId, target: claim.target_file }, "Candidate reverted — promoteToFile returned false (scan block or duplicate)");
        return false;
      }
    } else {
      // Operational types (fact/decision/question/insight/commitment/lesson/hypothesis)
      // stay DB-native. The knowledge_claims_fts trigger keeps search in sync
      // automatically; no markdown write. CanonicalMemoryService indexing path
      // would duplicate content into file FTS — skip it.
      logger.info(
        { claimId, target: claim.target_file, type: claim.claim_type },
        "Approved as DB-native claim (no markdown mirror)",
      );
    }

    // Transition: applying → approved (guarded)
    db.prepare(`
      UPDATE knowledge_claims
      SET status = 'approved', decided_at = datetime('now'), decided_by = 'user', updated_at = datetime('now')
      WHERE id = ? AND status = 'applying'
    `).run(claimId);

    logger.info({ claimId, target: claim.target_file, type: claim.claim_type }, "Candidate approved and promoted");
    return true;
  } catch (err) {
    // Rollback: applying → original status (so user can retry)
    db.prepare(`
      UPDATE knowledge_claims SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = 'applying'
    `).run(originalStatus, claimId);

    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ claimId, error: msg }, "Candidate approval failed — rolled back to %s", originalStatus);
    return false;
  }
}

/**
 * Apply a cleanup claim — extract cleaned content and overwrite the target file.
 */
async function applyCleanupClaim(
  claim: { id?: string; content: string; target_file: string },
  canonicalMemory: CanonicalMemoryService,
): Promise<void> {
  // Parse cleaned content from claim body (format: "--- Cleaned Content ---\n{content}")
  const cleanedMarker = "--- Cleaned Content ---";
  const idx = claim.content.indexOf(cleanedMarker);
  if (idx === -1) {
    throw new Error("Cleanup claim missing '--- Cleaned Content ---' marker");
  }
  const cleaned = claim.content.slice(idx + cleanedMarker.length).trim();
  if (!cleaned) {
    throw new Error("Cleanup claim has empty cleaned content");
  }

  // Phase 0.3 guard: whole-file rewrites are disabled until surgical cleanup claims land (Phase 1.3).
  // A hallucinated cleanup silently replacing an entire memory file is a data-loss hazard.
  // Cleanup claim is preserved in knowledge_claims for manual inspection; approval is blocked.
  const { PATHS } = await import("../config/paths.js");
  const filePath = `${PATHS.memory}/${claim.target_file}.md`;
  void cleaned;
  void filePath;
  void canonicalMemory;
  throw new Error(
    "Whole-file cleanup rewrites are disabled (Phase 0.3). " +
    "Approve will be re-enabled once surgical replace/remove claims land in Phase 1.3. " +
    "See ~/homer/output/homer-refactor-plan-final-2026-04-14.md"
  );
}

/**
 * Apply a skill claim — parse skill data and upsert.
 */
async function applySkillClaim(
  claim: { content: string; target_file: string },
  canonicalMemory: CanonicalMemoryService,
): Promise<void> {
  // Parse skill from claim content (format: "SKILL: {title}\n\nTrigger: {trigger}\n\n{body}")
  const lines = claim.content.split("\n");
  const titleLine = lines.find(l => l.startsWith("SKILL: "));
  const triggerLine = lines.find(l => l.startsWith("Trigger: "));

  const title = titleLine?.replace("SKILL: ", "").trim() ?? "untitled-skill";
  const trigger = triggerLine?.replace("Trigger: ", "").trim() ?? "";
  const bodyStart = lines.findIndex(l => l.startsWith("Trigger: "));
  const body = bodyStart >= 0 ? lines.slice(bodyStart + 1).join("\n").trim() : claim.content;

  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);

  await canonicalMemory.upsertSkill({
    id,
    title,
    status: "draft" as const,
    trigger,
    category: claim.target_file === "tools" ? "devops" : "general",
    source: "auto" as const,
    requires_approval: true,
    created: new Date().toISOString().slice(0, 10),
  }, body);
}

/**
 * Apply a replace claim — find old text and replace with new text in the target file.
 */
async function applyReplaceClaim(
  claim: { id?: string; content: string; target_file: string },
  canonicalMemory: CanonicalMemoryService,
): Promise<void> {
  const oldMarker = "--- Old Text ---";
  const newMarker = "--- New Text ---";
  const oldIdx = claim.content.indexOf(oldMarker);
  const newIdx = claim.content.indexOf(newMarker);

  if (oldIdx === -1 || newIdx === -1) {
    throw new Error("Replace claim missing '--- Old Text ---' or '--- New Text ---' markers");
  }

  const oldText = claim.content.slice(oldIdx + oldMarker.length, newIdx).trim();
  const newText = claim.content.slice(newIdx + newMarker.length).trim();

  if (!oldText) throw new Error("Replace claim has empty old text");

  const replaced = await canonicalMemory.replaceInFile(claim.target_file, oldText, newText, "replace-approved", { claimId: claim.id ?? null, actor: "user" });
  if (!replaced) {
    throw new Error(`Old text not found in ${claim.target_file}.md`);
  }
}

/**
 * Apply a remove claim — find and remove text from the target file.
 */
async function applyRemoveClaim(
  claim: { id?: string; content: string; target_file: string },
  canonicalMemory: CanonicalMemoryService,
): Promise<void> {
  const marker = "--- Text to Remove ---";
  const idx = claim.content.indexOf(marker);
  if (idx === -1) throw new Error("Remove claim missing '--- Text to Remove ---' marker");

  const textToRemove = claim.content.slice(idx + marker.length).trim();
  if (!textToRemove) throw new Error("Remove claim has empty text");

  const removed = await canonicalMemory.removeFromFile(claim.target_file, textToRemove, "remove-approved", { claimId: claim.id ?? null, actor: "user" });
  if (!removed) {
    throw new Error(`Text not found in ${claim.target_file}.md`);
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
    SELECT id, content, target_file, section, status FROM knowledge_claims WHERE id = ?
  `).get(claimId) as { id: string; content: string; target_file: string; section: string | null; status: string } | undefined;

  if (!claim || !["candidate", "stale"].includes(claim.status)) return false;

  const newHash = contentHash(newContent, claim.target_file, claim.section);

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
 * Get stale claims flagged by weekly lint, ordered by most recent.
 */
export function getStaleClaims(
  db: Database.Database,
  limit: number = 5,
): KnowledgeClaim[] {
  return db.prepare(`
    SELECT
      id, content, content_hash as contentHash, target_file as targetFile, section,
      claim_type as claimType, confidence, status, review_at as reviewAt,
      telegram_message_id as telegramMessageId, created_at as createdAt,
      decided_at as decidedAt, decided_by as decidedBy
    FROM knowledge_claims
    WHERE status = 'stale'
    ORDER BY updated_at DESC, created_at DESC
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
    WHERE id = ? AND status IN ('approved', 'candidate', 'stale')
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
  findings: Array<{ file: string; section?: string | null; stale_text: string; reason: string; suggestion: string }>,
): KnowledgeClaim[] {
  const staleClaims: KnowledgeClaim[] = [];

  for (const finding of findings) {
    const targetFile = finding.file.replace(/\.md$/, "");
    // Match by first 50 chars of the stale text. When the lint finding includes a section,
    // restrict to that section — section-blind matching can flag the wrong claim if the same
    // substring appears under multiple headings (e.g., "Active Projects" vs "Completed").
    // ORDER BY created_at ASC keeps the choice deterministic when section info is missing.
    const searchText = finding.stale_text.slice(0, 50).replace(/'/g, "''");
    const findingSection = (finding as { section?: string | null }).section ?? null;

    const matched = (findingSection !== null
      ? db.prepare(`
          SELECT * FROM knowledge_claims
          WHERE status = 'approved' AND target_file = ? AND section = ? AND content LIKE ?
          ORDER BY created_at ASC
          LIMIT 1
        `).get(targetFile, findingSection, `%${searchText}%`)
      : db.prepare(`
          SELECT * FROM knowledge_claims
          WHERE status = 'approved' AND target_file = ? AND content LIKE ?
          ORDER BY created_at ASC
          LIMIT 1
        `).get(targetFile, `%${searchText}%`)) as any | undefined;

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
