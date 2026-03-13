/**
 * Scrape Store — thin wrapper around the `scrapes` SQLite table.
 *
 * All scraping pipelines (idea-ingest, ideas-explore, content-scraper)
 * write here first. The idea-synthesizer reads unprocessed scrapes
 * and creates ideas with provenance tracking.
 */

import type Database from "better-sqlite3";
import { logger } from "../utils/logger.js";

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
      scrape.url ?? null,
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
 * Get unprocessed scrapes, optionally filtered by recency.
 */
export function getUnprocessedScrapes(
  db: Database.Database,
  hoursAgo?: number,
): StoredScrape[] {
  const since = hoursAgo
    ? `AND scraped_at > datetime('now', '-${Math.floor(hoursAgo)} hours')`
    : "";

  return db.prepare(`
    SELECT id, source, url, title, author, raw_content, metadata,
           scraped_at, processed_at, idea_id, quality_score
    FROM scrapes
    WHERE processed_at IS NULL ${since}
    ORDER BY scraped_at DESC
  `).all() as StoredScrape[];
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
  `).run();
  if (result.changes > 0) {
    logger.info({ deleted: result.changes, days }, "Pruned old scrapes");
  }
  return result.changes;
}
