/**
 * Deduplication Logic
 *
 * Handles deduplication of discovery items across sessions and sources.
 * Uses content similarity and URL normalization.
 */

import { createHash } from "crypto";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import type { ScoredDiscoveryItem } from "./types.js";

// ============================================
// DEDUP STATE
// ============================================

interface DedupState {
  version: number;
  lastUpdated: string;
  seenUrls: Record<string, SeenItem>;
  contentHashes: Record<string, string>; // hash -> url
  titleHashes: Record<string, string[]>; // hash -> urls (for fuzzy matching)
}

interface SeenItem {
  url: string;
  title: string;
  source: string;
  firstSeen: string;
  lastSeen: string;
  proposalCreated: boolean;
}

const DEDUP_VERSION = 1;
const MAX_HISTORY_DAYS = 30; // Keep 30 days of history

// ============================================
// DEDUPLICATOR CLASS
// ============================================

export class Deduplicator {
  private state: DedupState;
  private statePath: string;
  private dirty = false;

  constructor(statePath: string) {
    this.statePath = statePath;
    this.state = this.createEmptyState();
  }

  /**
   * Load state from disk
   */
  async load(): Promise<void> {
    if (!existsSync(this.statePath)) {
      this.state = this.createEmptyState();
      return;
    }

    try {
      const content = await readFile(this.statePath, "utf-8");
      this.state = JSON.parse(content) as DedupState;

      // Migrate if needed
      if (this.state.version !== DEDUP_VERSION) {
        this.state = this.migrate(this.state);
      }

      // Clean old entries
      this.cleanOldEntries();
    } catch {
      this.state = this.createEmptyState();
    }
  }

  /**
   * Save state to disk
   */
  async save(): Promise<void> {
    if (!this.dirty) return;

    this.state.lastUpdated = new Date().toISOString();
    await writeFile(this.statePath, JSON.stringify(this.state, null, 2));
    this.dirty = false;
  }

  /**
   * Filter out duplicates from a list of items
   */
  deduplicate(items: ScoredDiscoveryItem[]): ScoredDiscoveryItem[] {
    const result: ScoredDiscoveryItem[] = [];
    const sessionSeen = new Set<string>();

    for (const item of items) {
      // Skip blocked items
      if (item.isBlocked) {
        continue;
      }

      // Check various dedup strategies
      const urlKey = this.normalizeUrl(item.url);
      const contentHash = this.hashContent(item.title, item.description);
      const titleHash = this.hashTitle(item.title);

      // Check if already seen (exact URL match)
      if (this.state.seenUrls[urlKey]) {
        this.updateSeenItem(urlKey);
        continue;
      }

      // Check content hash (same content, different URL)
      if (this.state.contentHashes[contentHash]) {
        continue;
      }

      // Check title similarity (fuzzy match)
      if (this.isTitleSimilar(titleHash)) {
        continue;
      }

      // Check within session (batch dedup)
      if (sessionSeen.has(contentHash)) {
        continue;
      }

      // Not a duplicate - add to results
      result.push(item);
      sessionSeen.add(contentHash);

      // Mark as seen
      this.markSeen(item, urlKey, contentHash, titleHash);
    }

    return result;
  }

  /**
   * Mark an item as having a proposal created
   */
  markProposalCreated(url: string): void {
    const urlKey = this.normalizeUrl(url);
    if (this.state.seenUrls[urlKey]) {
      this.state.seenUrls[urlKey].proposalCreated = true;
      this.dirty = true;
    }
  }

  /**
   * Get dedup statistics
   */
  getStats(): { totalSeen: number; lastUpdated: string; oldestEntry: string } {
    const urls = Object.values(this.state.seenUrls);
    const firstUrl = urls[0];
    const oldest = urls.length > 0 && firstUrl
      ? urls.reduce((min, item) => item.firstSeen < min ? item.firstSeen : min, firstUrl.firstSeen)
      : new Date().toISOString();

    return {
      totalSeen: Object.keys(this.state.seenUrls).length,
      lastUpdated: this.state.lastUpdated,
      oldestEntry: oldest,
    };
  }

  // ============================================
  // PRIVATE METHODS
  // ============================================

  private createEmptyState(): DedupState {
    return {
      version: DEDUP_VERSION,
      lastUpdated: new Date().toISOString(),
      seenUrls: {},
      contentHashes: {},
      titleHashes: {},
    };
  }

  private migrate(_oldState: DedupState): DedupState {
    // For now, just create a new state
    // Future versions can add migration logic
    return this.createEmptyState();
  }

  private cleanOldEntries(): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_HISTORY_DAYS);
    const cutoffStr = cutoff.toISOString();

    // Clean old URL entries
    for (const [key, item] of Object.entries(this.state.seenUrls)) {
      if (item.lastSeen < cutoffStr) {
        delete this.state.seenUrls[key];
        this.dirty = true;
      }
    }

    // Rebuild content and title hashes from remaining URLs
    const validContentHashes: Record<string, string> = {};
    const validTitleHashes: Record<string, string[]> = {};

    for (const [urlKey, item] of Object.entries(this.state.seenUrls)) {
      const contentHash = this.hashContent(item.title, "");
      const titleHash = this.hashTitle(item.title);

      validContentHashes[contentHash] = urlKey;

      if (!validTitleHashes[titleHash]) {
        validTitleHashes[titleHash] = [];
      }
      validTitleHashes[titleHash].push(urlKey);
    }

    this.state.contentHashes = validContentHashes;
    this.state.titleHashes = validTitleHashes;
  }

  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);

      // Remove common tracking parameters
      const trackingParams = [
        "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
        "ref", "source", "via", "fbclid", "gclid", "mc_cid", "mc_eid",
      ];
      for (const param of trackingParams) {
        parsed.searchParams.delete(param);
      }

      // Normalize hostname
      let host = parsed.hostname.toLowerCase();
      if (host.startsWith("www.")) {
        host = host.slice(4);
      }

      // Normalize path
      let path = parsed.pathname;
      if (path.endsWith("/") && path.length > 1) {
        path = path.slice(0, -1);
      }

      return `${host}${path}${parsed.search}`;
    } catch {
      // If URL parsing fails, use the raw URL
      return url.toLowerCase();
    }
  }

  private hashContent(title: string, description: string): string {
    // Normalize text for hashing
    const normalized = `${title} ${description}`
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  }

  private hashTitle(title: string): string {
    // More aggressive normalization for title matching
    const normalized = title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 50); // Only first 50 chars

    return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  }

  private isTitleSimilar(titleHash: string): boolean {
    const existingUrls = this.state.titleHashes[titleHash];
    return !!(existingUrls && existingUrls.length > 0);
  }

  private markSeen(
    item: ScoredDiscoveryItem,
    urlKey: string,
    contentHash: string,
    titleHash: string
  ): void {
    const now = new Date().toISOString();

    // Add to seen URLs
    this.state.seenUrls[urlKey] = {
      url: item.url,
      title: item.title,
      source: item.source,
      firstSeen: now,
      lastSeen: now,
      proposalCreated: false,
    };

    // Add content hash
    this.state.contentHashes[contentHash] = urlKey;

    // Add title hash
    if (!this.state.titleHashes[titleHash]) {
      this.state.titleHashes[titleHash] = [];
    }
    this.state.titleHashes[titleHash].push(urlKey);

    this.dirty = true;
  }

  private updateSeenItem(urlKey: string): void {
    if (this.state.seenUrls[urlKey]) {
      this.state.seenUrls[urlKey].lastSeen = new Date().toISOString();
      this.dirty = true;
    }
  }
}

// ============================================
// CONVENIENCE FUNCTIONS
// ============================================

/**
 * Quick dedup without persistence
 */
export function quickDedup(items: ScoredDiscoveryItem[]): ScoredDiscoveryItem[] {
  const seen = new Set<string>();
  const result: ScoredDiscoveryItem[] = [];

  for (const item of items) {
    if (item.isBlocked) continue;

    const key = `${item.url}:${item.title.toLowerCase().slice(0, 50)}`;
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(item);
  }

  return result;
}
