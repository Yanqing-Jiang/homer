/**
 * Preference Engine — quantitative model of user preferences.
 *
 * Aggregates feedback signals into per-dimension scores.
 * Uses Bayesian-style updates: each signal nudges the score
 * toward 1.0 (positive) or 0.0 (negative) from a 0.5 baseline.
 *
 * Dimensions are strings like:
 *   topic:ai-agents, topic:trading, source:github-trending,
 *   source:bookmark, company-tier:1, work:remote,
 *   content:tutorial, project:mahoraga, project:homer
 */

// @ts-ignore
import type Database from "better-sqlite3";
import { logger } from "../utils/logger.js";

export interface PreferenceSignal {
  dimension: string;
  delta: number;  // positive = preference, negative = aversion
}

/**
 * Update preferences with a batch of signals.
 * Uses bounded update: score stays in [0.01, 0.99] range.
 */
export function updatePreferences(
  db: Database.Database,
  signals: PreferenceSignal[],
): { updated: number; created: number } {
  let updated = 0;
  let created = 0;

  const upsert = db.prepare(`
    INSERT INTO preference_model (dimension, score, evidence_count, last_updated)
    VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(dimension) DO UPDATE SET
      score = MIN(0.99, MAX(0.01, score + ?)),
      evidence_count = evidence_count + 1,
      last_updated = datetime('now')
  `);

  const existing = db.prepare(`SELECT 1 FROM preference_model WHERE dimension = ?`);

  const runBatch = db.transaction(() => {
    for (const signal of signals) {
      const exists = existing.get(signal.dimension);
      const initialScore = 0.5 + signal.delta;
      upsert.run(signal.dimension, Math.min(0.99, Math.max(0.01, initialScore)), signal.delta);
      if (exists) {
        updated++;
      } else {
        created++;
      }
    }
  });

  try {
    runBatch();
  } catch (err) {
    logger.error({ error: err }, "Failed to update preferences");
  }

  return { updated, created };
}

/**
 * Get current preference scores.
 */
export function getPreferences(
  db: Database.Database,
  dimensions?: string[],
): Array<{ dimension: string; score: number; evidence_count: number }> {
  if (dimensions && dimensions.length > 0) {
    const placeholders = dimensions.map(() => "?").join(",");
    return db.prepare(`
      SELECT dimension, score, evidence_count
      FROM preference_model
      WHERE dimension IN (${placeholders})
      ORDER BY score DESC
    `).all(...dimensions) as Array<{ dimension: string; score: number; evidence_count: number }>;
  }

  return db.prepare(`
    SELECT dimension, score, evidence_count
    FROM preference_model
    ORDER BY ABS(score - 0.5) DESC
  `).all() as Array<{ dimension: string; score: number; evidence_count: number }>;
}

/**
 * Get top N strongest preference signals (furthest from 0.5 baseline).
 */
export function getTopPreferences(
  db: Database.Database,
  n: number = 10,
): Array<{ dimension: string; score: number; evidence_count: number }> {
  return db.prepare(`
    SELECT dimension, score, evidence_count
    FROM preference_model
    WHERE evidence_count >= 2
    ORDER BY ABS(score - 0.5) DESC
    LIMIT ?
  `).all(n) as Array<{ dimension: string; score: number; evidence_count: number }>;
}

/**
 * Format preferences as compact markdown for injection into LLM prompts.
 * Returns ~200 tokens max.
 */
export function formatForPrompt(
  db: Database.Database,
): string {
  const prefs = getTopPreferences(db, 15);
  if (prefs.length === 0) return "";

  const likes = prefs.filter(p => p.score > 0.6);
  const dislikes = prefs.filter(p => p.score < 0.4);

  const lines: string[] = [];

  if (likes.length > 0) {
    lines.push("**Prefers:** " + likes.map(p => {
      const [category, ...rest] = p.dimension.split(":");
      return rest.join(":") || category;
    }).join(", "));
  }

  if (dislikes.length > 0) {
    lines.push("**Avoids:** " + dislikes.map(p => {
      const [category, ...rest] = p.dimension.split(":");
      return rest.join(":") || category;
    }).join(", "));
  }

  return lines.join("\n");
}

/**
 * Get model-related preferences for routing decisions.
 */
export function getModelPreferences(
  db: Database.Database,
): Array<{ dimension: string; score: number }> {
  try {
    return db.prepare(`
      SELECT dimension, score FROM preference_model
      WHERE dimension LIKE 'model:%' OR dimension LIKE 'executor:%'
      ORDER BY score DESC LIMIT 10
    `).all() as Array<{ dimension: string; score: number }>;
  } catch {
    return [];
  }
}
