// Append-only log sink that survives external rotation.
//
// launchd opened logs/stdout.log ONCE for the supervisor, and the daemon inherited that
// descriptor. newsyslog rotates by rename, so from the first rotation on every daemon line
// went into a renamed (then compressed and deleted) inode: 21 MB of logs were unreadable by
// 2026-09-10. The sink re-stats its path before writing and reopens when the inode changed or
// the file is gone, and also rotates itself so a missing newsyslog entry cannot grow it forever.
import { closeSync, fstatSync, openSync, renameSync, statSync, writeSync } from "node:fs";

export class RotatingLogSink {
  constructor(path, { maxBytes = 10 * 1024 * 1024, keep = 5, statEveryMs = 2_000, now = Date.now } = {}) {
    this.path = path; this.maxBytes = maxBytes; this.keep = keep; this.statEveryMs = statEveryMs; this.now = now;
    this.fd = null; this.ino = null; this.bytes = 0; this.lastStat = 0;
  }
  open() {
    this.fd = openSync(this.path, "a", 0o644);
    const stat = fstatSync(this.fd);
    this.ino = stat.ino; this.bytes = stat.size; this.lastStat = this.now();
  }
  /** Reopen when the path no longer names the descriptor we hold (renamed, deleted, replaced). */
  reopenIfRotated(force = false) {
    if (this.fd === null) { this.open(); return true; }
    if (!force && this.now() - this.lastStat < this.statEveryMs) return false;
    this.lastStat = this.now();
    let current = null;
    try { current = statSync(this.path); } catch { current = null; }
    if (current && current.ino === this.ino) return false;
    closeSync(this.fd); this.fd = null;
    this.open();
    return true;
  }
  rotate() {
    if (this.fd !== null) { closeSync(this.fd); this.fd = null; }
    for (let index = this.keep - 1; index >= 1; index--) {
      try { renameSync(`${this.path}.${index}`, `${this.path}.${index + 1}`); } catch { /* absent generation */ }
    }
    try { renameSync(this.path, `${this.path}.1`); } catch { /* nothing to rotate */ }
    this.open();
  }
  write(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    try {
      this.reopenIfRotated();
      if (this.bytes + buffer.length > this.maxBytes) this.rotate();
      writeSync(this.fd, buffer);
      this.bytes += buffer.length;
    } catch {
      // Logging must never take the supervisor down; try once more with a fresh descriptor.
      try { this.reopenIfRotated(true); writeSync(this.fd, buffer); this.bytes += buffer.length; } catch { /* dropped */ }
    }
  }
  close() { if (this.fd !== null) { closeSync(this.fd); this.fd = null; } }
}
