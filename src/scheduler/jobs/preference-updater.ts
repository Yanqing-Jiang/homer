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

import type Database from "better-sqlite3";
import { updatePreferences, type PreferenceSignal } from "../../preferences/engine.js";
import { loadIdeasFromDir } from "../../ideas/parser.js";
import { logger } from "../../utils/logger.js";

function extractIdeaSignals(): PreferenceSignal[] {
  const signals: PreferenceSignal[] = [];

  // Load ideas and look for recently transitioned ones
  try {
    const ideas = loadIdeasFromDir();
    for (const idea of ideas) {
      // We can't easily detect "last 24h" transitions from file-based ideas,
      // so we use a heuristic: ideas with notes containing recent dates
      const tags = idea.tags || [];
      const source = idea.source || "unknown";

      if (idea.status === "discussion" || idea.status === "planning" || idea.status === "execution") {
        // Positive signal for active ideas
        for (const tag of tags) {
          signals.push({ dimension: `topic:${tag}`, delta: 0.05 });
        }
        signals.push({ dimension: `source:${source}`, delta: 0.05 });
      }
    }
  } catch (err) {
    logger.debug({ error: err }, "Could not load ideas for preference signals");
  }

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
      ...extractIdeaSignals(),
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
