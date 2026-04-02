/**
 * Harness version manager.
 *
 * Tracks which prompt/config version is active for each job,
 * registers new versions when prompts change, and writes
 * evaluation scores after job runs.
 */

// @ts-ignore
import type Database from "better-sqlite3";
import { logger } from "../utils/logger.js";

// ── Version management ──

export interface HarnessVersion {
  id: string;
  jobId: string;
  version: number;
  status: string;
  promptManifest: Record<string, string>;
  configManifest?: Record<string, unknown>;
  sourceHash: string;
  createdBy: string;
}

/**
 * Get the currently active harness version for a job.
 */
export function getActiveVersion(db: Database.Database, jobId: string): HarnessVersion | null {
  try {
    const row = db.prepare(`
      SELECT id, job_id, version, status, prompt_manifest, config_manifest, source_hash, created_by
      FROM job_harness_versions
      WHERE job_id = ? AND status = 'active'
      ORDER BY version DESC LIMIT 1
    `).get(jobId) as {
      id: string; job_id: string; version: number; status: string;
      prompt_manifest: string; config_manifest: string | null; source_hash: string; created_by: string;
    } | undefined;

    if (!row) return null;
    return {
      id: row.id,
      jobId: row.job_id,
      version: row.version,
      status: row.status,
      promptManifest: JSON.parse(row.prompt_manifest),
      configManifest: row.config_manifest ? JSON.parse(row.config_manifest) : undefined,
      sourceHash: row.source_hash,
      createdBy: row.created_by,
    };
  } catch (err) {
    logger.warn({ error: err, jobId }, "Failed to get active harness version");
    return null;
  }
}

/**
 * Register a new harness version. If the prompt manifest matches the current
 * active version, returns the existing version (no-op).
 */
export function registerVersion(
  db: Database.Database,
  jobId: string,
  promptManifest: Record<string, string>,
  sourceHash: string,
  createdBy = "migration",
): HarnessVersion {
  const current = getActiveVersion(db, jobId);

  // Check if manifests match — if so, return existing
  if (current) {
    const currentKeys = Object.keys(current.promptManifest).sort().join(",");
    const newKeys = Object.keys(promptManifest).sort().join(",");
    const currentVals = Object.keys(current.promptManifest).sort().map(k => current.promptManifest[k]).join(",");
    const newVals = Object.keys(promptManifest).sort().map(k => promptManifest[k]).join(",");
    if (currentKeys === newKeys && currentVals === newVals && current.sourceHash === sourceHash) {
      return current;
    }
    // Archive the old version
    db.prepare(`UPDATE job_harness_versions SET status = 'archived' WHERE id = ?`).run(current.id);
  }

  const nextVersion = (current?.version ?? 0) + 1;
  const id = `hv_${jobId}_${nextVersion}_${Date.now()}`;

  db.prepare(`
    INSERT INTO job_harness_versions (id, job_id, version, status, prompt_manifest, source_hash, created_by)
    VALUES (?, ?, ?, 'active', ?, ?, ?)
  `).run(id, jobId, nextVersion, JSON.stringify(promptManifest), sourceHash, createdBy);

  logger.info({ jobId, version: nextVersion, id }, "Registered new harness version");

  return {
    id, jobId, version: nextVersion, status: "active",
    promptManifest, sourceHash, createdBy,
  };
}

// ── Score writing ──

export interface EvalScore {
  runId: string;
  jobId: string;
  harnessVersionId?: string;
  scoreName: string;
  scoreValue: number;
  scoreComponents?: Record<string, unknown>;
  labelSource?: "automatic" | "human" | "downstream";
}

export function writeEvalScore(db: Database.Database, score: EvalScore): void {
  try {
    const id = `es_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(`
      INSERT INTO job_eval_scores (id, run_id, job_id, harness_version_id, score_name, score_value, score_components, label_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, score.runId, score.jobId,
      score.harnessVersionId ?? null,
      score.scoreName, score.scoreValue,
      score.scoreComponents ? JSON.stringify(score.scoreComponents) : null,
      score.labelSource ?? "automatic",
    );
  } catch (err) {
    logger.warn({ error: err, jobId: score.jobId, scoreName: score.scoreName }, "Failed to write eval score");
  }
}

// ── Score querying ──

export function getRecentScores(
  db: Database.Database,
  jobId: string,
  scoreName: string,
  days = 30,
): Array<{ scoreValue: number; scoredAt: string; harnessVersionId: string | null }> {
  try {
    return db.prepare(`
      SELECT score_value as scoreValue, scored_at as scoredAt, harness_version_id as harnessVersionId
      FROM job_eval_scores
      WHERE job_id = ? AND score_name = ? AND scored_at > datetime('now', '-' || ? || ' days')
      ORDER BY scored_at DESC
    `).all(jobId, scoreName, days) as Array<{
      scoreValue: number; scoredAt: string; harnessVersionId: string | null;
    }>;
  } catch {
    return [];
  }
}

/**
 * Get all harness versions for a job (most recent first).
 */
export function getVersionHistory(
  db: Database.Database,
  jobId: string,
  limit = 10,
): HarnessVersion[] {
  try {
    const rows = db.prepare(`
      SELECT id, job_id, version, status, prompt_manifest, config_manifest, source_hash, created_by
      FROM job_harness_versions
      WHERE job_id = ?
      ORDER BY version DESC
      LIMIT ?
    `).all(jobId, limit) as Array<{
      id: string; job_id: string; version: number; status: string;
      prompt_manifest: string; config_manifest: string | null; source_hash: string; created_by: string;
    }>;

    return rows.map(row => ({
      id: row.id,
      jobId: row.job_id,
      version: row.version,
      status: row.status,
      promptManifest: JSON.parse(row.prompt_manifest),
      configManifest: row.config_manifest ? JSON.parse(row.config_manifest) : undefined,
      sourceHash: row.source_hash,
      createdBy: row.created_by,
    }));
  } catch {
    return [];
  }
}
