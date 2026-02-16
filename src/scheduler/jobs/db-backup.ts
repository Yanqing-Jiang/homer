/**
 * Daily SQLite backup with 7-day rotation.
 * Uses sqlite3 .backup (WAL-safe) + gzip compression.
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { logger } from "../../utils/logger.js";

const DB_PATH = "/Users/yj/homer/data/homer.db";
const BACKUP_DIR = "/Users/yj/homer/data/backups";
const RETENTION_DAYS = 7;

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

    const date = new Date().toISOString().slice(0, 10);
    const backupFile = join(BACKUP_DIR, `homer-${date}.db`);

    // .backup command handles WAL properly
    execSync(`sqlite3 "${DB_PATH}" ".backup '${backupFile}'"`, {
      timeout: 60_000,
    });

    // Compress
    execSync(`gzip -f "${backupFile}"`, { timeout: 30_000 });
    const compressedFile = `${backupFile}.gz`;

    // Rotate: delete backups older than RETENTION_DAYS
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const files = readdirSync(BACKUP_DIR).filter(f => f.startsWith("homer-") && f.endsWith(".db.gz"));
    let deleted = 0;
    for (const file of files) {
      const dateMatch = file.match(/homer-(\d{4}-\d{2}-\d{2})\.db\.gz/);
      if (dateMatch && dateMatch[1]! < cutoffStr) {
        unlinkSync(join(BACKUP_DIR, file));
        deleted++;
      }
    }

    const output = `Backup: ${compressedFile}${deleted > 0 ? ` (${deleted} old backups deleted)` : ""}`;
    logger.info({ backupFile: compressedFile, deleted }, "DB backup complete");
    return { success: true, output };

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "DB backup failed");
    return { success: false, output: "", error: msg };
  }
}
