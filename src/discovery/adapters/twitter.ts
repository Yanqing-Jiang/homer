/**
 * Twitter Bookmarks Adapter
 *
 * Fetches bookmarks from Twitter/X using Codex + agent-browser via Chrome CDP.
 * Uses marker-wrapped extraction-only prompt (no deep-fetch, no enrichment).
 */

import type { SourceConfig, RawDiscoveryItem } from "../types.js";
import { BaseAdapter } from "./base.js";
import { executeCodexBrowserScrape } from "../../executors/codex-browser.js";
import {
  buildBookmarkScrapePrompt,
  BOOKMARK_JSON_START, BOOKMARK_JSON_END,
  SCRAPE_OPTIONS,
} from "../../scraping/browser-prompts.js";
import { X_BOOKMARK_CODEX_SKILLS } from "../../scraping/skill-paths.js";
import { cleanAgentOutput } from "../../scraping/clean-output.js";
import { parseSwarmJSON } from "../../executors/model-swarm.js";
import { z } from "zod";

const BookmarkSchema = z.object({
  id: z.string().regex(/^\d{8,25}$/),
  author: z.string().min(1).max(30),
  url: z.string().url(),
  text: z.string().min(15),
  external_urls: z.array(z.string().url()).optional().default([]),
});
const BookmarksArraySchema = z.array(BookmarkSchema);
type ParsedBookmark = z.infer<typeof BookmarkSchema>;

function extractMarkedBlock(raw: string, start: string, end: string): string | null {
  const si = raw.indexOf(start);
  if (si === -1) return null;
  const from = si + start.length;
  const ei = raw.indexOf(end, from);
  if (ei === -1) return null;
  return raw.slice(from, ei).trim();
}

export class TwitterAdapter extends BaseAdapter {
  readonly type = "twitter_bookmarks" as const;
  readonly name = "Twitter Bookmarks";

  async isAvailable(): Promise<boolean> {
    try {
      const result = await executeCodexBrowserScrape(
        'Run this command and report if it succeeds: agent-browser connect 9222',
        { timeout: 15_000, skillPaths: X_BOOKMARK_CODEX_SKILLS },
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async fetch(config: SourceConfig): Promise<RawDiscoveryItem[]> {
    const maxItems = Math.min(config.maxItems || 10, 10);

    const result = await executeCodexBrowserScrape(
      buildBookmarkScrapePrompt(maxItems),
      { ...SCRAPE_OPTIONS, skillPaths: X_BOOKMARK_CODEX_SKILLS },
    );

    if (result.exitCode !== 0) {
      throw new Error(`Twitter adapter failed: ${result.output?.slice(0, 200)}`);
    }

    const output = result.output ?? "";

    // Try markers first, fall back to cleaning raw output
    const marked = extractMarkedBlock(output, BOOKMARK_JSON_START, BOOKMARK_JSON_END);
    const candidate = marked ?? cleanAgentOutput(output);

    let bookmarks: ParsedBookmark[];
    try {
      bookmarks = parseSwarmJSON(candidate, BookmarksArraySchema);
    } catch {
      if (marked) {
        try {
          bookmarks = parseSwarmJSON(cleanAgentOutput(output), BookmarksArraySchema);
        } catch {
          return [];
        }
      } else {
        return [];
      }
    }

    return bookmarks.map(b => this.transformBookmark(b));
  }

  private transformBookmark(bookmark: ParsedBookmark): RawDiscoveryItem {
    const author = bookmark.author.replace(/^@/, "");
    const tweetUrl = `https://x.com/${author}/status/${bookmark.id}`;
    const externalUrl = (bookmark.external_urls ?? []).find(
      u => !u.includes("x.com") && !u.includes("twitter.com"),
    );

    // Generate title from text (deterministic)
    const clean = bookmark.text.replace(/\s+/g, " ").trim();
    const firstSentence = clean.split(/[.!?\n]/)[0]?.trim() || clean;
    const title = firstSentence.length > 80
      ? `${firstSentence.slice(0, 77)}...`
      : firstSentence;

    return {
      id: this.generateId(tweetUrl, this.type),
      source: this.type,
      fetchedAt: new Date(),
      title: title || `@${author} bookmark`,
      description: this.cleanText(bookmark.text),
      url: externalUrl || tweetUrl,
      author: `@${author}`,
      metadata: {
        tweetId: bookmark.id,
      },
      rawContent: JSON.stringify(bookmark),
    };
  }
}
