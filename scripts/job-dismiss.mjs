#!/usr/bin/env node
// Permanently suppress a role from job-scanner digests (applied, rejected,
// or just not interested). Matches across posting ids, states, and company
// legal-suffix variants via the digest key.
//
// Usage: node scripts/job-dismiss.mjs "<company>" "<title>" [reason]
//        node scripts/job-dismiss.mjs --list
import Database from "better-sqlite3";
import { PATHS } from "../dist/config/paths.js";
import { addDismissal } from "../dist/job-scanner/store.js";

const db = new Database(`${PATHS.homerRoot}/data/homer.db`);

const [a, b, reason] = process.argv.slice(2);
if (a === "--list") {
  for (const r of db.prepare("SELECT company, title, reason, created_at FROM job_scan_dismissals ORDER BY created_at").all()) {
    console.log(`${r.created_at}  ${r.company} — ${r.title}  (${r.reason})`);
  }
  process.exit(0);
}
if (!a || !b) {
  console.error('Usage: node scripts/job-dismiss.mjs "<company>" "<title>" [reason] | --list');
  process.exit(2);
}
const key = addDismissal(db, a, b, reason ?? "dismissed");
console.log(`Dismissed: ${a} — ${b} (key ${key})`);
