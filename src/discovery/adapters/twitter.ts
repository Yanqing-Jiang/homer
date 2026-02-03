/**
 * Twitter Bookmarks Adapter
 *
 * Fetches bookmarks from Twitter/X using Bird CLI.
 * Bird CLI handles authentication and scraping via Chrome CDP.
 */

import { exec } from "child_process";
import { promisify } from "util";
import type { SourceConfig, RawDiscoveryItem } from "../types.js";
import { BaseAdapter } from "./base.js";

const execAsync = promisify(exec);

interface BirdBookmark {
  id: string;
  text: string;
  url: string;
  author: {
    username: string;
    name: string;
  };
  metrics: {
    likes: number;
    retweets: number;
    replies: number;
  };
  createdAt: string;
  bookmarkedAt?: string;
  quotedTweet?: {
    text: string;
    author: string;
  };
  media?: Array<{
    type: string;
    url: string;
  }>;
}

export class TwitterAdapter extends BaseAdapter {
  readonly type = "twitter_bookmarks" as const;
  readonly name = "Twitter Bookmarks";

  private birdPath = "bird"; // Assumes bird is in PATH

  async isAvailable(): Promise<boolean> {
    try {
      // Check if bird CLI is available
      await execAsync("which bird");
      return true;
    } catch {
      return false;
    }
  }

  async fetch(config: SourceConfig): Promise<RawDiscoveryItem[]> {
    const maxItems = config.maxItems || 50;
    // includeThreads option available for future use
    void (config.options?.includeThreads ?? true);

    try {
      // Use bird CLI to fetch bookmarks
      // bird bookmarks --format json --limit N
      const cmd = `${this.birdPath} bookmarks --format json --limit ${maxItems}`;
      const { stdout } = await execAsync(cmd, { timeout: 60000 });

      const bookmarks: BirdBookmark[] = JSON.parse(stdout);

      return bookmarks.map(bookmark => this.transformBookmark(bookmark));
    } catch (error) {
      // Fallback: Try alternative bird command format
      try {
        const cmd = `${this.birdPath} get-bookmarks --json --count ${maxItems}`;
        const { stdout } = await execAsync(cmd, { timeout: 60000 });

        const bookmarks: BirdBookmark[] = JSON.parse(stdout);
        return bookmarks.map(bookmark => this.transformBookmark(bookmark));
      } catch {
        throw new Error(`Twitter adapter failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private transformBookmark(bookmark: BirdBookmark): RawDiscoveryItem {
    // Extract URLs from tweet text (often bookmarks contain links)
    const urlMatch = bookmark.text.match(/https?:\/\/[^\s]+/);
    const linkedUrl = urlMatch?.[0];

    // Build description with context
    let description = bookmark.text;
    if (bookmark.quotedTweet) {
      description += `\n\nQuoted: "${bookmark.quotedTweet.text}" - @${bookmark.quotedTweet.author}`;
    }

    return {
      id: this.generateId(bookmark.url, this.type),
      source: this.type,
      fetchedAt: new Date(),
      title: this.extractTitle(bookmark),
      description: this.cleanText(description),
      url: linkedUrl || bookmark.url, // Prefer linked URL, fallback to tweet URL
      author: `@${bookmark.author.username}`,
      metadata: {
        tweetId: bookmark.id,
        likeCount: bookmark.metrics.likes,
        retweetCount: bookmark.metrics.retweets,
        bookmarkedAt: this.parseDate(bookmark.bookmarkedAt),
      },
      rawContent: JSON.stringify(bookmark),
    };
  }

  private extractTitle(bookmark: BirdBookmark): string {
    const text = bookmark.text;

    // If tweet contains a URL, try to extract title from surrounding context
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      // Get text before URL as potential title
      const beforeUrl = text.slice(0, text.indexOf(urlMatch[0])).trim();
      if (beforeUrl.length > 10 && beforeUrl.length < 200) {
        return beforeUrl;
      }
    }

    // Truncate long tweets for title
    if (text.length > 100) {
      return text.slice(0, 100) + "...";
    }

    return text || `Tweet by @${bookmark.author.username}`;
  }
}
