/**
 * Archive Verification Job — Weekly integrity check
 *
 * Validates the memory backup system:
 * 1. Orphan summaries without transcripts
 * 2. Canonical-document hashes, mutation-ledger heads, and trust invariant
 * 3. Recovery-export freshness and permissions
 * 4. DB backup recency and coverage of the latest DB-native memory write
 * 5. Backup file exists on disk + checksum matches
 *
 * Note: Daily log archive gap check was removed in the 2026-02-24 pipeline
 * refactor. The table remains for historical reads by weekly-consolidation.
 *
 * Sends Telegram notification only on failures.
 * Schedule: Sunday after weekly synthesis and DB backup.
 */

import { existsSync, readFileSync, statSync } from "fs";
import { createHash } from "crypto";
// @ts-ignore
import type Database from "better-sqlite3";
import { logger } from "../../utils/logger.js";
import { RECOVERY_EXPORT_PATH } from "../../memory/recovery-export.js";

interface VerifyResult {
  check: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export async function runArchiveVerify(db: Database.Database): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  const results: VerifyResult[] = [];

  try {
    // 1. Orphan summaries without transcripts
    try {
      const hasTranscriptsTable = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_transcripts'"
      ).get();

      if (hasTranscriptsTable) {
        const orphans = db.prepare(`
          SELECT COUNT(*) as count FROM session_summaries ss
          WHERE NOT EXISTS (
            SELECT 1 FROM session_transcripts st
            WHERE st.content_hash = ss.content_hash
          )
          AND julianday(ss.created_at) > julianday('now', '-7 days')
          AND ss.is_sub_agent = 0
        `).get() as { count: number };

        results.push({
          check: "Transcript coverage",
          status: orphans.count > 5 ? "warn" : "ok",
          detail: orphans.count > 0
            ? `${orphans.count} recent summaries without transcripts`
            : "All recent summaries have transcripts",
        });
      }
    } catch (err) {
      results.push({ check: "Transcript coverage", status: "warn", detail: `Check failed: ${err}` });
    }

    // 2. DB-native canonical integrity and trust boundary
    try {
      const documents = db.prepare(`
        SELECT id, content, content_hash
        FROM memory_documents
        WHERE kind = 'canonical' AND archived_at IS NULL
        ORDER BY id
      `).all() as Array<{ id: string; content: string; content_hash: string }>;
      const hashMismatches = documents.filter(
        (document) => createHash("sha256").update(document.content).digest("hex") !== document.content_hash,
      );
      const ledgerMismatches = db.prepare(`
        SELECT md.id
        FROM memory_documents md
        JOIN memory_mutations mm
          ON mm.id = (
            SELECT mm2.id FROM memory_mutations mm2
            WHERE mm2.target_file = 'document:' || md.id
            ORDER BY mm2.created_at DESC, mm2.id DESC
            LIMIT 1
          )
        WHERE md.kind = 'canonical'
          AND md.archived_at IS NULL
          AND mm.post_hash != md.content_hash
      `).all() as Array<{ id: string }>;
      const trustViolations = db.prepare(`
        SELECT COUNT(*) AS count
        FROM knowledge_claims
        WHERE status = 'approved' AND COALESCE(user_explicit, 0) = 0
      `).get() as { count: number };
      const canonicalOk = documents.length === 5
        && hashMismatches.length === 0
        && ledgerMismatches.length === 0
        && trustViolations.count === 0;
      results.push({
        check: "Canonical DB integrity",
        status: canonicalOk ? "ok" : "fail",
        detail: canonicalOk
          ? "5 document hashes verified; mutation heads and trust invariant valid"
          : `documents=${documents.length}, hash mismatches=${hashMismatches.length}, ledger mismatches=${ledgerMismatches.length}, trust violations=${trustViolations.count}`,
      });
    } catch (err) {
      results.push({ check: "Canonical DB integrity", status: "warn", detail: `Check failed: ${err}` });
    }

    // 3. MCP-down recovery export must cover the latest live memory row.
    try {
      const latestMemory = db.prepare(`
        SELECT MAX(epoch) AS epoch FROM (
          SELECT MAX(CAST(strftime('%s', updated_at) AS INTEGER)) AS epoch
          FROM memory_documents WHERE archived_at IS NULL
          UNION ALL
          SELECT MAX(CAST(strftime('%s', COALESCE(updated_at, created_at)) AS INTEGER)) AS epoch
          FROM knowledge_claims WHERE status IN ('approved', 'candidate')
        )
      `).get() as { epoch: number | null };
      if (!existsSync(RECOVERY_EXPORT_PATH)) {
        results.push({ check: "Recovery export", status: "fail", detail: `Missing: ${RECOVERY_EXPORT_PATH}` });
      } else {
        const stat = statSync(RECOVERY_EXPORT_PATH);
        const mode = stat.mode & 0o777;
        const fresh = latestMemory.epoch === null || stat.mtimeMs / 1000 + 1 >= latestMemory.epoch;
        const secure = mode === 0o600;
        results.push({
          check: "Recovery export",
          status: fresh && secure ? "ok" : "fail",
          detail: fresh && secure
            ? "Fresh against live memory; permissions 0600"
            : `fresh=${fresh}, mode=${mode.toString(8).padStart(4, "0")}`,
        });
      }
    } catch (err) {
      results.push({ check: "Recovery export", status: "warn", detail: `Check failed: ${err}` });
    }

    // 4. DB backup recency and coverage
    try {
      const hasBackupRunsTable = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='backup_runs'"
      ).get();

      if (hasBackupRunsTable) {
        const latest = db.prepare(
          `SELECT backup_path, checksum, created_at,
                  CAST(strftime('%s', created_at) AS INTEGER) AS created_epoch
           FROM backup_runs ORDER BY created_at DESC LIMIT 1`
        ).get() as { backup_path: string; checksum: string; created_at: string; created_epoch: number } | undefined;

        if (!latest) {
          results.push({ check: "DB backup recency", status: "fail", detail: "No backup runs recorded" });
        } else {
          const hoursSince = (Date.now() / 1000 - latest.created_epoch) / (60 * 60);
          const latestMemory = db.prepare(`
            SELECT MAX(epoch) AS epoch FROM (
              SELECT MAX(CAST(strftime('%s', updated_at) AS INTEGER)) AS epoch
              FROM memory_documents WHERE archived_at IS NULL
              UNION ALL
              SELECT MAX(CAST(strftime('%s', COALESCE(updated_at, created_at)) AS INTEGER)) AS epoch
              FROM knowledge_claims
            )
          `).get() as { epoch: number | null };
          const coversMemory = latestMemory.epoch === null || latest.created_epoch >= latestMemory.epoch;
          results.push({
            check: "DB backup recency/coverage",
            status: hoursSince > 48 || !coversMemory ? "fail" : "ok",
            detail: `Last backup ${Math.round(hoursSince)}h ago; covers latest memory=${coversMemory}: ${latest.backup_path}`,
          });

          // 5. Verify backup file exists + checksum matches
          if (existsSync(latest.backup_path)) {
            try {
              const content = readFileSync(latest.backup_path);
              const actualChecksum = createHash("sha256").update(content).digest("hex");
              const match = actualChecksum === latest.checksum;
              results.push({
                check: "Backup integrity",
                status: match ? "ok" : "fail",
                detail: match ? "Checksum verified" : `Checksum mismatch: expected ${latest.checksum.slice(0, 12)}... got ${actualChecksum.slice(0, 12)}...`,
              });
            } catch (err) {
              results.push({ check: "Backup integrity", status: "warn", detail: `Checksum read failed: ${err}` });
            }
          } else {
            results.push({ check: "Backup integrity", status: "fail", detail: `Backup file missing: ${latest.backup_path}` });
          }
        }
      }
    } catch (err) {
      results.push({ check: "DB backup", status: "warn", detail: `Check failed: ${err}` });
    }

    // Build output
    const failures = results.filter(r => r.status === "fail");
    const warnings = results.filter(r => r.status === "warn");
    const oks = results.filter(r => r.status === "ok");

    const lines: string[] = [`Archive Verification (${results.length} checks)`, "─────────────────────"];
    for (const r of results) {
      const icon = r.status === "ok" ? "OK" : r.status === "warn" ? "WARN" : "FAIL";
      lines.push(`[${icon}] ${r.check}: ${r.detail}`);
    }

    const output = lines.join("\n");
    const success = failures.length === 0;

    if (failures.length > 0) {
      logger.error({ failures: failures.length, warnings: warnings.length }, "Archive verification found failures");
    } else if (warnings.length > 0) {
      logger.warn({ warnings: warnings.length, oks: oks.length }, "Archive verification completed with warnings");
    } else {
      logger.info({ oks: oks.length }, "Archive verification passed");
    }

    return { success, output, error: success ? undefined : `${failures.length} checks failed` };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Archive verification failed");
    return { success: false, output: "", error: msg };
  }
}
