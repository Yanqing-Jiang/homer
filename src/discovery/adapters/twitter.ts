/**
 * Twitter Bookmarks Adapter
 *
 * Primary: opencli (zero cost, ~2s). Fallback: executeBrowserScrape on infra errors.
 */

import type { SourceConfig, RawDiscoveryItem } from "../types.js";
import { BaseAdapter } from "./base.js";
import { fetchTwitterBookmarks, fetchTwitterArticle, isOpenCLIHealthy, isRetryableOpenCLIError } from "../../executors/opencli.js";
import type { OpenCLIArticle } from "../../executors/opencli.js";
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
      const items = cliResult.data.map(b => {
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
      return this.enrichWithDeepLinks(items);
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

  /**
   * Enrich bookmarks that are URL-only or contain t.co links by fetching
   * the full article content via `opencli twitter article`.
   */
  private async enrichWithDeepLinks(items: RawDiscoveryItem[]): Promise<RawDiscoveryItem[]> {
    const TCO_RE = /https?:\/\/t\.co\/\S+/;
    const MAX_CONCURRENT = 3;

    // Find items worth enriching: URL-only tweets or tweets with t.co links
    const enrichable = items.filter(item => {
      const tweetId = item.metadata.tweetId;
      if (!tweetId) return false;
      const text = (item.description || "").trim();
      // URL-only tweet (just a t.co link, maybe with emoji/whitespace)
      const stripped = text.replace(/[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "");
      if (TCO_RE.test(stripped) && stripped.replace(TCO_RE, "").length < 10) return true;
      // Tweet with a t.co source link (e.g. "... Source: https://t.co/xxx")
      return TCO_RE.test(text);
    });

    if (enrichable.length === 0) return items;

    // Fetch articles in batches to avoid hammering opencli
    const articleMap = new Map<string, OpenCLIArticle>();
    for (let i = 0; i < enrichable.length; i += MAX_CONCURRENT) {
      const batch = enrichable.slice(i, i + MAX_CONCURRENT);
      const results = await Promise.allSettled(
        batch.map(async (item) => {
          const tweetId = item.metadata.tweetId!;
          const result = await fetchTwitterArticle(tweetId);
          if (result.exitCode === 0 && result.data?.content) {
            return { tweetId, article: result.data };
          }
          return null;
        }),
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) {
          articleMap.set(r.value.tweetId, r.value.article);
        }
      }
    }

    if (articleMap.size === 0) return items;

    // Merge article content into discovery items
    return items.map(item => {
      const article = articleMap.get(item.metadata.tweetId || "");
      if (!article) return item;
      return {
        ...item,
        title: article.title || item.title,
        description: article.content.slice(0, 500),
        rawContent: article.content,
        metadata: {
          ...item.metadata,
          deepLinked: true,
          articleTitle: article.title,
        },
      };
    });
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
