/**
 * Source Adapters Index
 *
 * Factory for creating and managing source adapters.
 */

import type { SourceType, SourceAdapter, SourceConfig } from "../types.js";
import { TwitterAdapter } from "./twitter.js";
import { GitHubAdapter } from "./github.js";
import { HackerNewsAdapter } from "./hackernews.js";
import { RSSAdapter } from "./rss.js";

// ============================================
// ADAPTER REGISTRY
// ============================================

const ADAPTERS: Record<SourceType, () => SourceAdapter> = {
  twitter_bookmarks: () => new TwitterAdapter(),
  github_trending: () => new GitHubAdapter(),
  hackernews: () => new HackerNewsAdapter(),
  rss: () => new RSSAdapter(),
  email_digest: () => {
    throw new Error("Email digest adapter not yet implemented");
  },
};

// ============================================
// FACTORY FUNCTIONS
// ============================================

/**
 * Create an adapter for a specific source type
 */
export function createAdapter(type: SourceType): SourceAdapter {
  const factory = ADAPTERS[type];
  if (!factory) {
    throw new Error(`Unknown source type: ${type}`);
  }
  return factory();
}

/**
 * Create adapters for all enabled sources
 */
export function createAdapters(configs: SourceConfig[]): Map<SourceType, SourceAdapter> {
  const adapters = new Map<SourceType, SourceAdapter>();

  for (const config of configs) {
    if (config.enabled) {
      try {
        adapters.set(config.type, createAdapter(config.type));
      } catch (error) {
        console.warn(`Failed to create adapter for ${config.type}: ${error}`);
      }
    }
  }

  return adapters;
}

/**
 * Check which adapters are available
 */
export async function checkAvailability(
  configs: SourceConfig[]
): Promise<Map<SourceType, boolean>> {
  const results = new Map<SourceType, boolean>();
  const adapters = createAdapters(configs);

  const checks = Array.from(adapters.entries()).map(async ([type, adapter]) => {
    try {
      const available = await adapter.isAvailable();
      results.set(type, available);
    } catch {
      results.set(type, false);
    }
  });

  await Promise.all(checks);
  return results;
}

// ============================================
// EXPORTS
// ============================================

export { TwitterAdapter } from "./twitter.js";
export { GitHubAdapter } from "./github.js";
export { HackerNewsAdapter } from "./hackernews.js";
export { RSSAdapter } from "./rss.js";
export { BaseAdapter } from "./base.js";
