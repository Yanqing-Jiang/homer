/**
 * Discovery Module Index
 *
 * Exports for the HOMER Discovery Engine.
 */

// Main engine
export { DiscoveryEngine } from "./engine.js";
export type { DiscoverySession, DiscoveryProposal } from "./engine.js";

// Types
export type {
  SourceType,
  SourceConfig,
  RawDiscoveryItem,
  ScoredDiscoveryItem,
  RelevanceScore,
  UserContext,
  DiscoveryEngineConfig,
  ProposalStage,
  SourceAdapter,
  ScoringWeights,
} from "./types.js";

export {
  DEFAULT_SOURCES,
  DEFAULT_ENGINE_CONFIG,
  DEFAULT_SCORING_WEIGHTS,
} from "./types.js";

// Adapters
export {
  createAdapter,
  createAdapters,
  checkAvailability,
  TwitterAdapter,
  GitHubAdapter,
  HackerNewsAdapter,
  RSSAdapter,
} from "./adapters/index.js";

// Scoring
export { RelevanceScorer, scoreItems } from "./scorer.js";

// Deduplication
export { Deduplicator, quickDedup } from "./dedup.js";

// Context loading
export { loadUserContext } from "./context-loader.js";

// ============================================
// CONVENIENCE RUNNER
// ============================================

import { DiscoveryEngine } from "./engine.js";
import type { DiscoveryEngineConfig } from "./types.js";

/**
 * Run a discovery session with default configuration
 */
export async function runDiscovery(
  configOverrides?: Partial<DiscoveryEngineConfig>
) {
  const engine = new DiscoveryEngine(configOverrides);
  return await engine.discover();
}

// ============================================
// CLI ENTRY POINT
// ============================================

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help")) {
    console.log(`
HOMER Discovery Engine

Usage: npx tsx discovery/index.ts [options]

Options:
  --help          Show this help message
  --dry-run       Show what would be discovered without creating proposals
  --sources=X     Comma-separated list of sources (github,hackernews,twitter,rss)
  --max=N         Maximum proposals to create (default: 10)

Examples:
  npx tsx discovery/index.ts
  npx tsx discovery/index.ts --sources=github,hackernews --max=5
    `);
    process.exit(0);
  }

  const config: Partial<DiscoveryEngineConfig> = {};

  // Parse sources argument
  const sourcesArg = args.find(a => a.startsWith("--sources="));
  if (sourcesArg) {
    const sourceNames = (sourcesArg.split("=")[1] ?? "").split(",");
    const sourceMap: Record<string, string> = {
      github: "github_trending",
      hackernews: "hackernews",
      twitter: "twitter_bookmarks",
      rss: "rss",
    };

    const { DEFAULT_SOURCES } = await import("./types.js");
    config.sources = DEFAULT_SOURCES.map(s => ({
      ...s,
      enabled: sourceNames.some(name => sourceMap[name] === s.type),
    }));
  }

  // Parse max argument
  const maxArg = args.find(a => a.startsWith("--max="));
  if (maxArg) {
    config.maxProposalsPerSession = parseInt(maxArg.split("=")[1] ?? "10", 10);
  }

  console.log("Starting HOMER Discovery Engine...\n");

  const session = await runDiscovery(config);

  console.log("\n--- Discovery Results ---\n");

  if (session.proposals.length === 0) {
    console.log("No new proposals created.");
  } else {
    console.log(`Created ${session.proposals.length} proposals:\n`);
    for (const proposal of session.proposals) {
      console.log(`[${proposal.priorityScore}] ${proposal.title}`);
      console.log(`    ${proposal.sourceItem.url}`);
      console.log(`    ${proposal.connectionToGoals}\n`);
    }
  }

  if (session.errors.length > 0) {
    console.log("\nErrors encountered:");
    for (const error of session.errors) {
      console.log(`  ${error.source}: ${error.error}`);
    }
  }
}

// Run if executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch(console.error);
}
