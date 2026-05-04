#!/usr/bin/env -S npx tsx
//
// export-homer-lite-metrics.ts
// ----------------------------
// Reads ~/homer/data/homer.db and writes anonymized aggregates to
// ~/ai-portfolio/public/homer/metrics.json for the /homer landing page.
//
// CRITICAL: counts and timestamps only — no claim text, no source paths,
// no person/org names, no executor invocation prompts. Anything that could
// leak ProfitSphere / P&G / personal context must NEVER appear in the output.
//
// Sprint 1 deliverable per ~/homer/output/claude/homer-lite-buildout-plan-2026-05-02.md.
// Sprint 3 wires this output into the Hero counter + Metrics tiles.
// Sprint 4+ will run this nightly via launchd / homer scheduler.

import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

const HOMER_DB = process.env.HOMER_DB ?? resolve(homedir(), 'homer/data/homer.db');
const OUT = process.env.HOMER_LITE_METRICS_OUT
  ?? resolve(homedir(), 'ai-portfolio/public/homer/metrics.json');

interface BucketRow { day: string; n: number }

const safeCount = (db: Database.Database, table: string): number => {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
};

const safeBucketByDay = (db: Database.Database, table: string, tsCol: string, days = 60): BucketRow[] => {
  try {
    const rows = db.prepare(`
      SELECT date(${tsCol}, 'unixepoch') AS day, COUNT(*) AS n
      FROM ${table}
      WHERE ${tsCol} >= strftime('%s', 'now', '-${days} days')
      GROUP BY day
      ORDER BY day ASC
    `).all() as BucketRow[];
    return rows;
  } catch {
    // Some tables store ms or ISO strings — try a millisecond fallback.
    try {
      const rows = db.prepare(`
        SELECT date(${tsCol} / 1000, 'unixepoch') AS day, COUNT(*) AS n
        FROM ${table}
        WHERE ${tsCol} >= strftime('%s', 'now', '-${days} days') * 1000
        GROUP BY day
        ORDER BY day ASC
      `).all() as BucketRow[];
      return rows;
    } catch {
      return [];
    }
  }
};

// Function: groupByExecutor — counts cli_runs by executor over the last 30 days.
// Returns aggregate counts only — never the prompt or output text.
const groupByExecutor = (db: Database.Database): { executor: string; runs: number }[] => {
  try {
    const rows = db.prepare(`
      SELECT executor, COUNT(*) AS n
      FROM cli_runs
      WHERE created_at >= strftime('%s', 'now', '-30 days')
      GROUP BY executor
      ORDER BY n DESC
    `).all() as { executor: string; n: number }[];
    return rows.map((r) => ({ executor: r.executor, runs: r.n }));
  } catch {
    return [];
  }
};

// Function: reliabilityByJob — success rate over the last 30 days from
// scheduled_job_runs. We deliberately bucket by job_name (a short slug like
// "nightly-memory" — never a prompt or output).
const reliabilityByJob = (db: Database.Database): { job: string; success: number; total: number }[] => {
  try {
    const rows = db.prepare(`
      SELECT job_name AS job,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
             COUNT(*) AS total
      FROM scheduled_job_runs
      WHERE created_at >= strftime('%s', 'now', '-30 days')
      GROUP BY job_name
      ORDER BY total DESC
      LIMIT 8
    `).all() as { job: string; success: number; total: number }[];
    return rows;
  } catch {
    return [];
  }
};

const main = () => {
  if (!existsSync(HOMER_DB)) {
    console.error(`[homer-lite-metrics] DB not found at ${HOMER_DB}`);
    process.exit(1);
  }

  const db = new Database(HOMER_DB, { readonly: true });

  // Hero counters
  const claims = safeCount(db, 'knowledge_claims');
  const sessions = safeCount(db, 'chat_sessions');
  const runs = safeCount(db, 'cli_runs');
  const scheduledRuns = safeCount(db, 'scheduled_job_runs');

  // Uptime — use earliest run timestamp as a proxy.
  let uptimeDays = 0;
  try {
    const r = db.prepare(`SELECT MIN(created_at) AS firstSeen FROM cli_runs`).get() as { firstSeen: number | null };
    if (r?.firstSeen) {
      const seconds = Date.now() / 1000 - r.firstSeen;
      uptimeDays = Math.max(0, Math.floor(seconds / 86400));
    }
  } catch {
    uptimeDays = 0;
  }

  // Time series — only counts per day, no text fields.
  const claimsByDay = safeBucketByDay(db, 'knowledge_claims', 'created_at', 90);
  const runsByDay = safeBucketByDay(db, 'cli_runs', 'created_at', 30);

  const executors = groupByExecutor(db);
  const reliability = reliabilityByJob(db);

  const payload = {
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    hero: {
      uptimeDays,
      claims,
      sessions,
      runs,
      scheduledRuns,
      executorCount: executors.length,
      // Static list — names are public anyway and intentionally curated.
      executors: ['claude', 'codex', 'gemini', 'kimi', 'opencode'],
    },
    series: {
      claimsByDay,
      runsByDay,
    },
    breakdowns: {
      executors,
      reliability,
    },
    // Defensive note for the public consumer:
    notice:
      'Aggregates only. No claim text, source paths, prompts, or output bodies are exported here.',
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(`[homer-lite-metrics] wrote ${OUT}`);
  console.log(
    `  uptime=${uptimeDays}d  claims=${claims}  runs=${runs}  scheduled=${scheduledRuns}  executors=${executors.length}`,
  );
  db.close();
};

main();
