/**
 * Twitter Bookmarks Adapter
 *
 * Primary: opencli (zero cost, ~2s). Fallback: executeBrowserScrape on infra errors.
 */

import type { SourceConfig, RawDiscoveryItem } from "../types.js";
import { BaseAdapter } from "./base.js";
import { fetchTwitterBookmarks, isOpenCLIHealthy, isRetryableOpenCLIError } from "../../executors/opencli.js";
import { mapBookmarkToDiscoveryItem } from "../../executors/opencli-mappers.js";
import { executeBrowserScrape } from "../../executors/browser-scrape.js";
import {
  buildBookmarkScrapePrompt,
  BOOKMARK_JSON_START, BOOKMARK_JSON_END,
} from "../../scraping/browser-prompts.js";
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
      return await isOpenCLIHealthy();
    } catch {
      return false;
    }
  }

  async fetch(config: SourceConfig): Promise<RawDiscoveryItem[]> {
    const maxItems = Math.min(config.maxItems || 10, 10);

    // Try opencli first
    const cliResult = await fetchTwitterBookmarks(maxItems);
    if (cliResult.exitCode === 0 && cliResult.data && cliResult.data.length > 0) {
      return cliResult.data.map(b => {
        const item = mapBookmarkToDiscoveryItem(b);
        // Use adapter's generateId for consistency with other adapters
        return {
          ...item,
          id: this.generateId(item.url, this.type),
          source: this.type,
          description: this.cleanText(b.text),
          author: `@${b.author}`,
          rawContent: JSON.stringify(b),
        };
      });
    }

    // Fallback to browser scrape on infra errors
    if (cliResult.exitCode !== 0 && !isRetryableOpenCLIError(cliResult.exitCode)) {
      throw new Error(`opencli bookmarks failed (exit ${cliResult.exitCode}): ${cliResult.error}`);
    }

    const result = await executeBrowserScrape(
      buildBookmarkScrapePrompt(maxItems),
      "", { timeout: 600_000 },
    );

    if (result.exitCode !== 0) {
      throw new Error(`Twitter adapter browser fallback failed: ${result.output?.slice(0, 200)}`);
    }

    const output = result.output ?? "";
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
