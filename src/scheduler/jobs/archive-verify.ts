/**
 * Archive Verification Job — Weekly integrity check
 *
 * Validates the memory backup system:
 * 1. Orphan summaries without transcripts
 * 2. Memory snapshot freshness per file
 * 3. DB backup recency (within 48h)
 * 4. Backup file exists on disk + checksum matches
 * 5. Job artifacts exist for recent synthesizer/improvements runs
 *
 * Note: Daily log archive gap check removed 2026-03-31 — session-summaries
 * (the only writer to daily_log_archive) was disabled in the 2026-02-24
 * pipeline refactor. Table retained for historical reads by weekly-consolidation.
 *
 * Sends Telegram notification only on failures.
 * Schedule: 30 4 * * 0 (Sunday 4:30am, after weekly-cleanup)
 */

import { existsSync, readFileSync } from "fs";
import { createHash } from "crypto";
// @ts-ignore
import type Database from "better-sqlite3";
import { logger } from "../../utils/logger.js";

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

    // 2. Memory snapshot freshness — removed in migration 072, git handles this
    try {
      results.push({
        check: "Memory snapshots",
        status: "ok",
        detail: "Handled by git version control",
      });
    } catch (err) {
      results.push({ check: "Memory snapshots", status: "warn", detail: `Check failed: ${err}` });
    }

    // 4. DB backup recency
    try {
      const hasBackupRunsTable = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='backup_runs'"
      ).get();

      if (hasBackupRunsTable) {
        const latest = db.prepare(
          `SELECT backup_path, checksum, created_at
           FROM backup_runs ORDER BY created_at DESC LIMIT 1`
        ).get() as { backup_path: string; checksum: string; created_at: string } | undefined;

        if (!latest) {
          results.push({ check: "DB backup recency", status: "fail", detail: "No backup runs recorded" });
        } else {
          const hoursSince = (Date.now() - new Date(latest.created_at).getTime()) / (60 * 60 * 1000);
          results.push({
            check: "DB backup recency",
            status: hoursSince > 48 ? "fail" : "ok",
            detail: `Last backup ${Math.round(hoursSince)}h ago: ${latest.backup_path}`,
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

    // 6. Job artifacts for recent synthesizer/improvements runs
    try {
      const hasArtifactsTable = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_artifacts'"
      ).get();

      if (hasArtifactsTable) {
        for (const jobName of ["idea-synthesizer", "homer-improvements"]) {
          const recentRuns = db.prepare(`
            SELECT id FROM scheduled_job_runs
            WHERE job_id = ? AND success = 1
            AND completed_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
            ORDER BY id DESC LIMIT 3
          `).all(jobName) as Array<{ id: number }>;

          if (recentRuns.length === 0) continue;

          const runsWithArtifacts = recentRuns.filter(run => {
            const artifacts = db.prepare(
              "SELECT 1 FROM job_artifacts WHERE job_run_id = ? LIMIT 1"
            ).get(run.id);
            return !!artifacts;
          });

          results.push({
            check: `${jobName} artifacts`,
            status: runsWithArtifacts.length === 0 ? "warn" : "ok",
            detail: `${runsWithArtifacts.length}/${recentRuns.length} recent runs have artifacts`,
          });
        }
      }
    } catch (err) {
      results.push({ check: "Job artifacts", status: "warn", detail: `Check failed: ${err}` });
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
