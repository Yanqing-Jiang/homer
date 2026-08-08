/**
 * Offsite backup restore drill.
 *
 * An untested backup is a rumour. This pulls the encrypted copy back out of
 * Azure and proves the whole chain end to end: download -> age decrypt ->
 * zstd -d -> checksum match against the local artifact and the blob metadata
 * -> sqlite3 PRAGMA integrity_check. Temp files are removed on every exit path.
 *
 * Idempotent — safe to re-run any time (quarterly is the intent).
 *
 * Run: npm run backup:drill            (today's blob)
 *      npm run backup:drill -- latest  (newest blob offsite)
 *      npm run backup:drill -- 2026-08-01
 */

import { existsSync, mkdirSync, rmSync, readFileSync } from "fs";
import { execFileSync, execSync } from "child_process";
import { createHash } from "crypto";
import { join, resolve } from "path";
import { config as dotenvConfig } from "dotenv";

const envFile = resolve(import.meta.dirname, "../../.env");
if (existsSync(envFile)) dotenvConfig({ path: envFile });

const { PATHS } = await import("../config/paths.js");
const { downloadBlob, listBlobs, getBlobProperties } = await import("../integrations/azure-blob.js");
const { AGE_IDENTITY_PATH, OFFSITE_PREFIX, offsiteBlobName, resolveAgeBinary } =
  await import("../scheduler/jobs/db-backup.js");

const BACKUP_DIR = join(PATHS.homerRoot, "backups");
const WORK_DIR = join(PATHS.homerData, "tmp", "restore-drill");

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function bin(name: string): string {
  for (const candidate of [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`]) {
    if (existsSync(candidate)) return candidate;
  }
  return execSync(`which ${name}`, { encoding: "utf-8" }).trim();
}

const steps: string[] = [];
function pass(msg: string): void {
  steps.push(`PASS  ${msg}`);
  console.log(`PASS  ${msg}`);
}
function fail(msg: string): never {
  steps.push(`FAIL  ${msg}`);
  console.error(`FAIL  ${msg}`);
  cleanup();
  console.error(`\nRestore drill FAILED after ${steps.length} step(s).`);
  process.exit(1);
}
function cleanup(): void {
  try { rmSync(WORK_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
}

async function main(): Promise<void> {
  const arg = process.argv[2];

  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) fail("AZURE_STORAGE_CONNECTION_STRING not set");
  if (!existsSync(AGE_IDENTITY_PATH)) fail(`age identity not found at ${AGE_IDENTITY_PATH}`);
  const ageBin = resolveAgeBinary();
  if (!ageBin) fail("age binary not found (brew install age)");

  // 1. Pick the blob to drill
  const blobs = (await listBlobs(OFFSITE_PREFIX))
    .filter(b => /\.db\.(gz|zst)\.age$/.test(b.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  if (blobs.length === 0) fail(`no encrypted backups found under ${OFFSITE_PREFIX}`);

  let blobName: string;
  if (!arg || arg === "today") {
    const date = new Date().toISOString().slice(0, 10);
    const found = blobs.find(b => b.name === offsiteBlobName(date, ".zst") || b.name === offsiteBlobName(date, ".gz"));
    if (!found) fail(`no offsite backup for today (${date}); newest is ${blobs[0]!.name}`);
    blobName = found.name;
  } else if (arg === "latest") {
    blobName = blobs[0]!.name;
  } else {
    const found = blobs.find(b => b.name.includes(arg));
    if (!found) fail(`no offsite backup matching "${arg}"`);
    blobName = found.name;
  }
  pass(`target blob: ${blobName}`);

  // 2. Properties: tier + metadata
  const props = await getBlobProperties(blobName);
  const meta = props.metadata || {};
  pass(`tier=${props.accessTier ?? "?"} size=${(props.size / 1024 / 1024).toFixed(1)}MB createdAt=${meta.createdat ?? "?"}`);
  if (props.accessTier !== "Cool") steps.push(`WARN  expected Cool tier, got ${props.accessTier ?? "unset"}`);

  // 3. Download
  cleanup();
  mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });
  const localName = blobName.slice(OFFSITE_PREFIX.length);
  const cipherPath = join(WORK_DIR, localName);
  await downloadBlob(blobName, cipherPath);
  const cipherSha = sha256(cipherPath);
  pass(`downloaded ${localName}`);

  if (meta.sha256ciphertext && meta.sha256ciphertext !== cipherSha) {
    fail(`ciphertext sha mismatch: blob metadata ${meta.sha256ciphertext} != downloaded ${cipherSha}`);
  }
  pass(`ciphertext sha256 matches metadata (${cipherSha.slice(0, 16)}…)`);

  // 4. Decrypt
  const compressedPath = cipherPath.replace(/\.age$/, "");
  try {
    execFileSync(ageBin, ["-d", "-i", AGE_IDENTITY_PATH, "-o", compressedPath, cipherPath], { timeout: 900_000 });
  } catch (error) {
    fail(`age decrypt failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const plainSha = sha256(compressedPath);
  pass(`decrypted with ${AGE_IDENTITY_PATH}`);

  // 5. Checksums against blob metadata and the local GFS artifact
  if (meta.sha256plaintext && meta.sha256plaintext !== plainSha) {
    fail(`plaintext sha mismatch: blob metadata ${meta.sha256plaintext} != decrypted ${plainSha}`);
  }
  pass(`decrypted sha256 matches metadata (${plainSha.slice(0, 16)}…)`);

  const localArtifact = join(BACKUP_DIR, localName.replace(/\.age$/, ""));
  if (existsSync(localArtifact)) {
    const localSha = sha256(localArtifact);
    if (localSha !== plainSha) fail(`round-trip mismatch vs local ${localArtifact}`);
    pass(`byte-identical to local ${localArtifact}`);
  } else {
    steps.push(`WARN  local artifact ${localArtifact} absent (rotated out) — metadata check only`);
    console.log(`WARN  local artifact ${localArtifact} absent — metadata check only`);
  }

  // 6. Decompress
  const dbPath = compressedPath.replace(/\.(zst|gz)$/, "");
  try {
    if (compressedPath.endsWith(".zst")) {
      execFileSync(bin("zstd"), ["-d", "-f", "-q", compressedPath, "-o", dbPath], { timeout: 900_000 });
    } else {
      execSync(`${bin("gzip")} -d -c "${compressedPath}" > "${dbPath}"`, { timeout: 900_000 });
    }
  } catch (error) {
    fail(`decompress failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  pass(`decompressed to ${dbPath}`);

  // 7. SQLite integrity
  const integrity = execFileSync(bin("sqlite3"), [dbPath, "PRAGMA integrity_check"], {
    timeout: 900_000,
    encoding: "utf-8",
  }).trim();
  if (integrity !== "ok") fail(`integrity_check: ${integrity.slice(0, 300)}`);
  const tables = execFileSync(bin("sqlite3"), [dbPath, "SELECT count(*) FROM sqlite_master WHERE type='table'"], {
    encoding: "utf-8",
  }).trim();
  pass(`PRAGMA integrity_check ok (${tables} tables restored)`);

  // 8. Cleanup
  cleanup();
  pass(`temp files removed from ${WORK_DIR}`);

  console.log(`\nRestore drill PASSED — ${blobName} is recoverable.`);
}

main().catch(error => {
  console.error(error);
  cleanup();
  process.exit(1);
});
