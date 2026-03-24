/**
 * Feedback Events DAO — thin data-access layer for review_sessions,
 * review_impressions, and feedback_events tables.
 *
 * No business logic, no LLM calls. Pure SQLite operations.
 */

// @ts-ignore
import type Database from "better-sqlite3";
import { randomUUID } from "crypto";

// ============================================
// TYPES
// ============================================

export interface FeedbackEvent {
  id: number;
  impressionId: number | null;
  contentType: string;
  contentId: string;
  action: string;
  source: string;
  delta: number | null;
  responseTimeMs: number | null;
  metadata: string | null;
  createdAt: string;
}

export interface ReviewSession {
  id: string;
  sessionType: string;
  startedAt: string;
  itemCount: number;
  completedAt: string | null;
  metadata: string | null;
}

export interface ReviewImpression {
  id: number;
  sessionId: string;
  contentType: string;
  contentId: string;
  position: number;
  scoreAtDisplay: number | null;
  displayedAt: string;
  metadata: string | null;
}

// ============================================
// REVIEW SESSIONS
// ============================================

export function createReviewSession(
  db: Database.Database,
  sessionType: string,
  itemCount: number,
  metadata?: Record<string, unknown>,
): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO review_sessions (id, session_type, item_count, metadata)
    VALUES (?, ?, ?, ?)
  `).run(id, sessionType, itemCount, metadata ? JSON.stringify(metadata) : null);
  return id;
}

export function completeReviewSession(
  db: Database.Database,
  sessionId: string,
): void {
  db.prepare(`
    UPDATE review_sessions SET completed_at = datetime('now') WHERE id = ?
  `).run(sessionId);
}

// ============================================
// REVIEW IMPRESSIONS
// ============================================

export function recordImpression(
  db: Database.Database,
  params: {
    sessionId: string;
    contentType: string;
    contentId: string;
    position: number;
    scoreAtDisplay?: number;
    metadata?: Record<string, unknown>;
  },
): number {
  const result = db.prepare(`
    INSERT INTO review_impressions (session_id, content_type, content_id, position, score_at_display, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    params.sessionId,
    params.contentType,
    params.contentId,
    params.position,
    params.scoreAtDisplay ?? null,
    params.metadata ? JSON.stringify(params.metadata) : null,
  );
  return Number(result.lastInsertRowid);
}

// ============================================
// FEEDBACK EVENTS
// ============================================

export function recordFeedback(
  db: Database.Database,
  params: {
    contentType: string;
    contentId: string;
    action: string;
    source: string;
    impressionId?: number;
    delta?: number;
    responseTimeMs?: number;
    metadata?: Record<string, unknown>;
  },
): number {
  const result = db.prepare(`
    INSERT INTO feedback_events (impression_id, content_type, content_id, action, source, delta, response_time_ms, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.impressionId ?? null,
    params.contentType,
    params.contentId,
    params.action,
    params.source,
    params.delta ?? null,
    params.responseTimeMs ?? null,
    params.metadata ? JSON.stringify(params.metadata) : null,
  );
  return Number(result.lastInsertRowid);
}

// ============================================
// QUERIES
// ============================================

export function getFeedbackForContent(
  db: Database.Database,
  contentType: string,
  contentId: string,
): FeedbackEvent[] {
  return db.prepare(`
    SELECT id, impression_id as impressionId, content_type as contentType,
           content_id as contentId, action, source, delta,
           response_time_ms as responseTimeMs, metadata, created_at as createdAt
    FROM feedback_events
    WHERE content_type = ? AND content_id = ?
    ORDER BY created_at DESC
  `).all(contentType, contentId) as FeedbackEvent[];
}

export function getRecentFeedback(
  db: Database.Database,
  hours: number = 24,
): FeedbackEvent[] {
  return db.prepare(`
    SELECT id, impression_id as impressionId, content_type as contentType,
           content_id as contentId, action, source, delta,
           response_time_ms as responseTimeMs, metadata, created_at as createdAt
    FROM feedback_events
    WHERE created_at >= datetime('now', ? || ' hours')
    ORDER BY created_at DESC
  `).all(`-${hours}`) as FeedbackEvent[];
}
