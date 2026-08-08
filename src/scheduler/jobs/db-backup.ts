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
 * - Offsite leg: age-encrypted copy pushed to Azure Blob (Cool tier) with its
 *   own GFS-shaped retention. Encryption is client-side — the cloud only ever
 *   holds ciphertext, and the private identity never leaves this machine.
 */

import { execFileSync, execSync } from "child_process";
import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, unlinkSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { logger } from "../../utils/logger.js";
import { StateManager } from "../../state/manager.js";
import { PATHS } from "../../config/paths.js";
import { uploadBlob, listBlobs, deleteBlob } from "../../integrations/azure-blob.js";

const DB_PATH = PATHS.db;
const BACKUP_DIR = join(PATHS.homerRoot, "backups");

// GFS retention policies
const DAILY_RETENTION_DAYS = 90;
const WEEKLY_RETENTION_DAYS = 730; // ~2 years
// Monthly: kept forever (no automatic deletion)

// ── Offsite (Azure Blob) ──────────────────────────────────────
export const OFFSITE_PREFIX = "backups/";
export const AGE_IDENTITY_PATH =
  process.env.HOMER_BACKUP_AGE_IDENTITY || join(PATHS.homerData, "secrets", "backup-age-identity.txt");

/**
 * Cloud retention. Deliberately smaller than local: egress-free storage is
 * still paid storage, and the local GFS set is the first line of recovery.
 */
const CLOUD_KEEP: Record<string, number> = { daily: 14, weekly: 8, monthly: 12 };

export function offsiteBlobName(date: string, ext: string): string {
  return `${OFFSITE_PREFIX}homer-${date}.db${ext}.age`;
}

/** age is a brew install; launchd's PATH does not include /opt/homebrew/bin. */
export function resolveAgeBinary(): string | null {
  for (const candidate of ["/opt/homebrew/bin/age", "/usr/local/bin/age"]) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    return execSync("which age", { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

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

/**
 * Backup filenames carry a calendar date, so parse at LOCAL midnight.
 * `new Date("2026-08-01")` is UTC midnight, which in a negative-offset zone
 * reads back as Jul 31 — a monthly backup would be re-classified as daily at
 * rotation time and deleted after 90 days. Tier at write time comes from local
 * `now`; tier at rotation time must come from the same calendar.
 */
function parseBackupDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

function computeSha256(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Encrypt the verified local backup and push it offsite, then prune the cloud
 * set to the same GFS shape. Never throws: a broken offsite leg must not fail
 * the local backup that already succeeded.
 */
async function runOffsiteBackup(
  compressedFile: string,
  plaintextSha: string,
  date: string,
  ext: string
): Promise<string> {
  const recipient = process.env.HOMER_BACKUP_AGE_RECIPIENT;
  if (!recipient || !process.env.AZURE_STORAGE_CONNECTION_STRING) {
    const missing = [
      !recipient ? "HOMER_BACKUP_AGE_RECIPIENT" : null,
      !process.env.AZURE_STORAGE_CONNECTION_STRING ? "AZURE_STORAGE_CONNECTION_STRING" : null,
    ].filter(Boolean).join(", ");
    logger.warn({ missing }, "Offsite backup skipped — config missing (local backup unaffected)");
    return `skipped: missing ${missing}`;
  }
  if (!/^age1[a-z0-9]+$/.test(recipient)) {
    logger.warn("Offsite backup skipped — HOMER_BACKUP_AGE_RECIPIENT is not a valid age public key");
    return "skipped: malformed recipient";
  }

  const ageBin = resolveAgeBinary();
  if (!ageBin) {
    logger.warn("Offsite backup skipped — age binary not found (brew install age)");
    return "skipped: age not installed";
  }

  const encryptedFile = `${compressedFile}.age`;
  try {
    // age -r <public key>: encryption needs only the recipient. The private
    // identity is never read here, so a compromised daemon cannot decrypt.
    execFileSync(ageBin, ["-r", recipient, "-o", encryptedFile, compressedFile], { timeout: 900_000 });
    chmodSync(encryptedFile, 0o600);

    const ciphertextSha = computeSha256(encryptedFile);
    const blobName = offsiteBlobName(date, ext);

    await uploadBlob(encryptedFile, blobName, {
      tier: "Cool",
      metadata: {
        sha256plaintext: plaintextSha,
        sha256ciphertext: ciphertextSha,
        createdat: new Date().toISOString(),
      },
    });

    const pruned = await pruneOffsiteBackups();
    logger.info({ blobName, ciphertextSha, pruned }, "Offsite backup uploaded");
    return `uploaded ${blobName}${pruned > 0 ? ` (pruned ${pruned})` : ""}`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Offsite backup failed (local backup unaffected)");
    return `failed: ${msg.slice(0, 200)}`;
  } finally {
    // The ciphertext exists only to be uploaded; the local set keeps the plaintext .zst.
    try { if (existsSync(encryptedFile)) unlinkSync(encryptedFile); } catch { /* best effort */ }
  }
}

/**
 * Prune cloud backups to the GFS set, using the same tier classification as
 * local rotation: keep the newest N of each tier.
 */
async function pruneOffsiteBackups(): Promise<number> {
  const pattern = new RegExp(`^${OFFSITE_PREFIX}homer-(\\d{4}-\\d{2}-\\d{2})\\.db\\.(gz|zst)\\.age$`);
  const byTier: Record<string, Array<{ name: string; date: string }>> = { daily: [], weekly: [], monthly: [] };

  for (const blob of await listBlobs(OFFSITE_PREFIX)) {
    const match = blob.name.match(pattern);
    if (!match) continue;
    const tier = getRetentionTier(parseBackupDate(match[1]!));
    byTier[tier]!.push({ name: blob.name, date: match[1]! });
  }

  let deleted = 0;
  for (const [tier, entries] of Object.entries(byTier)) {
    entries.sort((a, b) => b.date.localeCompare(a.date));
    for (const stale of entries.slice(CLOUD_KEEP[tier]!)) {
      try {
        await deleteBlob(stale.name);
        deleted++;
        logger.info({ blobName: stale.name, tier }, "Pruned offsite backup outside retention set");
      } catch (error) {
        logger.warn({ error, blobName: stale.name }, "Failed to prune offsite backup");
      }
    }
  }
  return deleted;
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

    // 0700/0600 throughout: a backup is a byte-identical copy of the live DB,
    // so anything readable here is the whole personal memory store readable.
    mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
    chmodSync(BACKUP_DIR, 0o700);

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

    chmodSync(backupFile, 0o600);

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

    const integrityOk = integrityResult === "ok";
    if (!integrityOk) {
      logger.error({ integrityResult }, "Backup integrity check failed");
      // Still compress and keep locally — a partially good backup is better than
      // none — but the offsite leg is gated below: blob names are date-stable,
      // so uploading this would overwrite today's good ciphertext.
    }

    // Compress
    if (useZstd) {
      execSync(`zstd -f --rm -q "${backupFile}"`, { timeout: 900_000 });
    } else {
      execSync(`gzip -f "${backupFile}"`, { timeout: 900_000 });
    }

    chmodSync(compressedFile, 0o600);

    // SHA256 checksum
    const checksum = computeSha256(compressedFile);
    const backupSizeBytes = statSync(compressedFile).size;

    // GFS Rotation
    let deleted = 0;
    const files = readdirSync(BACKUP_DIR).filter(f =>
      f.startsWith("homer-") && (f.endsWith(".db.gz") || f.endsWith(".db.zst"))
    );

    for (const file of files) {
      const dateMatch = file.match(/homer-(\d{4}-\d{2}-\d{2})\.db\.(gz|zst)$/);
      if (!dateMatch) continue;

      const fileDate = parseBackupDate(dateMatch[1]!);
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

    // Offsite: encrypt + upload only after the local set is verified and rotated.
    // Hard gate — the blob name carries only the date, so an unverified copy
    // would replace that day's good ciphertext and then prune older blobs.
    // A verified local artifact is the precondition for touching the cloud set.
    const localArtifactOk = existsSync(compressedFile) && backupSizeBytes > 0;
    let offsiteStatus: string;
    if (!integrityOk) {
      offsiteStatus = `skipped: integrity ${integrityResult.replace(/\s+/g, " ").slice(0, 120)}`;
      logger.error(
        { integrityResult, blobName: offsiteBlobName(date, ext) },
        "Offsite backup skipped — integrity check did not pass; refusing to overwrite the date-stable blob with an unverified copy",
      );
    } else if (!localArtifactOk) {
      offsiteStatus = "skipped: local backup artifact missing or empty";
      logger.error({ compressedFile, backupSizeBytes }, "Offsite backup skipped — local artifact unusable");
    } else {
      offsiteStatus = await runOffsiteBackup(compressedFile, checksum, date, ext);
    }

    // Record in backup_runs audit trail (after offsite, so the row carries its outcome)
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
          offsiteStatus,
        });
      } finally {
        sm.close();
      }
    } catch (auditErr) {
      logger.warn({ error: auditErr }, "Failed to record backup run in audit trail");
    }

    const ratio = dbSizeBytes > 0 ? ((backupSizeBytes / dbSizeBytes) * 100).toFixed(1) : "?";
    const output = [
      `Backup: ${compressedFile}`,
      `Size: ${(dbSizeBytes / 1024 / 1024).toFixed(1)}MB → ${(backupSizeBytes / 1024 / 1024).toFixed(1)}MB (${ratio}%)`,
      `Integrity: ${integrityResult} | Tier: ${tier}`,
      deleted > 0 ? `Rotated ${deleted} old backups` : null,
      `Offsite: ${offsiteStatus}`,
    ].filter(Boolean).join(" | ");

    logger.info({ backupFile: compressedFile, dbSizeBytes, backupSizeBytes, tier, integrity: integrityResult, deleted, offsiteStatus }, "DB backup complete");
    return { success: true, output };

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "DB backup failed");
    return { success: false, output: "", error: msg };
  }
}
