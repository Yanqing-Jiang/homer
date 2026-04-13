/**
 * Undo support — invert a recent memory_mutations row.
 *
 * The mutation ledger stores pre/post SHA256 hashes for every write. Undo:
 *   1. Looks up the latest mutation for a claim.
 *   2. Reads the current file and verifies its hash matches mutation.post_hash.
 *      If not, an external edit happened — refuse the undo and surface the conflict.
 *   3. Applies the inverse operation.
 *   4. Records a compensating mutation row tagged source='undo'.
 *
 * This is the reason the mutation ledger exists. Without it, undo would be
 * substring-removal that could hit the wrong instance.
 */

import { readFile, writeFile, rename } from "fs/promises";
import { createHash } from "crypto";
import { basename, dirname, join } from "path";
import { logger } from "../utils/logger.js";
import type { StateManager } from "../state/manager.js";

interface MutationRow {
  id: string;
  claim_id: string | null;
  target_file: string;
  section: string | null;
  operation: "append" | "replace" | "remove" | "write";
  old_text: string | null;
  new_text: string | null;
  pre_hash: string;
  post_hash: string;
  source: string;
  actor: string;
  created_at: string;
}

export interface UndoResult {
  ok: boolean;
  reason: string;
  mutationId?: string;
  conflict?: { expectedHash: string; actualHash: string };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = join(dirname(path), `.tmp-undo-${basename(path)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, path);
}

function readFileSafe(path: string): Promise<string> {
  return readFile(path, "utf-8").catch(() => "");
}

export async function undoLatestForClaim(sm: StateManager, claimId: string): Promise<UndoResult> {
  const db = sm.getDb();
  const row = db.prepare(`
    SELECT id, claim_id, target_file, section, operation, old_text, new_text,
           pre_hash, post_hash, source, actor, created_at
    FROM memory_mutations
    WHERE claim_id = ? AND source != 'undo'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(claimId) as MutationRow | undefined;

  if (!row) {
    return { ok: false, reason: `No mutation found for claim ${claimId}` };
  }

  const current = await readFileSafe(row.target_file);
  const currentHash = sha256(current);
  if (currentHash !== row.post_hash) {
    return {
      ok: false,
      reason: `File has been modified since the recorded write — refusing undo to avoid clobbering external edits.`,
      conflict: { expectedHash: row.post_hash, actualHash: currentHash },
    };
  }

  let next: string;
  switch (row.operation) {
    case "append": {
      // Inverse: strip the appended block from the end. We know post = pre + new_text,
      // verified by hash, so endsWith should hold.
      if (!row.new_text || !current.endsWith(row.new_text)) {
        return { ok: false, reason: "Append block no longer at file tail; cannot cleanly invert." };
      }
      next = current.slice(0, current.length - row.new_text.length);
      break;
    }
    case "replace": {
      if (!row.old_text || row.new_text == null) {
        return { ok: false, reason: "Replace mutation missing old_text or new_text." };
      }
      if (!current.includes(row.new_text)) {
        return { ok: false, reason: "Replacement text no longer present; nothing to invert." };
      }
      next = current.replace(row.new_text, row.old_text);
      break;
    }
    case "remove": {
      if (!row.old_text) {
        return { ok: false, reason: "Remove mutation missing old_text — original content unrecoverable." };
      }
      // Position is lost; append the recovered content with a marker.
      next = current.endsWith("\n") ? current + row.old_text : current + "\n" + row.old_text;
      break;
    }
    case "write": {
      if (row.old_text == null) {
        return { ok: false, reason: "Write mutation has no old_text — pre-state unknown." };
      }
      next = row.old_text;
      break;
    }
    default:
      return { ok: false, reason: `Unknown operation ${row.operation}` };
  }

  // Verify the inverse lands on pre_hash. If it doesn't, something is off — abort.
  const inverseHash = sha256(next);
  if (inverseHash !== row.pre_hash) {
    return {
      ok: false,
      reason: `Inverse content hash does not match recorded pre_hash — refusing to write a divergent state.`,
      conflict: { expectedHash: row.pre_hash, actualHash: inverseHash },
    };
  }

  await atomicWrite(row.target_file, next);

  const compensatingId = `mm_undo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT INTO memory_mutations (
      id, claim_id, target_file, section, operation,
      old_text, new_text, pre_hash, post_hash, source, actor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'undo', ?)
  `).run(
    compensatingId, claimId, row.target_file, row.section,
    row.operation === "append" ? "remove"
      : row.operation === "remove" ? "append"
      : row.operation === "replace" ? "replace"
      : "write",
    row.new_text, row.old_text,
    row.post_hash, inverseHash,
    row.id, // actor = original mutation id
  );

  // Mark the originating claim as archived so it doesn't keep haunting the ledger.
  try {
    db.prepare(`
      UPDATE knowledge_claims SET status = 'archived', updated_at = datetime('now')
      WHERE id = ? AND status IN ('approved', 'stale')
    `).run(claimId);
  } catch (err) {
    logger.warn({ err, claimId }, "undo: claim status update failed (non-fatal)");
  }

  logger.info({ claimId, mutationId: row.id, target: row.target_file, op: row.operation }, "Undo applied successfully");
  return { ok: true, reason: `Undid ${row.operation} on ${basename(row.target_file)}`, mutationId: row.id };
}
