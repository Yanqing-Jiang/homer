/**
 * Twitter Bookmarks Adapter
 *
 * Fetches bookmarks from Twitter/X using Codex + agent-browser via Chrome CDP.
 */

import type { SourceConfig, RawDiscoveryItem } from "../types.js";
import { BaseAdapter } from "./base.js";
import { executeCodexBrowserScrape } from "../../executors/codex-browser.js";
import { buildBookmarkScrapePrompt, SCRAPE_OPTIONS } from "../../scraping/browser-prompts.js";
import { X_BOOKMARK_CODEX_SKILLS } from "../../scraping/skill-paths.js";

interface BrowserBookmark {
  id: string;
  text: string;
  author: string;
  title?: string;
  content?: string;
  linked_summary?: string;
  image_analysis?: string;
  hook_analysis?: string;
  urls?: string[];
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
    const arrayMatch = output.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      return [];
    }

    let bookmarks: BrowserBookmark[];
    try {
      bookmarks = JSON.parse(arrayMatch[0]);
    } catch {
      throw new Error("Failed to parse browser bookmark output as JSON");
    }

    return bookmarks.map(bookmark => this.transformBookmark(bookmark));
  }

  private transformBookmark(bookmark: BrowserBookmark): RawDiscoveryItem {
    const urlMatch = bookmark.text.match(/https?:\/\/[^\s]+/);
    const linkedUrl = urlMatch?.[0];
    const tweetUrl = `https://x.com/${bookmark.author}/status/${bookmark.id}`;
    const description = [
      bookmark.content || bookmark.text,
      bookmark.linked_summary,
      bookmark.image_analysis,
      bookmark.hook_analysis,
    ]
      .filter(Boolean)
      .join("\n\n");

    return {
      id: this.generateId(tweetUrl, this.type),
      source: this.type,
      fetchedAt: new Date(),
      title: this.extractTitle(bookmark),
      description: this.cleanText(description || bookmark.text),
      url: linkedUrl || tweetUrl,
      author: `@${bookmark.author}`,
      metadata: {
        tweetId: bookmark.id,
      },
      rawContent: JSON.stringify(bookmark),
    };
  }

  private extractTitle(bookmark: BrowserBookmark): string {
    if (bookmark.title?.trim()) return bookmark.title.trim();

    const text = bookmark.content?.trim() || bookmark.text;

    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      const beforeUrl = text.slice(0, text.indexOf(urlMatch[0])).trim();
      if (beforeUrl.length > 10 && beforeUrl.length < 200) {
        return beforeUrl;
      }
    }

    if (text.length > 100) {
      return text.slice(0, 100) + "...";
    }

    return text || `Tweet by @${bookmark.author}`;
  }
}
