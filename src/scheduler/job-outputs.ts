/**
 * Job output queries for cross-job intelligence.
 *
 * Extracted from shared-context.ts so swarm jobs can import
 * this module independently (avoids stale ESM module cache issues).
 */

import type Database from "better-sqlite3";

/**
 * Get recent successful job outputs for cross-job intelligence.
 * Injects recent HOMER activity into swarm consolidation prompts.
 */
export function getRecentJobOutputs(
  db: Database.Database,
  hours: number = 24,
  maxOutputLength: number = 500
): string {
  const rows = db.prepare(`
    SELECT job_id, job_name, output, completed_at
    FROM scheduled_job_runs
    WHERE success = 1 AND completed_at > datetime('now', ?)
      AND output IS NOT NULL AND output != ''
    ORDER BY completed_at DESC LIMIT 5
  `).all(`-${hours} hours`) as Array<{
    job_id: string;
    job_name: string;
    output: string;
    completed_at: string;
  }>;

  if (rows.length === 0) return "";
  return "## Recent HOMER Activity\n\n" + rows.map((r) =>
    `**${r.job_name}** (${r.completed_at}): ${r.output.slice(0, maxOutputLength)}`
  ).join("\n");
}
