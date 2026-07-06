/**
 * Phase 1.4 — code_push_proposals lifecycle.
 *
 * A proposal pins the HEAD sha + unpushed-commit fingerprint at preview time. Approve
 * only executes a push if HEAD still matches; otherwise the proposal is marked `stale`
 * and a new preview must be generated.
 */

import { execSync } from "child_process";
// @ts-ignore
import type Database from "better-sqlite3";
import { logger } from "../utils/logger.js";
import { PATHS } from "../config/paths.js";

export const PROJECT_DIR = PATHS.homerRoot;
const PROPOSAL_TTL_HOURS = 12;

export interface CodePushProposal {
  id: string;
  headSha: string;
  unpushedCount: number;
  diffStat: string;
  commitSubjects: string;
  status: "pending" | "approved" | "denied" | "expired" | "executed" | "failed" | "stale";
  telegramMessageId: number | null;
  telegramChatId: number | null;
  createdAt: string;
  expiresAt: string;
}

export interface RecordCodePushProposalInput {
  headSha: string;
  unpushedCount: number;
  diffStat: string;
  commitSubjects: string;
}

function proposalId(): string {
  return `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function rowToProposal(row: Record<string, unknown>): CodePushProposal {
  return {
    id: row.id as string,
    headSha: row.head_sha as string,
    unpushedCount: row.unpushed_count as number,
    diffStat: row.diff_stat as string,
    commitSubjects: row.commit_subjects as string,
    status: row.status as CodePushProposal["status"],
    telegramMessageId: (row.telegram_message_id as number | null) ?? null,
    telegramChatId: (row.telegram_chat_id as number | null) ?? null,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
  };
}

/**
 * Insert a new proposal. Any previous open proposal (pending/approved) is
 * superseded (marked `expired`) first so the partial-unique index on status stays clean.
 */
export function recordCodePushProposal(
  db: Database.Database,
  input: RecordCodePushProposalInput,
): string {
  db.prepare(`
    UPDATE code_push_proposals
    SET status='expired', decided_at=datetime('now'), decision_reason='superseded'
    WHERE status IN ('pending','approved')
  `).run();

  const id = proposalId();
  const expiresAt = new Date(Date.now() + PROPOSAL_TTL_HOURS * 3_600_000)
    .toISOString().slice(0, 19).replace("T", " ");

  db.prepare(`
    INSERT INTO code_push_proposals (
      id, head_sha, unpushed_count, diff_stat, commit_subjects,
      status, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), ?)
  `).run(
    id,
    input.headSha,
    input.unpushedCount,
    input.diffStat,
    input.commitSubjects,
    expiresAt,
  );

  logger.info(
    { proposalId: id, headSha: input.headSha.slice(0, 10), unpushedCount: input.unpushedCount },
    "Recorded code_push proposal",
  );
  return id;
}

/**
 * Find an open (pending or approved) proposal. If more than one exists due to a
 * failed supersede, returns the newest; callers should treat older ones as stale.
 */
export function findOpenCodePushProposal(
  db: Database.Database,
  status: "pending" | "approved",
): CodePushProposal | null {
  const row = db.prepare(`
    SELECT * FROM code_push_proposals
    WHERE status = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(status) as Record<string, unknown> | undefined;
  return row ? rowToProposal(row) : null;
}

export function getCodePushProposal(
  db: Database.Database,
  id: string,
): CodePushProposal | null {
  const row = db.prepare(`SELECT * FROM code_push_proposals WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToProposal(row) : null;
}

/**
 * Mark a proposal approved. Called by the Telegram callback handler.
 * No-op (returns false) if the proposal isn't pending.
 */
export function markCodePushApproved(
  db: Database.Database,
  id: string,
): boolean {
  const result = db.prepare(`
    UPDATE code_push_proposals
    SET status='approved', decided_at=datetime('now')
    WHERE id = ? AND status = 'pending'
  `).run(id);
  return result.changes > 0;
}

export function markCodePushDenied(
  db: Database.Database,
  id: string,
  reason?: string,
): boolean {
  const result = db.prepare(`
    UPDATE code_push_proposals
    SET status='denied', decided_at=datetime('now'), decision_reason=?
    WHERE id = ? AND status = 'pending'
  `).run(reason ?? null, id);
  return result.changes > 0;
}

/**
 * Expire proposals whose TTL has passed. Returns count expired.
 */
export function expireStaleCodePushProposals(db: Database.Database): number {
  const result = db.prepare(`
    UPDATE code_push_proposals
    SET status='expired', decided_at=datetime('now'), decision_reason='ttl'
    WHERE status IN ('pending','approved') AND expires_at < datetime('now')
  `).run();
  if (result.changes > 0) {
    logger.info({ count: result.changes }, "Expired stale code_push proposals");
  }
  return result.changes;
}

/**
 * Execute an approved proposal. Revalidates HEAD against the worktree before pushing.
 * Caller provides the actual push implementation so we can stub it in tests.
 */
export async function executeApprovedCodePush(
  db: Database.Database,
  id: string,
  opts: { pushOnce: () => Promise<{ ok: true } | { ok: false; error: string }> },
): Promise<{ success: boolean; output: string; error?: string }> {
  const proposal = getCodePushProposal(db, id);
  if (!proposal) return { success: false, output: "", error: `Proposal ${id} not found` };
  if (proposal.status !== "approved") {
    return { success: false, output: "", error: `Proposal ${id} not in 'approved' state (was '${proposal.status}')` };
  }

  // Revalidate HEAD
  let liveHead: string;
  try {
    liveHead = execSync("git rev-parse HEAD", { cwd: PROJECT_DIR, encoding: "utf-8", timeout: 5_000 }).trim();
  } catch (err) {
    return { success: false, output: "", error: `Failed to read HEAD: ${(err as Error).message}` };
  }
  if (liveHead !== proposal.headSha) {
    db.prepare(`UPDATE code_push_proposals SET status='stale', decided_at=datetime('now'), decision_reason='head_drift' WHERE id=?`)
      .run(id);
    return {
      success: false,
      output: "",
      error: `HEAD drifted since approval (was ${proposal.headSha.slice(0, 10)}, now ${liveHead.slice(0, 10)}) — proposal marked stale`,
    };
  }

  const result = await opts.pushOnce();
  if (result.ok) {
    db.prepare(`UPDATE code_push_proposals SET status='executed', executed_at=datetime('now') WHERE id=?`).run(id);
    logger.info({ proposalId: id, headSha: proposal.headSha.slice(0, 10) }, "code_push executed");
    return { success: true, output: `Pushed ${proposal.unpushedCount} commit(s)` };
  } else {
    db.prepare(`UPDATE code_push_proposals SET status='failed', decision_reason=? WHERE id=?`)
      .run(result.error.slice(0, 500), id);
    return { success: false, output: "", error: result.error };
  }
}
