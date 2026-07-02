#!/usr/bin/env node
/**
 * CLI Session Import Command
 *
 * Usage:
 *   homer-import-cli                    # Import last 7 days from all CLIs
 *   homer-import-cli --since 30         # Import last 30 days
 *   homer-import-cli --agent codex      # Import only Codex sessions
 *   homer-import-cli --agent opencode   # Import only OpenCode sessions
 *   homer-import-cli --dry-run          # Preview what would be imported
 */

import Database from "better-sqlite3";
import { homedir } from "os";
import { CLISessionImporter } from "./importer.js";
import { runMigrations } from "../state/migrations/index.js";
import { logger } from "../utils/logger.js";

interface CLIArgs {
  sinceDays: number;
  agent: "codex" | "gemini" | "claude" | "opencode" | "all";
  dryRun: boolean;
  stats: boolean;
}

function parseArgs(): CLIArgs {
  const args: CLIArgs = {
    sinceDays: 7,
    agent: "all",
    dryRun: false,
    stats: false,
  };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];

    if (arg === "--since") {
      const val = process.argv[i + 1];
      if (val) {
        args.sinceDays = parseInt(val, 10);
        i++;
      }
    } else if (arg === "--agent" && process.argv[i + 1]) {
      const agentArg = process.argv[i + 1];
      if (agentArg === "codex" || agentArg === "gemini" || agentArg === "claude" || agentArg === "opencode" || agentArg === "all") {
        args.agent = agentArg;
      }
      i++;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--stats") {
      args.stats = true;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs();

  console.log("📥 Homer CLI Session Importer\n");

  // Open database
  const dbPath = `${homedir()}/homer/data/homer.db`;
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");

  // Run migrations
  try {
    runMigrations(db);
  } catch (error) {
    logger.error({ error }, "Failed to run migrations");
    process.exit(1);
  }

  const importer = new CLISessionImporter(db, homedir());

  // Show stats only
  if (args.stats) {
    const stats = importer.getStats();
    console.log("Import Statistics:");
    console.log(`  Total imported: ${stats.totalImported}`);
    console.log("\n  By agent:");
    for (const [agent, count] of Object.entries(stats.byAgent)) {
      console.log(`    ${agent}: ${count}`);
    }
    console.log("\n  Recent imports:");
    for (const row of stats.recentImports) {
      console.log(`    ${row.logDate} - ${row.agent} (${row.messageCount} messages)`);
    }
    db.close();
    return;
  }

  // Import sessions
  console.log(`Options:`);
  console.log(`  Since: ${args.sinceDays} days`);
  console.log(`  Agent: ${args.agent}`);
  console.log(`  Dry run: ${args.dryRun ? "Yes" : "No"}`);
  console.log();

  try {
    const stats = await importer.import({
      sinceDays: args.sinceDays,
      agent: args.agent,
      dryRun: args.dryRun,
    });

    console.log("\nResults:");
    console.log(`  ✅ Scanned: ${stats.scanned} files`);
    console.log(`  ✅ Imported: ${stats.imported} sessions`);
    console.log(`  ⏭️  Skipped: ${stats.skipped} (duplicates)`);
    if (stats.parseErrors > 0) {
      console.log(`  ⚠️  Parse errors quarantined: ${stats.parseErrors}`);
    }
    console.log(`  ❌ Errors: ${stats.errors}`);

    if (args.dryRun) {
      console.log("\n⚠️  DRY RUN - No changes were made");
    } else {
      console.log("\n✅ Import completed successfully");
    }
  } catch (error) {
    console.error("\n❌ Import failed:", error);
    process.exit(1);
  } finally {
    db.close();
  }
}

main().catch(console.error);
