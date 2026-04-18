/**
 * Shared state between mentor-layer.ts and career-truth.ts.
 *
 * Stored at ~/homer/data/advisory_state.json. Tracks recent topics
 * emitted by either job so they don't echo each other and so the
 * mentor layer's pilot-card flag persists across restarts.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import { PATHS } from "../../config/paths.js";
import { join } from "path";

export interface AdvisoryTopicRecord {
  topic: string;
  emitter: "mentor" | "career-truth";
  title?: string;
  timestamp: string; // ISO8601
}

export interface AdvisoryState {
  firstCardSent: boolean;
  recentTopics: AdvisoryTopicRecord[]; // newest-first, capped at RECENT_CAP
  careerTruthPauseUntil?: string; // ISO8601 — kill-switch for career-truth only
  careerTruthZeroEngagementStreak: number;
}

const RECENT_CAP = 20;

function advisoryStatePath(): string {
  return join(PATHS.homerData, "advisory_state.json");
}

export async function loadAdvisoryState(): Promise<AdvisoryState> {
  const path = advisoryStatePath();
  if (!existsSync(path)) {
    return {
      firstCardSent: false,
      recentTopics: [],
      careerTruthZeroEngagementStreak: 0,
    };
  }
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AdvisoryState>;
    return {
      firstCardSent: parsed.firstCardSent === true,
      recentTopics: Array.isArray(parsed.recentTopics) ? parsed.recentTopics : [],
      careerTruthPauseUntil: parsed.careerTruthPauseUntil,
      careerTruthZeroEngagementStreak: parsed.careerTruthZeroEngagementStreak ?? 0,
    };
  } catch {
    return {
      firstCardSent: false,
      recentTopics: [],
      careerTruthZeroEngagementStreak: 0,
    };
  }
}

async function saveAdvisoryState(state: AdvisoryState): Promise<void> {
  const path = advisoryStatePath();
  if (!existsSync(dirname(path))) {
    await mkdir(dirname(path), { recursive: true });
  }
  await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
}

export async function recordAdvisoryTopic(opts: {
  topic: string;
  emitter: "mentor" | "career-truth";
  title?: string;
  markFirstCardSent?: boolean;
}): Promise<void> {
  const state = await loadAdvisoryState();
  state.recentTopics.unshift({
    topic: opts.topic,
    emitter: opts.emitter,
    title: opts.title,
    timestamp: new Date().toISOString(),
  });
  state.recentTopics = state.recentTopics.slice(0, RECENT_CAP);
  if (opts.markFirstCardSent) state.firstCardSent = true;
  await saveAdvisoryState(state);
}

export async function setCareerTruthPause(until: string): Promise<void> {
  const state = await loadAdvisoryState();
  state.careerTruthPauseUntil = until;
  state.careerTruthZeroEngagementStreak = 0;
  await saveAdvisoryState(state);
}

export async function incrementCareerTruthZeroEngagement(): Promise<number> {
  const state = await loadAdvisoryState();
  state.careerTruthZeroEngagementStreak = (state.careerTruthZeroEngagementStreak ?? 0) + 1;
  await saveAdvisoryState(state);
  return state.careerTruthZeroEngagementStreak;
}

export async function resetCareerTruthZeroEngagement(): Promise<void> {
  const state = await loadAdvisoryState();
  state.careerTruthZeroEngagementStreak = 0;
  await saveAdvisoryState(state);
}
