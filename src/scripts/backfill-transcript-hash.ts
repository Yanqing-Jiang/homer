/**
 * Backfill session_transcripts.transcript_hash for rows that predate migration 099.
 *
 * transcript_hash = sha256(messages_json) — the byte-exact content address used as the
 * Cosmos document id. Migration 099 only adds the (nullable) column; SQLite has no
 * sha256, so the data step lives here. Idempotent: only touches NULL rows.
 *
 * MUST be run once per device after deploying migration 099, otherwise pushTranscripts()
 * silently skips pre-099 rows (they have NULL transcript_hash).
 *
 *   node dist/scripts/backfill-transcript-hash.js [--dry-run]
 */
import Database from "better-sqlite3";
import { createHash } from "crypto";
import { homedir } from "os";
import { fileURLToPath } from "url";

export function backfillTranscriptHashes(dbPath: string, dryRun = false): { scanned: number; updated: number } {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  try {
    const rows = db
      .prepare("SELECT content_hash, messages_json FROM session_transcripts WHERE transcript_hash IS NULL")
      .all() as Array<{ content_hash: string; messages_json: string }>;
    if (dryRun) return { scanned: rows.length, updated: 0 };

    const upd = db.prepare("UPDATE session_transcripts SET transcript_hash = ? WHERE content_hash = ?");
    const tx = db.transaction((rs: typeof rows) => {
      for (const r of rs) {
        const h = createHash("sha256").update(r.messages_json).digest("hex");
        upd.run(h, r.content_hash);
      }
    });
    tx(rows);
    return { scanned: rows.length, updated: rows.length };
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dryRun = process.argv.includes("--dry-run");
  const res = backfillTranscriptHashes(`${homedir()}/homer/data/homer.db`, dryRun);
  console.log(`transcript_hash backfill${dryRun ? " (dry-run)" : ""}: ${res.updated}/${res.scanned} rows`);
}
