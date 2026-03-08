import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type Database from "better-sqlite3";
import { logger } from "../../utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Errors that are safe to ignore when retrying a partially-applied migration.
 * ALTER TABLE ADD COLUMN is not transactional in SQLite — a failed migration
 * can leave columns behind while ROLLBACK undoes the _migrations record.
 */
const IGNORABLE_ERRORS = [
  "duplicate column name",
  "already exists",
  "table already exists",
];

function isIgnorableError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return IGNORABLE_ERRORS.some((e) => lower.includes(e));
}

/**
 * Split SQL into individual statements and execute each one,
 * skipping statements that fail with known-safe errors (e.g., duplicate column).
 * Returns the number of statements that were skipped.
 */
function execStatementsLenient(db: Database.Database, sql: string): number {
  // Split on semicolons that end a statement (ignoring those inside trigger bodies).
  // SQLite trigger bodies use BEGIN...END; so we track nesting.
  const statements: string[] = [];
  let current = "";
  let depth = 0;

  for (const line of sql.split("\n")) {
    const trimmed = line.trim().toUpperCase();

    // Track BEGIN/END nesting for trigger bodies
    if (trimmed.startsWith("CREATE TRIGGER") || trimmed === "BEGIN") {
      if (trimmed === "BEGIN") depth++;
    }
    if (trimmed.startsWith("END;") || trimmed === "END") {
      if (depth > 0) depth--;
    }

    current += line + "\n";

    // A statement boundary: semicolon at end of line, outside trigger body
    if (depth === 0 && trimmed.endsWith(";")) {
      const stmt = current.trim();
      if (stmt && stmt !== ";") {
        statements.push(stmt);
      }
      current = "";
    }
  }

  // Leftover (shouldn't happen with well-formed SQL, but be safe)
  const leftover = current.trim();
  if (leftover && leftover !== ";" && leftover !== "--") {
    statements.push(leftover);
  }

  let skipped = 0;
  for (const stmt of statements) {
    // Skip empty or comment-only statements
    const meaningful = stmt
      .split("\n")
      .filter((l) => !l.trim().startsWith("--") && l.trim().length > 0)
      .join("");
    if (!meaningful) continue;

    try {
      db.exec(stmt);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isIgnorableError(msg)) {
        logger.debug({ statement: stmt.substring(0, 80), error: msg }, "Skipping already-applied statement");
        skipped++;
      } else {
        throw err;
      }
    }
  }
  return skipped;
}

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

    // Pre-migration backup for pipeline_dirty migration
    if (file === "052_pipeline_dirty.sql") {
      try {
        const backupPath = join(dirname(__dirname), "..", "..", "data", `homer-pre-052-${Date.now()}.db`);
        db.exec(`VACUUM INTO '${backupPath}'`);
        logger.info({ backupPath }, "Created pre-052 backup");
      } catch (backupErr) {
        logger.warn({ error: backupErr }, "Pre-052 backup failed, continuing with migration");
      }
    }

    logger.info({ migration: file }, "Running migration");

    const sql = readFileSync(join(__dirname, file), "utf-8");

    try {
      // Try running the full migration in a transaction (fast path).
      db.exec("BEGIN TRANSACTION");
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(file);
      db.exec("COMMIT");

      logger.info({ migration: file }, "Migration completed");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back or no txn */ }

      // ALTER TABLE ADD COLUMN is not transactional in SQLite — columns persist
      // through ROLLBACK. If a migration failed partway through, some DDL may
      // already be applied. Retry by executing each statement individually,
      // skipping known-safe errors like "duplicate column name".
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn({ migration: file, error: msg }, "Transaction failed, retrying statement-by-statement");

      try {
        const skipped = execStatementsLenient(db, sql);
        db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(file);
        logger.info({ migration: file, skippedStatements: skipped }, "Migration completed on retry");
      } catch (retryError) {
        logger.error({ migration: file, error: retryError }, "Migration failed on retry");
        throw retryError;
      }
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
