/**
 * Internal-baseline seeder (harness-independence cutover, B-semantics).
 *
 * INTERNAL_JOB_HARNESS_BASELINES encodes deliberate per-job harness/model tuning in code. Before
 * the cutover the scheduler consulted that code baseline as a SELECTOR (the "baseline bridge").
 * The cutover deletes that bridge so selection is purely DB-driven (job row → global → default).
 * To keep deliberate tuning alive AND make it visible/switchable in the Jobs tab, we seed each
 * internal baseline as a job-scope harness_selection row — ONCE.
 *
 * Seed semantics (decided 2026-06-28):
 *  - ON CONFLICT DO NOTHING: never overwrite an existing row. The live DB already holds the user's
 *    deliberate per-job choices (e.g. the 11 jobs bulk-pinned to claude/opus); those are "today's
 *    choices" and must be preserved. Only jobs with no row yet (the codex-baseline ones that used
 *    to resolve via the bridge) get seeded → behavior-neutral deploy.
 *  - Seed-once guard: a marker row in harness_selection_meta. The predicate is marker-EXISTENCE,
 *    so once seeded (or once switch-all has run), a daemon restart can never re-seed cleared rows.
 *
 * DEBT: per-stage harness divergence (e.g. link-processor youtube_analyze on a different harness
 * than the job pin) is NOT modeled as job_stage rows here — it is currently
 * dormant because every multi-stage job is pinned at the job level (all resolve to the job row).
 * Upgrade to a job_stage scope tier when a multi-stage job needs a stage on a different harness
 * than its job pin while NOT being job-level-pinned.
 */
// @ts-ignore — better-sqlite3 exports the Database class as `export =`; type-only import for the param.
import type Database from "better-sqlite3";
import { INTERNAL_JOB_HARNESS_BASELINES, toExecutorKind } from "./harness-baselines.js";
import { logger } from "../utils/logger.js";

export const INTERNAL_BASELINE_SEED_KEY = "internal_job_harness_baselines_seeded_v1";

export interface InternalBaselineSeedResult {
  seeded: boolean;
  reason: "seeded" | "already-seeded";
  jobRows: number;
}

/** True once the seed has run OR switch-all has suppressed it (marker existence is the predicate). */
function markerExists(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT 1 FROM harness_selection_meta WHERE key = ?")
    .get(INTERNAL_BASELINE_SEED_KEY);
  return row !== undefined;
}

/**
 * Write the seed marker as "suppressed-by-switch-all" if it does not already exist. Called by
 * switchAllHarness so that a switch-all on a never-seeded DB still permanently disables the seed
 * (otherwise a later restart would seed rows the user just cleared).
 */
export function suppressInternalBaselineSeed(db: Database.Database, now: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO harness_selection_meta (key, value_json, updated_at) VALUES (?, ?, ?)",
  ).run(
    INTERNAL_BASELINE_SEED_KEY,
    JSON.stringify({ version: 1, status: "suppressed-by-switch-all", suppressedAt: now }),
    now,
  );
}

/**
 * Seed internal-baseline job rows once. Idempotent and safe to call on every daemon init.
 * Requires migration 108 (harness_selection_meta) to have run.
 */
export function seedInternalHarnessBaselines(db: Database.Database): InternalBaselineSeedResult {
  if (markerExists(db)) {
    return { seeded: false, reason: "already-seeded", jobRows: 0 };
  }

  const now = Date.now();
  const insertRow = db.prepare(
    `INSERT INTO harness_selection
       (scope_type, scope_id, harness, model, profile_id, enabled, source, updated_by, reason, updated_at)
     VALUES ('job', ?, ?, ?, NULL, 1, 'runtime', 'system:internal-baseline', 'seeded from INTERNAL_JOB_HARNESS_BASELINES', ?)
     ON CONFLICT(scope_type, scope_id) DO NOTHING`,
  );
  const insertMarker = db.prepare(
    "INSERT INTO harness_selection_meta (key, value_json, updated_at) VALUES (?, ?, ?)",
  );

  const tx = db.transaction(() => {
    let jobRows = 0;
    for (const [jobId, baseline] of Object.entries(INTERNAL_JOB_HARNESS_BASELINES)) {
      const harness = toExecutorKind(baseline.executor);
      const info = insertRow.run(jobId, harness, baseline.model ?? null, now);
      if (info.changes > 0) jobRows += 1;
    }
    insertMarker.run(
      INTERNAL_BASELINE_SEED_KEY,
      JSON.stringify({ version: 1, status: "seeded", seededAt: now, source: "INTERNAL_JOB_HARNESS_BASELINES" }),
      now,
    );
    return jobRows;
  });

  const jobRows = tx();
  logger.info({ jobRows }, "Seeded internal harness baselines as job-scope selection rows");
  return { seeded: true, reason: "seeded", jobRows };
}
