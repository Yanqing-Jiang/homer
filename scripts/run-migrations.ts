#!/usr/bin/env npx tsx
/**
 * Standalone migration runner
 * Usage: npx tsx scripts/run-migrations.ts
 */

import Database from "better-sqlite3";
import { runMigrations, getAppliedMigrations } from "../src/state/migrations/index.js";

const DB_PATH = process.env.HOMER_DB_PATH || `${process.env.HOME}/homer/data/homer.db`;

console.log(`Opening database: ${DB_PATH}`);
const db = new Database(DB_PATH);

console.log("\nApplied migrations before:");
const before = getAppliedMigrations(db);
for (const m of before) {
  console.log(`  ✓ ${m.name} (${m.appliedAt})`);
}
if (before.length === 0) {
  console.log("  (none)");
}

console.log("\nRunning migrations...");
try {
  runMigrations(db);
  console.log("\nMigrations completed successfully!");
} catch (error) {
  console.error("\nMigration failed:", error);
  process.exit(1);
}

console.log("\nApplied migrations after:");
const after = getAppliedMigrations(db);
for (const m of after) {
  const isNew = !before.find((b) => b.name === m.name);
  console.log(`  ${isNew ? "✨" : "✓"} ${m.name} (${m.appliedAt})`);
}

db.close();
console.log("\nDone!");
