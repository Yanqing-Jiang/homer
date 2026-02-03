/**
 * Discovery Scheduler Integration
 *
 * Integrates the Discovery Engine with HOMER's unified scheduler.
 * Provides schedule.json job configs and execution hooks.
 */

import { DiscoveryEngine } from "./engine.js";
import type { DiscoverySession } from "./types.js";

// ============================================
// SCHEDULE CONFIGURATION
// ============================================

/**
 * Default discovery schedule entries for schedule.json
 */
export const DISCOVERY_SCHEDULES = {
  // Full discovery: runs at 2 AM daily
  nightly: {
    id: "discovery-nightly",
    name: "Nightly Discovery",
    cron: "0 2 * * *", // 2:00 AM daily
    query: "Run full discovery session across all sources",
    lane: "default" as const,
    enabled: true,
    timeout: 600000, // 10 minutes
    executor: "claude" as const,
    contextFiles: ["~/memory/me.md", "~/memory/work.md"],
    notifyOnSuccess: false,
    notifyOnFailure: true,
  },

  // GitHub-only discovery: runs at 8 AM (trending resets)
  githubMorning: {
    id: "discovery-github-morning",
    name: "GitHub Trending Check",
    cron: "0 8 * * *", // 8:00 AM daily
    query: "Check GitHub trending for new interesting repos",
    lane: "default" as const,
    enabled: true,
    timeout: 180000, // 3 minutes
    executor: "claude" as const,
    notifyOnSuccess: false,
    notifyOnFailure: true,
  },

  // Twitter bookmarks: runs at 10 PM (before sleep)
  twitterEvening: {
    id: "discovery-twitter-evening",
    name: "Process Twitter Bookmarks",
    cron: "0 22 * * *", // 10:00 PM daily
    query: "Process new Twitter bookmarks for interesting content",
    lane: "default" as const,
    enabled: false, // Disabled by default (requires bird setup)
    timeout: 300000, // 5 minutes
    executor: "claude" as const,
    notifyOnSuccess: false,
    notifyOnFailure: true,
  },

  // Weekend deep dive: runs Saturday at 3 AM
  weekendDeepDive: {
    id: "discovery-weekend",
    name: "Weekend Deep Discovery",
    cron: "0 3 * * 6", // 3:00 AM Saturday
    query: "Deep discovery session with extended research on top findings",
    lane: "default" as const,
    enabled: true,
    timeout: 900000, // 15 minutes
    executor: "claude" as const,
    contextFiles: ["~/memory/me.md", "~/memory/work.md", "~/memory/life.md"],
    notifyOnSuccess: true,
    notifyOnFailure: true,
  },
};

// ============================================
// EXECUTION FUNCTIONS
// ============================================

/**
 * Run nightly full discovery
 */
export async function runNightlyDiscovery(): Promise<DiscoverySession> {
  const engine = new DiscoveryEngine({
    maxProposalsPerSession: 15,
  });

  return await engine.discover();
}

/**
 * Run GitHub-only discovery
 */
export async function runGitHubDiscovery(): Promise<DiscoverySession> {
  const { DEFAULT_SOURCES } = await import("./types.js");

  const engine = new DiscoveryEngine({
    sources: DEFAULT_SOURCES.map(s => ({
      ...s,
      enabled: s.type === "github_trending",
    })),
    maxProposalsPerSession: 5,
  });

  return await engine.discover();
}

/**
 * Run Twitter bookmarks discovery
 */
export async function runTwitterDiscovery(): Promise<DiscoverySession> {
  const { DEFAULT_SOURCES } = await import("./types.js");

  const engine = new DiscoveryEngine({
    sources: DEFAULT_SOURCES.map(s => ({
      ...s,
      enabled: s.type === "twitter_bookmarks",
    })),
    maxProposalsPerSession: 10,
  });

  return await engine.discover();
}

/**
 * Run HN discovery
 */
export async function runHackerNewsDiscovery(): Promise<DiscoverySession> {
  const { DEFAULT_SOURCES } = await import("./types.js");

  const engine = new DiscoveryEngine({
    sources: DEFAULT_SOURCES.map(s => ({
      ...s,
      enabled: s.type === "hackernews",
    })),
    maxProposalsPerSession: 8,
  });

  return await engine.discover();
}

/**
 * Run weekend deep discovery (all sources, higher limits)
 */
export async function runWeekendDiscovery(): Promise<DiscoverySession> {
  const engine = new DiscoveryEngine({
    maxProposalsPerSession: 25,
    minScoreForProposal: 20, // Lower threshold for weekend exploration
  });

  return await engine.discover();
}

// ============================================
// SCHEDULER INTEGRATION HELPER
// ============================================

/**
 * Map of discovery job IDs to their execution functions
 */
export const DISCOVERY_EXECUTORS: Record<string, () => Promise<DiscoverySession>> = {
  "discovery-nightly": runNightlyDiscovery,
  "discovery-github-morning": runGitHubDiscovery,
  "discovery-twitter-evening": runTwitterDiscovery,
  "discovery-weekend": runWeekendDiscovery,
};

/**
 * Execute a discovery job by ID
 */
export async function executeDiscoveryJob(jobId: string): Promise<DiscoverySession | null> {
  const executor = DISCOVERY_EXECUTORS[jobId];
  if (!executor) {
    console.error(`Unknown discovery job: ${jobId}`);
    return null;
  }

  return await executor();
}

/**
 * Format discovery session for scheduler notification
 */
export function formatSessionForNotification(session: DiscoverySession): string {
  const lines: string[] = [
    `Discovery completed (${session.id})`,
    `Sources: ${session.sources.join(", ")}`,
    `Items: ${session.itemsFetched} fetched, ${session.itemsBlocked} blocked`,
    `Proposals: ${session.proposalsCreated} created`,
  ];

  if (session.proposalsCreated > 0) {
    lines.push("");
    lines.push("Top proposals:");
    for (const p of session.proposals.slice(0, 5)) {
      lines.push(`- [${p.priorityScore}] ${p.title.slice(0, 60)}`);
    }
  }

  if (session.errors.length > 0) {
    lines.push("");
    lines.push(`Errors: ${session.errors.length}`);
  }

  return lines.join("\n");
}
