/**
 * Daily SQLite backup with GFS retention.
 *
 * Upgrades from old approach:
 * - VACUUM INTO for clean, defragmented backups
 * - Integrity check before compression
 * - zstd compression (gzip fallback)
 * - SHA256 checksum verification
 * - GFS retention: daily 90d, weekly (Sun) 2y, monthly (1st) forever
 * - Audit trail in backup_runs table
 */

import { execSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, unlinkSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { logger } from "../../utils/logger.js";
import { StateManager } from "../../state/manager.js";
import { PATHS } from "../../config/paths.js";

const DB_PATH = PATHS.db;
const BACKUP_DIR = join(PATHS.homerRoot, "backups");

// GFS retention policies
const DAILY_RETENTION_DAYS = 90;
const WEEKLY_RETENTION_DAYS = 730; // ~2 years
// Monthly: kept forever (no automatic deletion)

function hasZstd(): boolean {
  try {
    execSync("which zstd", { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function getRetentionTier(date: Date): string {
  if (date.getDate() === 1) return "monthly";
  if (date.getDay() === 0) return "weekly";
  return "daily";
}

function computeSha256(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

export async function runDbBackup(): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  try {
    if (!existsSync(DB_PATH)) {
      return { success: false, output: "", error: "homer.db not found" };
    }

    mkdirSync(BACKUP_DIR, { recursive: true });

    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const tier = getRetentionTier(now);
    const useZstd = hasZstd();
    const ext = useZstd ? ".zst" : ".gz";

    const backupFile = join(BACKUP_DIR, `homer-${date}.db`);
    const compressedFile = `${backupFile}${ext}`;

    // Get DB size before backup
    const dbSizeBytes = statSync(DB_PATH).size;

    // VACUUM INTO creates a clean, defragmented copy (WAL-safe)
    execSync(`sqlite3 "${DB_PATH}" "VACUUM INTO '${backupFile}'"`, {
      timeout: 120_000,
    });

    // Integrity check on the backup
    let integrityResult = "unknown";
    try {
      const checkOutput = execSync(`sqlite3 "${backupFile}" "PRAGMA integrity_check"`, {
        timeout: 900_000,
        encoding: "utf-8",
      }).trim();
      integrityResult = checkOutput === "ok" ? "ok" : `failed: ${checkOutput.slice(0, 200)}`;
    } catch (err) {
      integrityResult = `error: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (!integrityResult.startsWith("ok")) {
      logger.error({ integrityResult }, "Backup integrity check failed");
      // Still compress and keep — a partially good backup is better than none
    }

    // Compress
    if (useZstd) {
      execSync(`zstd -f --rm -q "${backupFile}"`, { timeout: 900_000 });
    } else {
      execSync(`gzip -f "${backupFile}"`, { timeout: 900_000 });
    }

    // SHA256 checksum
    const checksum = computeSha256(compressedFile);
    const backupSizeBytes = statSync(compressedFile).size;

    // Record in backup_runs audit trail
    try {
      const sm = new StateManager(DB_PATH);
      try {
        sm.recordBackupRun({
          backupType: useZstd ? "zstd" : "gzip",
          backupPath: compressedFile,
          dbSizeBytes,
          backupSizeBytes,
          checksum,
          integrityCheck: integrityResult,
          retentionTier: tier,
        });
      } finally {
        sm.close();
      }
    } catch (auditErr) {
      logger.warn({ error: auditErr }, "Failed to record backup run in audit trail");
    }

    // GFS Rotation
    let deleted = 0;
    const files = readdirSync(BACKUP_DIR).filter(f =>
      f.startsWith("homer-") && (f.endsWith(".db.gz") || f.endsWith(".db.zst"))
    );

    for (const file of files) {
      const dateMatch = file.match(/homer-(\d{4}-\d{2}-\d{2})\.db\.(gz|zst)$/);
      if (!dateMatch) continue;

      const fileDate = new Date(dateMatch[1]!);
      const fileTier = getRetentionTier(fileDate);
      const ageDays = Math.floor((now.getTime() - fileDate.getTime()) / (24 * 60 * 60 * 1000));

      let shouldDelete = false;

      if (fileTier === "daily" && ageDays > DAILY_RETENTION_DAYS) {
        shouldDelete = true;
      } else if (fileTier === "weekly" && ageDays > WEEKLY_RETENTION_DAYS) {
        shouldDelete = true;
      }
      // Monthly: never auto-deleted

      if (shouldDelete) {
        try {
          unlinkSync(join(BACKUP_DIR, file));
          deleted++;
        } catch (delErr) {
          logger.warn({ error: delErr, file }, "Failed to delete old backup");
        }
      }
    }

    const ratio = dbSizeBytes > 0 ? ((backupSizeBytes / dbSizeBytes) * 100).toFixed(1) : "?";
    const output = [
      `Backup: ${compressedFile}`,
      `Size: ${(dbSizeBytes / 1024 / 1024).toFixed(1)}MB → ${(backupSizeBytes / 1024 / 1024).toFixed(1)}MB (${ratio}%)`,
      `Integrity: ${integrityResult} | Tier: ${tier}`,
      deleted > 0 ? `Rotated ${deleted} old backups` : null,
    ].filter(Boolean).join(" | ");

    logger.info({ backupFile: compressedFile, dbSizeBytes, backupSizeBytes, tier, integrity: integrityResult, deleted }, "DB backup complete");
    return { success: true, output };

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "DB backup failed");
    return { success: false, output: "", error: msg };
  }
}
