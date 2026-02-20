#!/usr/bin/env node
/**
 * Test script: run apply pipeline on 2 jobs from the pending queue.
 * Usage: node scripts/test-apply.mjs [jobId1] [jobId2]
 *   - If no args given, picks the top 2 pending jobs by match_score.
 *
 * Runs from homer/ root. Reads .env automatically via config.
 */

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Load env file before importing config
const { config: dotenvConfig } = await import("dotenv");
dotenvConfig({ path: resolve(root, ".env") });

const { Bot } = await import("grammy");
const Database = (await import("better-sqlite3")).default;
const { runMigrations } = await import(`${root}/dist/state/migrations/index.js`);
const { ApplyEngine } = await import(`${root}/dist/job-hunt/apply-engine.js`);

// Open DB
const db = new Database(resolve(root, "data/homer.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
runMigrations(db);

// Minimal bot (notifications will go to Telegram as usual)
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = parseInt(process.env.ALLOWED_CHAT_ID ?? "0", 10);
if (!botToken || !chatId) {
  console.error("Missing TELEGRAM_BOT_TOKEN or ALLOWED_CHAT_ID");
  process.exit(1);
}
const bot = new Bot(botToken);

// Pick jobs to test
let testJobs;
const argJobIds = process.argv.slice(2);

if (argJobIds.length > 0) {
  testJobs = argJobIds.map(jobId => {
    const row = db.prepare(`
      SELECT aq.id as queue_id, aq.job_id, jp.title, jp.company, jp.application_type, jp.url
      FROM approval_queue aq
      JOIN job_postings jp ON aq.job_id = jp.id
      WHERE jp.id = ? AND aq.decision IN ('pending', 'pending_retry')
    `).get(jobId);
    if (!row) throw new Error(`Job ${jobId} not found in pending queue`);
    return row;
  });
} else {
  testJobs = db.prepare(`
    SELECT aq.id as queue_id, aq.job_id, jp.title, jp.company, jp.application_type, jp.url
    FROM approval_queue aq
    JOIN job_postings jp ON aq.job_id = jp.id
    WHERE aq.decision IN ('pending', 'pending_retry')
    ORDER BY aq.match_score DESC
    LIMIT 2
  `).all();
}

if (testJobs.length === 0) {
  console.log("No pending jobs found.");
  process.exit(0);
}

console.log(`\n=== Testing apply pipeline on ${testJobs.length} job(s) ===\n`);

const engine = new ApplyEngine(db, bot, chatId);

for (const job of testJobs) {
  const method = job.application_type === "easy_apply" ? "linkedin_easy" : "career_site";
  console.log(`[${job.job_id}] ${job.company} — ${job.title}`);
  console.log(`  Method: ${method}`);
  console.log(`  URL: ${job.url}`);
  console.log(`  Starting...`);

  // Mark queue entry as in_progress
  db.prepare(`
    UPDATE approval_queue SET decision = 'in_progress', decided_at = datetime('now')
    WHERE id = ?
  `).run(job.queue_id);
  db.prepare("UPDATE job_postings SET status = 'approved' WHERE id = ?").run(job.job_id);

  const start = Date.now();
  let result;
  try {
    result = await engine.applyToJob(job.job_id, method);
  } catch (err) {
    result = { success: false, steps: [], error: err.message };
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  // Update queue based on result
  if (result.success) {
    db.prepare("UPDATE approval_queue SET decision = 'approved' WHERE id = ?").run(job.queue_id);
  } else if (result.escalation) {
    db.prepare("UPDATE approval_queue SET decision = 'escalated' WHERE id = ?").run(job.queue_id);
  } else {
    db.prepare("UPDATE approval_queue SET decision = 'pending_retry' WHERE id = ?").run(job.queue_id);
  }

  console.log(`  Result: ${result.success ? "✓ APPLIED" : result.escalation ? "⚠ ESCALATED" : "✗ FAILED"} (${elapsed}s)`);
  if (result.error) console.log(`  Error: ${result.error}`);
  if (result.escalation) console.log(`  Escalation: ${result.escalation}`);
  console.log(`  Steps: ${result.steps.length}`);
  console.log();
}

// Final status
const statuses = db.prepare(`
  SELECT a.status, a.notes, a.retry_count, jp.company, jp.title
  FROM applications a
  JOIN job_postings jp ON a.job_id = jp.id
  WHERE a.job_id IN (${testJobs.map(() => "?").join(",")})
  ORDER BY a.updated_at DESC
`).all(...testJobs.map(j => j.job_id));

console.log("=== Final DB state ===");
for (const s of statuses) {
  console.log(`  ${s.company} — ${s.title}`);
  console.log(`    status: ${s.status} | retry_count: ${s.retry_count} | notes: ${s.notes ?? "(none)"}`);
}

db.close();
process.exit(0);
