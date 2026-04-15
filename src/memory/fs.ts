/**
 * Memory filesystem primitives — Phase 1.1
 *
 * Provides cross-process safe file I/O for ~/memory/*.md writes. Replaces the
 * inline `atomicWriteFile` / `atomicAppendFile` helpers in canonical-service.ts,
 * which only serialized within a single process.
 *
 * - `acquireWriteLock` uses `fs-ext` `flockSync` on a sidecar `.lock` file, with
 *   FD_CLOEXEC so forked children (Claude CLI, monitors) don't inherit the lock.
 *   Matches the pattern already used in src/daemon/lock.ts.
 * - `writeFileAtomic` does temp-file + fsync + rename + parent-dir fsync so a
 *   forced power-cut between write and rename cannot lose the old file contents.
 * - `appendSectionAtomic` is section-aware: if `## Section` already exists, new
 *   content lands inside that section instead of adding a duplicate header.
 *
 * The helpers are orthogonal — callers acquire a lock, then call one or more
 * write/append ops. See canonical-service.ts for the wrapped pattern.
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { flockSync, fcntlSync, constants as fsExtConstants } from "fs-ext";
import { logger } from "../utils/logger.js";

// ── Types ──────────────────────────────────────────────────

export interface MemoryWriteLockOptions {
  /** Identifier written into the lock file for diagnostics. Defaults to pid+argv. */
  owner?: string;
  /** Retry delay when another holder has the lock. Default 50 ms. */
  retryDelayMs?: number;
  /** Max retries before giving up. Default 40 → ~2 s total. */
  retries?: number;
  /** Sidecar suffix. Default `.lock`. */
  lockSuffix?: string;
}

export interface MemoryWriteLockHandle {
  path: string;
  lockPath: string;
  owner: string;
  acquiredAt: string;
  release(): Promise<void>;
}

export interface AtomicWriteOptions {
  /** File mode. Default 0o644. */
  mode?: number;
  /** fsync the file before rename + fsync parent dir after. Default true. */
  fsync?: boolean;
  /** Temp-file suffix. Default `.tmp`. */
  tempSuffix?: string;
}

export interface SectionAppendInput {
  /** Markdown section header (without the `##`). `null` = raw append to file. */
  section: string | null;
  /** Content to append. Trailing whitespace is trimmed; one trailing `\n` added. */
  content: string;
  /** If set, skip the append when this exact line already exists anywhere in the file. */
  dedupeLine?: string | null;
}

export interface SectionAppendResult {
  changed: boolean;
  insertedAtLine: number | null;
  previousHash: string;
  nextHash: string;
}

// ── Constants ──────────────────────────────────────────────

const DEFAULT_LOCK_SUFFIX = ".lock";
const DEFAULT_LOCK_RETRIES = 40;
const DEFAULT_LOCK_RETRY_DELAY_MS = 50;
const DEFAULT_TEMP_SUFFIX = ".tmp";
const LOCK_OPEN_FLAGS = fs.constants.O_CREAT | fs.constants.O_RDWR;

// ── Helpers ────────────────────────────────────────────────

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Locking ────────────────────────────────────────────────

/**
 * Acquire an exclusive cross-process lock on `filePath` via a sidecar lock file.
 *
 * Uses `fs-ext` `flockSync(LOCK_EX | LOCK_NB)` and sets FD_CLOEXEC so that any
 * child processes spawned while the lock is held do not inherit the FD.
 *
 * Blocks on another holder by polling: `retries` attempts with `retryDelayMs`
 * delay between attempts (~2 s by default). Throws on timeout.
 *
 * The OS releases the flock when the FD is closed (including on crash), so a
 * stale `.lock` file on disk does not prevent recovery — only an FD held by a
 * live process does.
 */
export async function acquireWriteLock(
  filePath: string,
  opts: MemoryWriteLockOptions = {},
): Promise<MemoryWriteLockHandle> {
  const lockSuffix = opts.lockSuffix ?? DEFAULT_LOCK_SUFFIX;
  const retries = opts.retries ?? DEFAULT_LOCK_RETRIES;
  const retryDelay = opts.retryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;
  const owner = opts.owner ?? `${process.pid}:${path.basename(process.argv[1] ?? "unknown")}`;
  const lockPath = `${filePath}${lockSuffix}`;

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(lockPath, LOCK_OPEN_FLAGS, 0o600);

      try {
        fcntlSync(fd, "setfd", fsExtConstants.FD_CLOEXEC);
      } catch (fcntlErr) {
        logger.warn({ err: fcntlErr, lockPath }, "Failed to set FD_CLOEXEC on memory lock FD");
      }

      flockSync(fd, "exnb");

      const acquiredAt = new Date().toISOString();
      const info = `owner=${owner}\npid=${process.pid}\nacquired=${acquiredAt}\ntarget=${filePath}\n`;
      try {
        fs.ftruncateSync(fd, 0);
        fs.writeSync(fd, info, 0, "utf-8");
        fs.fsyncSync(fd);
      } catch (writeErr) {
        logger.debug({ err: writeErr, lockPath }, "Failed to write lock diagnostics (non-fatal)");
      }

      const lockFd = fd;
      return {
        path: filePath,
        lockPath,
        owner,
        acquiredAt,
        release: async () => {
          try {
            fs.closeSync(lockFd);
          } catch (err) {
            logger.warn({ err, lockPath }, "Error releasing memory write lock (non-fatal)");
          }
        },
      };
    } catch (err) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
      const code = (err as NodeJS.ErrnoException).code;
      lastErr = err as Error;
      if ((code === "EWOULDBLOCK" || code === "EAGAIN") && attempt < retries) {
        await sleep(retryDelay);
        continue;
      }
      break;
    }
  }

  const msg = `Failed to acquire memory write lock on ${filePath}`;
  logger.error({ lockPath, retries, retryDelay, lastErr: lastErr?.message }, msg);
  throw new Error(`${msg}: ${lastErr?.message ?? "unknown"}`);
}

// ── Durability helpers ─────────────────────────────────────

/**
 * fsync the parent directory of `filePath` so a rename is durable. APFS on macOS
 * may not honor this (returns without error); that's acceptable — it's a best-effort
 * defense against power loss, not a correctness requirement.
 */
export async function fsyncParentDirectory(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  let dirFd: number | null = null;
  try {
    dirFd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(dirFd);
  } catch (err) {
    logger.debug({ err, dir }, "fsync on parent directory failed (non-fatal)");
  } finally {
    if (dirFd !== null) {
      try { fs.closeSync(dirFd); } catch { /* ignore */ }
    }
  }
}

// ── Writes ─────────────────────────────────────────────────

/**
 * Atomically write `content` to `filePath`: write to temp file, fsync, rename,
 * then fsync parent dir. A crash between any two steps leaves the target file
 * either fully old or fully new, never partial.
 *
 * The caller is responsible for serializing writes — call `acquireWriteLock`
 * first if multiple writers may race on the same path.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const tempSuffix = opts.tempSuffix ?? DEFAULT_TEMP_SUFFIX;
  const mode = opts.mode ?? 0o644;
  const shouldFsync = opts.fsync ?? true;

  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const suffix = `-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpPath = path.join(dir, `.${base}${tempSuffix}${suffix}`);

  await fs.promises.mkdir(dir, { recursive: true });

  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_TRUNC, mode);
    fs.writeSync(fd, content, 0, "utf-8");
    if (shouldFsync) fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    await fs.promises.rename(tmpPath, filePath);

    if (shouldFsync) {
      await fsyncParentDirectory(filePath);
    }
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { await fs.promises.unlink(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
}

/**
 * Append `content` into `filePath` under `## Section` — reusing an existing
 * header if it exists, or appending a new section at the end. With `section: null`
 * the content is appended at end of file with newline hygiene.
 *
 * Returns the pre/post content hashes so callers can record them in the mutation
 * ledger without re-reading the file.
 *
 * The caller is responsible for serializing writes — call `acquireWriteLock` first.
 */
export async function appendSectionAtomic(
  filePath: string,
  input: SectionAppendInput,
  opts: AtomicWriteOptions = {},
): Promise<SectionAppendResult> {
  let existing = "";
  try {
    existing = await fs.promises.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const previousHash = sha256(existing);

  if (input.dedupeLine) {
    const needle = input.dedupeLine.trim();
    if (needle.length > 0) {
      const lines = existing.split("\n");
      for (const line of lines) {
        if (line.trim() === needle) {
          return { changed: false, insertedAtLine: null, previousHash, nextHash: previousHash };
        }
      }
    }
  }

  const contentTrimmed = input.content.replace(/\s+$/, "");
  let nextContent: string;
  let insertedAtLine: number;

  if (!input.section) {
    const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
    nextContent = existing + (needsLeadingNewline ? "\n" : "") + contentTrimmed + "\n";
    insertedAtLine = existing.length === 0 ? 1 : existing.split("\n").length;
  } else {
    const headerPattern = new RegExp(`^##\\s+${escapeRegex(input.section)}\\s*$`, "m");
    const match = headerPattern.exec(existing);

    if (!match) {
      const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
      const separator = existing.length > 0 ? (needsLeadingNewline ? "\n\n" : "\n") : "";
      nextContent = existing + separator + `## ${input.section}\n` + contentTrimmed + "\n";
      insertedAtLine = existing.length === 0 ? 1 : existing.split("\n").length + (needsLeadingNewline ? 1 : 0);
    } else {
      const headerEnd = match.index + match[0].length;
      const afterHeader = existing.slice(headerEnd);
      const nextHeaderMatch = /^##\s+/m.exec(afterHeader);
      const sectionEnd = nextHeaderMatch ? headerEnd + nextHeaderMatch.index : existing.length;

      const beforeRaw = existing.slice(0, sectionEnd);
      const after = existing.slice(sectionEnd);

      // Strip trailing blank lines within the section before inserting
      const before = beforeRaw.replace(/\n+$/, "\n");
      nextContent = before + contentTrimmed + "\n" + (after.length > 0 && !after.startsWith("\n") ? "\n" : "") + after;
      insertedAtLine = before.split("\n").length;
    }
  }

  const nextHash = sha256(nextContent);
  if (nextHash === previousHash) {
    return { changed: false, insertedAtLine: null, previousHash, nextHash };
  }

  await writeFileAtomic(filePath, nextContent, opts);

  return { changed: true, insertedAtLine, previousHash, nextHash };
}
