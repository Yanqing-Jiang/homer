/**
 * Scrape Store — thin wrapper around the `scrapes` SQLite table.
 *
 * All scraping pipelines (idea-ingest, ideas-explore, content-scraper)
 * write here first. The idea-synthesizer reads unprocessed scrapes
 * and creates ideas with provenance tracking.
 */

// @ts-ignore
import type Database from "better-sqlite3";
import { logger } from "../utils/logger.js";
import { extractVideoId } from "../youtube/utils.js";

export interface ScrapeRecord {
  id: string;
  source: string; // 'x-bookmark' | 'github-trending' | 'medium-trending' | 'linkedin-trending'
  url?: string;
  title?: string;
  author?: string;
  raw_content: string;
  metadata?: string; // JSON string
  scraped_at?: string;
}

export interface StoredScrape extends ScrapeRecord {
  scraped_at: string;
  processed_at: string | null;
  idea_id: string | null;
  quality_score: number | null;
}

/**
 * Insert a scrape record. Uses INSERT OR IGNORE to skip URL duplicates.
 * Returns true if inserted, false if duplicate.
 */
export function insertScrape(db: Database.Database, scrape: ScrapeRecord): boolean {
  try {
    const result = db.prepare(`
      INSERT OR IGNORE INTO scrapes (id, source, url, title, author, raw_content, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      scrape.id,
      scrape.source,
      scrape.url?.toLowerCase() ?? null,
      scrape.title ?? null,
      scrape.author ?? null,
      scrape.raw_content,
      scrape.metadata ?? null,
    );
    return result.changes > 0;
  } catch (err) {
    logger.warn({ error: err, scrapeId: scrape.id }, "Failed to insert scrape");
    return false;
  }
}

/**
 * Get unprocessed scrapes, optionally filtered by recency and excluded sources.
 */
export function getUnprocessedScrapes(
  db: Database.Database,
  hoursAgo?: number,
  excludeSources?: string[],
): StoredScrape[] {
  const since = hoursAgo
    ? `AND scraped_at > datetime('now', '-${Math.floor(hoursAgo)} hours')`
    : "";

  const exclude = excludeSources?.length
    ? `AND source NOT IN (${excludeSources.map(() => "?").join(", ")})`
    : "";

  return db.prepare(`
    SELECT id, source, url, title, author, raw_content, metadata,
           scraped_at, processed_at, idea_id, quality_score
    FROM scrapes
    WHERE processed_at IS NULL ${since} ${exclude}
    ORDER BY scraped_at DESC
  `).all(...(excludeSources ?? [])) as StoredScrape[];
}

/**
 * Mark a scrape as processed, optionally linking to the created idea.
 */
export function markProcessed(
  db: Database.Database,
  scrapeId: string,
  ideaId?: string,
  qualityScore?: number,
): void {
  db.prepare(`
    UPDATE scrapes
    SET processed_at = datetime('now'),
        idea_id = COALESCE(?, idea_id),
        quality_score = COALESCE(?, quality_score)
    WHERE id = ?
  `).run(ideaId ?? null, qualityScore ?? null, scrapeId);
}

const MAX_SCRAPE_RETRIES = 3;

/**
 * Increment fail_count instead of marking processed. If fail_count reaches max,
 * mark as processed to prevent infinite retries (with null idea_id = data loss acknowledged).
 */
export function markScrapeFailedRetry(
  db: Database.Database,
  scrapeId: string,
): void {
  const row = db.prepare(`SELECT fail_count FROM scrapes WHERE id = ?`).get(scrapeId) as { fail_count: number } | undefined;
  const newCount = (row?.fail_count ?? 0) + 1;
  if (newCount >= MAX_SCRAPE_RETRIES) {
    logger.warn({ scrapeId, failCount: newCount }, "Scrape exhausted retries, marking as processed (data loss)");
    markProcessed(db, scrapeId);
  } else {
    db.prepare(`UPDATE scrapes SET fail_count = ? WHERE id = ?`).run(newCount, scrapeId);
    logger.info({ scrapeId, failCount: newCount, maxRetries: MAX_SCRAPE_RETRIES }, "Scrape synthesis failed, will retry next run");
  }
}

/**
 * Set quality_score and deep-linker enrichment WITHOUT marking as processed.
 * Used by deep-linker to pre-score scrapes for the synthesizer's cross-source synthesis.
 */
export function scoreAndEnrichScrape(
  db: Database.Database,
  scrapeId: string,
  score: number,
  enrichmentData: Record<string, unknown>,
): void {
  const existing = db.prepare(`SELECT metadata FROM scrapes WHERE id = ?`).get(scrapeId) as { metadata: string | null } | undefined;
  const meta = existing?.metadata ? JSON.parse(existing.metadata) : {};
  meta.deep_linker = enrichmentData;

  db.prepare(`
    UPDATE scrapes
    SET quality_score = ?,
        metadata = ?
    WHERE id = ?
  `).run(score, JSON.stringify(meta), scrapeId);
}

/**
 * Get recent scrapes, optionally filtered by source.
 */
export function getRecentScrapes(
  db: Database.Database,
  source?: string,
  hours: number = 48,
): StoredScrape[] {
  if (source) {
    return db.prepare(`
      SELECT * FROM scrapes
      WHERE source = ? AND scraped_at > datetime('now', '-${Math.floor(hours)} hours')
      ORDER BY scraped_at DESC
    `).all(source) as StoredScrape[];
  }

  return db.prepare(`
    SELECT * FROM scrapes
    WHERE scraped_at > datetime('now', '-${Math.floor(hours)} hours')
    ORDER BY scraped_at DESC
  `).all() as StoredScrape[];
}

/**
 * Get scrape count by source for the last N hours.
 */
export function getScrapeStats(
  db: Database.Database,
  hours: number = 24,
): Array<{ source: string; count: number }> {
  return db.prepare(`
    SELECT source, COUNT(*) as count
    FROM scrapes
    WHERE scraped_at > datetime('now', '-${Math.floor(hours)} hours')
    GROUP BY source
  `).all() as Array<{ source: string; count: number }>;
}

/**
 * Delete scrapes older than N days.
 */
export function pruneOldScrapes(db: Database.Database, days: number = 30): number {
  const result = db.prepare(`
    DELETE FROM scrapes
    WHERE scraped_at < datetime('now', '-${Math.floor(days)} days')
      AND source NOT LIKE '%youtube%'
  `).run();
  if (result.changes > 0) {
    logger.info({ deleted: result.changes, days }, "Pruned old scrapes");
  }
  return result.changes;
}

// ============================================
// PIPELINE STATE (v2 sequential pipeline)
// ============================================

export type PipelineStep = "pending" | "scored" | "clustered" | "extracted" | "critiqued" | "enriched" | "saved" | "skipped" | "rejected";

export interface ClusterState {
  clusterId: string;
  role: "primary" | "secondary";
  memberIds: string[];
}

export type PipelineAttemptName = "score" | "candidate" | "critique" | "enrich" | "synthesize" | "save";

export interface PipelineState {
  version: number;
  step: PipelineStep;
  score?: { value: number; dimensions: string[]; summary: string };
  cluster?: ClusterState;
  candidate?: { title: string; content: string; tags: string[]; link: string; relevance: string; confidence: number; source: string };
  critique?: { passed: boolean; reason: string; strengths?: string[]; risks?: string[]; novelty?: number; goalAlignment?: number; feasibility?: number };
  enrichment?: Record<string, unknown>;
  attempts: Record<PipelineAttemptName, number>;
  completed_at?: string;
}

const DEFAULT_ATTEMPTS: Record<PipelineAttemptName, number> = {
  score: 0, candidate: 0, critique: 0, enrich: 0, synthesize: 0, save: 0,
};

function pipelineWithDefaults(raw: Partial<PipelineState> | undefined): PipelineState {
  return {
    version: 2,
    step: "pending",
    ...(raw ?? {}),
    attempts: { ...DEFAULT_ATTEMPTS, ...(raw?.attempts ?? {}) },
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function getMetadata(db: Database.Database, scrapeId: string): Record<string, unknown> {
  const row = db.prepare(`SELECT metadata FROM scrapes WHERE id = ?`).get(scrapeId) as { metadata: string | null } | undefined;
  return row?.metadata ? JSON.parse(row.metadata) : {};
}

function setMetadata(db: Database.Database, scrapeId: string, meta: Record<string, unknown>): void {
  db.prepare(`UPDATE scrapes SET metadata = ? WHERE id = ?`).run(JSON.stringify(meta), scrapeId);
}

/** Get pipeline state for a scrape, or null if not started. */
export function getPipelineState(db: Database.Database, scrapeId: string): PipelineState | null {
  const meta = getMetadata(db, scrapeId);
  return (meta.pipeline as PipelineState) ?? null;
}

/** Update pipeline state for a specific step. Merges into existing state. */
export function updatePipelineStep(
  db: Database.Database,
  scrapeId: string,
  step: PipelineStep,
  stepData?: Record<string, unknown>,
): void {
  const meta = getMetadata(db, scrapeId);
  const raw = meta.pipeline as Partial<PipelineState> | undefined;
  const existing = pipelineWithDefaults(raw);

  existing.step = step;
  if (stepData) {
    const stepKey = step === "scored" ? "score"
      : step === "clustered" ? "cluster"
      : step === "extracted" ? "candidate"
      : step === "critiqued" ? "critique"
      : step === "enriched" ? "enrichment"
      : undefined;
    if (stepKey === "score") {
      existing.score = {
        value: Number(stepData.value ?? 0),
        dimensions: stringArray(stepData.dimensions),
        summary: String(stepData.summary ?? ""),
      };
    } else if (stepKey === "cluster") {
      existing.cluster = {
        clusterId: String(stepData.clusterId ?? ""),
        role: stepData.role === "secondary" ? "secondary" : "primary",
        memberIds: stringArray(stepData.memberIds),
      };
    } else if (stepKey === "candidate") {
      existing.candidate = {
        title: String(stepData.title ?? ""),
        content: String(stepData.content ?? ""),
        tags: stringArray(stepData.tags),
        link: String(stepData.link ?? ""),
        relevance: String(stepData.relevance ?? ""),
        confidence: Number(stepData.confidence ?? 0),
        source: String(stepData.source ?? ""),
      };
    } else if (stepKey === "critique") {
      existing.critique = {
        passed: stepData.passed === true,
        reason: String(stepData.reason ?? ""),
        strengths: stringArray(stepData.strengths),
        risks: stringArray(stepData.risks),
      };
    } else if (stepKey === "enrichment") {
      existing.enrichment = stepData;
    }
  }

  meta.pipeline = existing;
  setMetadata(db, scrapeId, meta);
}

/** Increment attempt counter for a specific pipeline step. */
export function incrementPipelineAttempt(
  db: Database.Database,
  scrapeId: string,
  stepName: PipelineAttemptName,
): number {
  const meta = getMetadata(db, scrapeId);
  const raw = meta.pipeline as Partial<PipelineState> | undefined;
  const existing = pipelineWithDefaults(raw);

  existing.attempts[stepName] = (existing.attempts[stepName] ?? 0) + 1;
  meta.pipeline = existing;
  setMetadata(db, scrapeId, meta);
  return existing.attempts[stepName];
}

/** Get scrapes that need a specific pipeline step. */
export function getScrapesForStep(
  db: Database.Database,
  targetStep: PipelineStep,
  hoursWindow = 48,
): StoredScrape[] {
  const since = hoursWindow
    ? `AND scraped_at > datetime('now', '-${Math.floor(hoursWindow)} hours')`
    : "";
  const validMetadata = "(metadata IS NULL OR json_valid(metadata))";

  const stepWhere: Record<PipelineStep, string> = {
    pending: `AND (metadata IS NULL OR json_extract(metadata, '$.pipeline.step') IS NULL OR json_extract(metadata, '$.pipeline.step') = 'pending')`,
    scored: `AND json_extract(metadata, '$.pipeline.step') = 'scored' AND COALESCE(json_extract(metadata, '$.pipeline.score.value'), 0) >= 6`,
    clustered: `AND json_extract(metadata, '$.pipeline.step') = 'clustered' AND json_extract(metadata, '$.pipeline.cluster.role') = 'primary'`,
    extracted: `AND json_extract(metadata, '$.pipeline.step') = 'extracted'`,
    critiqued: `AND json_extract(metadata, '$.pipeline.step') = 'critiqued' AND json_extract(metadata, '$.pipeline.critique.passed') = 1`,
    enriched: `AND json_extract(metadata, '$.pipeline.step') = 'enriched'`,
    saved: "AND 0",
    skipped: "AND 0",
    rejected: "AND 0",
  };

  return db.prepare(`
    SELECT id, source, url, title, author, raw_content, metadata,
           scraped_at, processed_at, idea_id, quality_score
    FROM scrapes
    WHERE processed_at IS NULL ${since}
      AND ${validMetadata}
      ${stepWhere[targetStep]}
    ORDER BY scraped_at DESC
  `).all() as StoredScrape[];
}

const MAX_STEP_RETRIES = 3;

/** Mark a scrape with a terminal decision. Only terminal decisions mark scrapes as processed. */
export function markScrapeTerminal(
  db: Database.Database,
  scrapeId: string,
  reason: "saved" | "skipped" | "rejected" | "exhausted",
  ideaId?: string,
  qualityScore?: number,
): void {
  const step: PipelineStep = reason === "saved" ? "saved" : reason === "rejected" ? "rejected" : "skipped";
  const terminate = db.transaction(() => {
    const pipeline = getPipelineState(db, scrapeId);
    updatePipelineStep(db, scrapeId, step);
    markProcessed(db, scrapeId, ideaId, qualityScore);

    if (pipeline?.cluster?.role === "primary") {
      for (const member of getClusterMembers(db, pipeline.cluster.clusterId)) {
        if (member.id === scrapeId || member.processed_at !== null) continue;
        const memberPipeline = getPipelineState(db, member.id);
        if (memberPipeline?.cluster?.role === "secondary") {
          markScrapeTerminal(db, member.id, reason, ideaId, memberPipeline.score?.value);
        }
      }
    }
  });

  terminate();
  logger.info({ scrapeId, reason, ideaId }, "Scrape reached terminal state");
}

/** Check if a step has exhausted retries. */
export function isStepExhausted(
  db: Database.Database,
  scrapeId: string,
  stepName: PipelineAttemptName,
): boolean {
  const pipeline = getPipelineState(db, scrapeId);
  return (pipeline?.attempts?.[stepName] ?? 0) >= MAX_STEP_RETRIES;
}

/** Get all scrapes belonging to a cluster (by clusterId in metadata). */
export function getClusterMembers(db: Database.Database, clusterId: string): StoredScrape[] {
  return db.prepare(`
    SELECT id, source, url, title, author, raw_content, metadata,
           scraped_at, processed_at, idea_id, quality_score
    FROM scrapes
    WHERE json_valid(metadata)
      AND json_extract(metadata, '$.pipeline.cluster.clusterId') = ?
    ORDER BY scraped_at DESC
  `).all(clusterId) as StoredScrape[];
}

// ============================================
// LINK INBOX
// ============================================

export interface LinkInboxItem {
  id: string;
  url: string;
  source: string;
  link_type: string | null;
  title: string | null;
  notes: string | null;
  status: string;
  scrape_id: string | null;
  error: string | null;
  submitted_at: string;
  processed_at: string | null;
  submitted_by: string | null;
}

/** Detect link type from URL */
function detectLinkType(url: string): string {
  const u = url.toLowerCase();
  if (u.includes("youtube.com/watch") || u.includes("youtube.com/shorts/") || u.includes("youtu.be/")) return "youtube";
  if (u.includes("medium.com/") || u.includes(".medium.com")) return "medium";
  if (u.includes("twitter.com/") || u.includes("x.com/")) return "twitter";
  if (u.includes("github.com/")) return "github";
  return "website";
}

/** Add a URL to the link inbox. Returns true if inserted, false if duplicate/already processed. */
export function addToLinkInbox(
  db: Database.Database,
  url: string,
  opts?: { source?: string; title?: string; notes?: string; submittedBy?: string },
): boolean {
  const linkType = detectLinkType(url);

  // Dedup: skip YouTube URLs already processed or already queued
  if (linkType === "youtube") {
    const videoId = extractVideoId(url);
    if (videoId) {
      try {
        const exists = db.prepare("SELECT 1 FROM youtube_videos WHERE video_id = ?").get(videoId);
        if (exists) {
          logger.info({ url, videoId }, "YouTube video already processed, skipping link inbox");
          return false;
        }
      } catch { /* youtube_videos table may not exist — proceed normally */ }

      // Also check if already queued in link_inbox under a different URL form
      try {
        const queued = db.prepare(
          "SELECT 1 FROM link_inbox WHERE link_type = 'youtube' AND url LIKE ? AND status IN ('pending', 'processing')"
        ).get(`%${videoId}%`);
        if (queued) {
          logger.info({ url, videoId }, "YouTube video already queued in link inbox, skipping");
          return false;
        }
      } catch { /* non-fatal */ }
    }
  }

  const id = `link_${Date.now()}_${linkType}`;
  try {
    const result = db.prepare(`
      INSERT OR IGNORE INTO link_inbox (id, url, source, link_type, title, notes, submitted_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, url.toLowerCase(), opts?.source ?? "manual", linkType, opts?.title ?? null, opts?.notes ?? null, opts?.submittedBy ?? "user");
    return result.changes > 0;
  } catch (err) {
    logger.warn({ error: err, url }, "Failed to add to link inbox");
    return false;
  }
}

/** Get pending links from the inbox, including failed links eligible for retry with exponential backoff. */
export function getPendingLinks(db: Database.Database, limit = 20, maxRetries = 3): LinkInboxItem[] {
  return db.prepare(`
    SELECT * FROM link_inbox
    WHERE status = 'pending'
       OR (status = 'failed' AND fail_count < ? AND (
            processed_at IS NULL
            OR (fail_count = 1 AND processed_at < datetime('now', '-30 minutes'))
            OR (fail_count = 2 AND processed_at < datetime('now', '-2 hours'))
            OR (fail_count >= 3 AND processed_at < datetime('now', '-8 hours'))
          ))
    ORDER BY status ASC, submitted_at ASC LIMIT ?
  `).all(maxRetries, limit) as LinkInboxItem[];
}

/** Mark a link as processing. */
export function markLinkProcessing(db: Database.Database, id: string): void {
  db.prepare(`UPDATE link_inbox SET status = 'processing' WHERE id = ?`).run(id);
}

/** Mark a link as done, linking to the created scrape. */
export function markLinkDone(db: Database.Database, id: string, scrapeId: string): void {
  db.prepare(`
    UPDATE link_inbox SET status = 'done', scrape_id = ?, processed_at = datetime('now') WHERE id = ?
  `).run(scrapeId, id);
}

/** Mark a link as failed, increment fail_count. Pass permanent=true for non-retryable errors. */
export function markLinkFailed(db: Database.Database, id: string, error: string, permanent = false): void {
  if (permanent) {
    db.prepare(`
      UPDATE link_inbox SET status = 'failed', error = ?, processed_at = datetime('now'), fail_count = 99 WHERE id = ?
    `).run(error, id);
    return;
  }
  db.prepare(`
    UPDATE link_inbox SET status = 'failed', error = ?, processed_at = datetime('now'), fail_count = fail_count + 1 WHERE id = ?
  `).run(error, id);
}
