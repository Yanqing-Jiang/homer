import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type Database from "better-sqlite3";
import { logger } from "../../utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Run all pending migrations
 */
export function runMigrations(db: Database.Database): void {
  // Create migrations tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Get list of applied migrations
  const applied = new Set(
    (db.prepare("SELECT name FROM _migrations").all() as { name: string }[])
      .map((row) => row.name)
  );

  // Get migration files
  const files = readdirSync(__dirname)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  // Run pending migrations
  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }

    logger.info({ migration: file }, "Running migration");

    const sql = readFileSync(join(__dirname, file), "utf-8");

    try {
      // Run migration in a transaction
      db.exec("BEGIN TRANSACTION");
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(file);
      db.exec("COMMIT");

      logger.info({ migration: file }, "Migration completed");
    } catch (error) {
      db.exec("ROLLBACK");
      logger.error({ migration: file, error }, "Migration failed");
      throw error;
    }
  }
}

/**
 * Check if a specific migration has been applied
 */
export function hasMigration(db: Database.Database, name: string): boolean {
  const result = db
    .prepare("SELECT 1 FROM _migrations WHERE name = ?")
    .get(name);
  return result !== undefined;
}

/**
 * Get list of applied migrations
 */
export function getAppliedMigrations(
  db: Database.Database
): { name: string; appliedAt: string }[] {
  return db
    .prepare("SELECT name, applied_at as appliedAt FROM _migrations ORDER BY id")
    .all() as { name: string; appliedAt: string }[];
}
