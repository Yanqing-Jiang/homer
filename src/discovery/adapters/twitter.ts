/**
 * Twitter Bookmarks Adapter
 *
 * Fetches bookmarks from Twitter/X using Gemini Flash + agent-browser via Chrome CDP.
 */

import type { SourceConfig, RawDiscoveryItem } from "../types.js";
import { BaseAdapter } from "./base.js";
import { executeOpenCodeCLI } from "../../executors/opencode-cli.js";
import { buildBookmarkScrapePrompt, SCRAPE_OPTIONS } from "../../scraping/browser-prompts.js";

interface BrowserBookmark {
  id: string;
  text: string;
  author: string;
  urls?: string[];
}

export class TwitterAdapter extends BaseAdapter {
  readonly type = "twitter_bookmarks" as const;
  readonly name = "Twitter Bookmarks";

  async isAvailable(): Promise<boolean> {
    try {
      const result = await executeOpenCodeCLI(
        'Run this command and report if it succeeds: agent-browser connect 9222',
        "",
        { model: "google/gemini-3-flash-preview", browserOnly: true, timeout: 15_000 },
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async fetch(config: SourceConfig): Promise<RawDiscoveryItem[]> {
    const maxItems = config.maxItems || 30;

    const result = await executeOpenCodeCLI(
      buildBookmarkScrapePrompt(maxItems),
      "",
      SCRAPE_OPTIONS,
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

    return {
      id: this.generateId(tweetUrl, this.type),
      source: this.type,
      fetchedAt: new Date(),
      title: this.extractTitle(bookmark),
      description: this.cleanText(bookmark.text),
      url: linkedUrl || tweetUrl,
      author: `@${bookmark.author}`,
      metadata: {
        tweetId: bookmark.id,
      },
      rawContent: JSON.stringify(bookmark),
    };
  }

  private extractTitle(bookmark: BrowserBookmark): string {
    const text = bookmark.text;

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
