/**
 * Archive Verification Job — Weekly integrity check
 *
 * Validates the memory backup system:
 * 1. Orphan summaries without transcripts
 * 2. Daily log archive gaps
 * 3. Memory snapshot freshness per file
 * 4. DB backup recency (within 48h)
 * 5. Backup file exists on disk + checksum matches
 * 6. Job artifacts exist for recent synthesizer/improvements runs
 *
 * Sends Telegram notification only on failures.
 * Schedule: 30 4 * * 0 (Sunday 4:30am, after weekly-cleanup)
 */

import { existsSync, readFileSync } from "fs";
import { createHash } from "crypto";
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
          AND ss.created_at > datetime('now', '-7 days')
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

    // 2. Daily log archive gaps (last 7 days)
    try {
      const today = new Date();
      let gaps = 0;
      const gapDates: string[] = [];

      for (let i = 1; i <= 7; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().slice(0, 10);
        const archived = db.prepare(
          "SELECT 1 FROM daily_log_archive WHERE date = ?"
        ).get(dateStr);
        if (!archived) {
          gaps++;
          gapDates.push(dateStr);
        }
      }

      results.push({
        check: "Daily log archives",
        status: gaps > 2 ? "fail" : gaps > 0 ? "warn" : "ok",
        detail: gaps > 0
          ? `${gaps} missing archive days: ${gapDates.join(", ")}`
          : "All 7 recent days archived",
      });
    } catch (err) {
      results.push({ check: "Daily log archives", status: "warn", detail: `Check failed: ${err}` });
    }

    // 3. Memory snapshot freshness
    try {
      const hasSnapshotsTable = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_file_snapshots'"
      ).get();

      if (hasSnapshotsTable) {
        const expectedFiles = ["me.md", "work.md", "life.md", "preferences.md", "tools.md"];
        const staleFiles: string[] = [];

        for (const fileName of expectedFiles) {
          const latest = db.prepare(
            `SELECT snapshot_date FROM memory_file_snapshots
             WHERE file_name = ?
             ORDER BY created_at DESC LIMIT 1`
          ).get(fileName) as { snapshot_date: string } | undefined;

          if (!latest) {
            staleFiles.push(`${fileName} (never)`);
          } else {
            const daysSince = Math.floor(
              (Date.now() - new Date(latest.snapshot_date).getTime()) / (24 * 60 * 60 * 1000)
            );
            if (daysSince > 14) {
              staleFiles.push(`${fileName} (${daysSince}d ago)`);
            }
          }
        }

        results.push({
          check: "Memory snapshots",
          status: staleFiles.length > 2 ? "fail" : staleFiles.length > 0 ? "warn" : "ok",
          detail: staleFiles.length > 0
            ? `Stale: ${staleFiles.join(", ")}`
            : "All memory files have recent snapshots",
        });
      }
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
            AND completed_at > datetime('now', '-7 days')
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
