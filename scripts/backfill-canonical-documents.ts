/**
 * One-shot Phase 5 backfill: seed memory_documents from the legacy canonical
 * ~/memory/*.md files and verify each stored hash matches the file bytes.
 *
 * Idempotent — re-running reports "existing" and re-verifies against whatever
 * files are still on disk. Safe to run after the files are removed (the parity
 * column just reports "file gone").
 */

import Database from "better-sqlite3";
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { PATHS } from "../src/config/paths.js";
import { CANONICAL_DOCUMENT_KEYS, ensureCanonicalDocuments, readDocumentRow } from "../src/memory/documents.js";

const db = new Database(PATHS.db);
db.pragma("busy_timeout = 5000");

const results = ensureCanonicalDocuments(db);

const legacy: Record<string, string> = {
  me: PATHS.me, work: PATHS.work, preferences: PATHS.preferences,
  tools: PATHS.tools, patterns: PATHS.patterns,
};

let mismatches = 0;
console.log("key          action      bytes    doc-hash        file-hash       parity");
for (const key of CANONICAL_DOCUMENT_KEYS) {
  const row = readDocumentRow(db, key);
  const r = results.find((x) => x.key === key)!;
  if (!row) { console.log(`${key.padEnd(12)} MISSING DOCUMENT`); mismatches++; continue; }

  const path = legacy[key]!;
  let parity = "file gone";
  if (existsSync(path)) {
    const fileHash = createHash("sha256").update(readFileSync(path, "utf-8")).digest("hex");
    parity = fileHash === row.content_hash ? "MATCH" : "MISMATCH";
    if (parity === "MISMATCH") mismatches++;
    console.log(
      `${key.padEnd(12)} ${r.action.padEnd(11)} ${String(Buffer.byteLength(row.content, "utf-8")).padEnd(8)} ` +
      `${row.content_hash.slice(0, 15)} ${fileHash.slice(0, 15)} ${parity}`
    );
  } else {
    console.log(
      `${key.padEnd(12)} ${r.action.padEnd(11)} ${String(Buffer.byteLength(row.content, "utf-8")).padEnd(8)} ` +
      `${row.content_hash.slice(0, 15)} ${"-".padEnd(15)} ${parity}`
    );
  }
}

db.close();
console.log(mismatches === 0 ? "\nOK — all canonical documents present and consistent." : `\n${mismatches} problem(s).`);
process.exit(mismatches === 0 ? 0 : 1);
