/**
 * Preference Updater — nightly job that extracts preference signals
 * from the last 24h of activity and updates the preference model.
 *
 * Signal sources (no LLM needed — pure data):
 * - Idea transitions (discussion/planning = positive, archived = negative)
 * - Session summaries (per-project activity)
 * - Outcome check results (yes = positive, no = negative)
 * - Deny history entries (negative signal)
 */

// @ts-ignore
import type Database from "better-sqlite3";
import { updatePreferences, type PreferenceSignal } from "../../preferences/engine.js";
import * as ideaDao from "../../ideas/dao.js";
import { logger } from "../../utils/logger.js";

function extractIdeaSignals(db: Database.Database): PreferenceSignal[] {
  const signals: PreferenceSignal[] = [];

  // Active ideas updated in the last 24h emit positive preference signals.
  // The DAO returns ParsedIdea but we filter by updated_at via raw query.
  try {
    const rows = db.prepare(`
      SELECT id, source, tags, status
      FROM ideas
      WHERE status IN ('discussion','planning','execution')
        AND updated_at > datetime('now', '-24 hours')
    `).all() as Array<{ id: string; source: string | null; tags: string | null; status: string }>;

    for (const row of rows) {
      const tags: string[] = row.tags ? JSON.parse(row.tags) : [];
      const source = row.source || "unknown";
      for (const tag of tags) {
        signals.push({ dimension: `topic:${tag}`, delta: 0.05 });
      }
      signals.push({ dimension: `source:${source}`, delta: 0.05 });
    }
  } catch (err) {
    logger.debug({ error: err }, "Could not extract idea preference signals");
  }

  // ideaDao kept imported for future signal types
  void ideaDao;
  return signals;
}

function extractSessionSignals(db: Database.Database): PreferenceSignal[] {
  const signals: PreferenceSignal[] = [];

  try {
    const sessions = db.prepare(`
      SELECT project, COUNT(*) as count
      FROM session_summaries
      WHERE is_sub_agent = 0
        AND started_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
        AND project IS NOT NULL AND project != ''
      GROUP BY project
    `).all() as Array<{ project: string; count: number }>;

    for (const s of sessions) {
      // +0.02 per session on a project
      signals.push({ dimension: `project:${s.project}`, delta: 0.02 * s.count });
    }
  } catch (err) {
    logger.debug({ error: err }, "Could not extract session signals");
  }

  return signals;
}

function extractOutcomeSignals(db: Database.Database): PreferenceSignal[] {
  const signals: PreferenceSignal[] = [];

  try {
    const outcomes = db.prepare(`
      SELECT source_type, source_id, source_title, outcome
      FROM outcome_checks
      WHERE status = 'checked'
        AND checked_at > datetime('now', '-24 hours')
    `).all() as Array<{
      source_type: string; source_id: string; source_title: string; outcome: string;
    }>;

    for (const o of outcomes) {
      const delta = o.outcome === "yes" ? 0.15 : o.outcome === "partial" ? 0.05 : -0.1;
      signals.push({ dimension: `${o.source_type}:${o.source_id}`, delta });
    }
  } catch (err) {
    logger.debug({ error: err }, "Could not extract outcome signals");
  }

  return signals;
}

function extractDenySignals(db: Database.Database): PreferenceSignal[] {
  const signals: PreferenceSignal[] = [];

  // Check deny_history if it exists (from job-hunt)
  try {
    const denies = db.prepare(`
      SELECT company, title
      FROM deny_history
      WHERE denied_at > datetime('now', '-24 hours')
    `).all() as Array<{ company: string; title: string }>;

    for (const d of denies) {
      signals.push({ dimension: `company:${d.company.toLowerCase()}`, delta: -0.1 });
    }
  } catch {
    // deny_history table may not exist
  }

  return signals;
}

export async function runPreferenceUpdater(
  db: Database.Database,
): Promise<{ success: boolean; output: string; error?: string }> {
  try {
    const allSignals: PreferenceSignal[] = [
      ...extractIdeaSignals(db),
      ...extractSessionSignals(db),
      ...extractOutcomeSignals(db),
      ...extractDenySignals(db),
    ];

    if (allSignals.length === 0) {
      return { success: true, output: "No preference signals in last 24h" };
    }

    // Deduplicate: merge signals with same dimension
    const merged = new Map<string, number>();
    for (const s of allSignals) {
      merged.set(s.dimension, (merged.get(s.dimension) || 0) + s.delta);
    }

    const dedupedSignals: PreferenceSignal[] = Array.from(merged.entries()).map(
      ([dimension, delta]) => ({ dimension, delta })
    );

    const result = updatePreferences(db, dedupedSignals);

    return {
      success: true,
      output: `${dedupedSignals.length} dimensions updated (${result.created} new, ${result.updated} existing) from ${allSignals.length} raw signals`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, output: "", error: message };
  }
}
