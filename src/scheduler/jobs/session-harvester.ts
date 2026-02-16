/**
 * Session Harvester — batch import all CLI sessions into session_summaries
 *
 * Runs daily at 21:30. Scans all CLIs (Claude, Codex, Gemini, Kimi, OpenCode),
 * parses conversations, filters sub-agents, summarizes (Gemini Flash),
 * and INSERTs directly into session_summaries SQLite table with FTS5 indexing.
 *
 * Sessions are immediately searchable via memory_search after this job completes.
 */

import Database from "better-sqlite3";
import { homedir } from "os";
import { CLISessionImporter } from "../../cli-sessions/importer.js";
import { logger } from "../../utils/logger.js";

const DB_PATH = `${homedir()}/homer/data/homer.db`;

export async function runSessionHarvester(
  db?: Database.Database
): Promise<{ success: boolean; output: string; error?: string }> {
  const ownDb = !db;
  const database = db ?? new Database(DB_PATH);

  try {
    const importer = new CLISessionImporter(database, homedir());

    const stats = await importer.import({
      sinceDays: 1,
      agent: "all",
      dryRun: false,
    });

    const parts: string[] = [];
    parts.push(`Scanned: ${stats.scanned}`);
    parts.push(`Imported: ${stats.imported}`);
    if (stats.subAgents > 0) parts.push(`Sub-agents skipped: ${stats.subAgents}`);
    if (stats.skipped > 0) parts.push(`Duplicates: ${stats.skipped}`);
    if (stats.errors > 0) parts.push(`Errors: ${stats.errors}`);

    const output = `Session harvest: ${parts.join(", ")}`;
    logger.info({ stats }, output);

    return { success: true, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "Session harvester failed");
    return { success: false, output: "", error: message };
  } finally {
    if (ownDb) database.close();
  }
}
