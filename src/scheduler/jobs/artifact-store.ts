/**
 * Job Artifact Storage Helper
 *
 * Stores LLM outputs, decision trails, and intermediate results
 * in the job_artifacts table for lineage tracking and recovery.
 */

import type Database from "better-sqlite3";
import { createHash } from "crypto";
import { logger } from "../../utils/logger.js";

/**
 * Store a job artifact (LLM output, decision, intermediate result) in the DB.
 *
 * @param db - Database instance
 * @param jobRunId - scheduled_job_runs.id for this run
 * @param jobName - Human-readable job name (e.g., 'idea-synthesizer')
 * @param stage - Pipeline stage (e.g., 'pass1-scores', 'critic', 'final-decisions')
 * @param artifactType - Content type: 'json', 'markdown', 'text'
 * @param content - Full artifact content
 * @param metadata - Optional structured metadata
 */
export function storeJobArtifact(
  db: Database.Database,
  jobRunId: number,
  jobName: string,
  stage: string,
  artifactType: string,
  content: string,
  metadata?: Record<string, unknown>
): void {
  try {
    const contentHash = createHash("sha256").update(content).digest("hex");
    const sizeBytes = Buffer.byteLength(content, "utf-8");
    const metadataJson = metadata ? JSON.stringify(metadata) : null;

    db.prepare(
      `INSERT INTO job_artifacts (job_run_id, job_name, stage, artifact_type, content, content_hash, size_bytes, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(jobRunId, jobName, stage, artifactType, content, contentHash, sizeBytes, metadataJson);

    logger.debug(
      { jobRunId, jobName, stage, sizeBytes },
      "Stored job artifact"
    );
  } catch (error) {
    logger.warn({ error, jobRunId, jobName, stage }, "Failed to store job artifact");
  }
}

/**
 * Get all artifacts for a specific job run.
 */
export function getJobRunArtifacts(
  db: Database.Database,
  jobRunId: number
): Array<{
  id: number;
  stage: string;
  artifactType: string;
  contentHash: string;
  sizeBytes: number;
  createdAt: string;
}> {
  return db.prepare(
    `SELECT id, stage, artifact_type as artifactType, content_hash as contentHash,
            size_bytes as sizeBytes, created_at as createdAt
     FROM job_artifacts WHERE job_run_id = ?
     ORDER BY id ASC`
  ).all(jobRunId) as Array<{
    id: number;
    stage: string;
    artifactType: string;
    contentHash: string;
    sizeBytes: number;
    createdAt: string;
  }>;
}
