/**
 * RSS Feed Adapter
 *
 * Fetches items from configured RSS feeds.
 * Supports Atom and RSS 2.0 formats.
 */

import type { SourceConfig, RawDiscoveryItem } from "../types.js";
import { BaseAdapter } from "./base.js";

interface FeedConfig {
  name: string;
  url: string;
  priority?: number;
}

interface ParsedFeedItem {
  title: string;
  link: string;
  description: string;
  pubDate?: string;
  author?: string;
  categories?: string[];
}

export class RSSAdapter extends BaseAdapter {
  readonly type = "rss" as const;
  readonly name = "RSS Feeds";

  // Default feeds (can be overridden via config)
  private defaultFeeds: FeedConfig[] = [
    { name: "Simon Willison", url: "https://simonwillison.net/atom/everything/", priority: 10 },
    { name: "Hacker News Best", url: "https://hnrss.org/best", priority: 8 },
    { name: "Lobsters", url: "https://lobste.rs/rss", priority: 7 },
    { name: "The Pragmatic Engineer", url: "https://newsletter.pragmaticengineer.com/feed", priority: 9 },
  ];

  async isAvailable(): Promise<boolean> {
    // RSS is always available if we have network
    return true;
  }

  async fetch(config: SourceConfig): Promise<RawDiscoveryItem[]> {
    const maxItems = config.maxItems || 20;
    const feeds = (config.options?.feeds as FeedConfig[]) || this.defaultFeeds;

    const items: RawDiscoveryItem[] = [];

    // Sort feeds by priority
    const sortedFeeds = [...feeds].sort((a, b) => (b.priority || 5) - (a.priority || 5));

    for (const feed of sortedFeeds) {
      if (items.length >= maxItems) break;

      try {
        const feedItems = await this.fetchFeed(feed, Math.ceil(maxItems / feeds.length));
        items.push(...feedItems);
      } catch (error) {
        console.error(`Failed to fetch RSS feed ${feed.name}: ${error}`);
      }
    }

    return items.slice(0, maxItems);
  }

  private async fetchFeed(feed: FeedConfig, limit: number): Promise<RawDiscoveryItem[]> {
    const response = await fetch(feed.url, {
      headers: {
        "User-Agent": "HOMER-Discovery/1.0",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Feed fetch failed: ${response.status}`);
    }

    const xml = await response.text();
    const items = this.parseXml(xml);

    return items.slice(0, limit).map(item => this.transformItem(item, feed));
  }

  private parseXml(xml: string): ParsedFeedItem[] {
    const items: ParsedFeedItem[] = [];

    // Simple regex-based parsing (works for most RSS/Atom feeds)
    // For production, consider using a proper XML parser

    // Try RSS 2.0 format first
    const rssItems = xml.match(/<item>([\s\S]*?)<\/item>/gi);
    if (rssItems) {
      for (const itemXml of rssItems) {
        const item = this.parseRssItem(itemXml);
        if (item) items.push(item);
      }
      return items;
    }

    // Try Atom format
    const atomEntries = xml.match(/<entry>([\s\S]*?)<\/entry>/gi);
    if (atomEntries) {
      for (const entryXml of atomEntries) {
        const item = this.parseAtomEntry(entryXml);
        if (item) items.push(item);
      }
    }

    return items;
  }

  private parseRssItem(xml: string): ParsedFeedItem | null {
    const title = this.extractTag(xml, "title");
    const link = this.extractTag(xml, "link");

    if (!title || !link) return null;

    return {
      title,
      link,
      description: this.extractTag(xml, "description") || "",
      pubDate: this.extractTag(xml, "pubDate"),
      author: this.extractTag(xml, "author") || this.extractTag(xml, "dc:creator"),
      categories: this.extractAllTags(xml, "category"),
    };
  }

  private parseAtomEntry(xml: string): ParsedFeedItem | null {
    const title = this.extractTag(xml, "title");

    // Atom uses <link href="..."/> format
    const linkMatch = xml.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i);
    const link = linkMatch?.[1];

    if (!title || !link) return null;

    return {
      title,
      link,
      description: this.extractTag(xml, "summary") || this.extractTag(xml, "content") || "",
      pubDate: this.extractTag(xml, "published") || this.extractTag(xml, "updated"),
      author: this.extractTag(xml, "name"), // Inside <author><name>
    };
  }

  private extractTag(xml: string, tagName: string): string | undefined {
    // Handle CDATA
    const cdataPattern = new RegExp(`<${tagName}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tagName}>`, "i");
    const cdataMatch = xml.match(cdataPattern);
    if (cdataMatch?.[1]) {
      return this.cleanHtml(cdataMatch[1]);
    }

    // Regular tag
    const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
    const match = xml.match(pattern);
    return match?.[1] ? this.cleanHtml(match[1]) : undefined;
  }

  private extractAllTags(xml: string, tagName: string): string[] {
    const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
    const matches = xml.matchAll(pattern);
    return Array.from(matches).map(m => this.cleanHtml(m[1] ?? ""));
  }

  private cleanHtml(text: string): string {
    return text
      .replace(/<[^>]*>/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  private transformItem(item: ParsedFeedItem, feed: FeedConfig): RawDiscoveryItem {
    return {
      id: this.generateId(item.link, this.type),
      source: this.type,
      fetchedAt: new Date(),
      title: item.title,
      description: item.description.slice(0, 500),
      url: item.link,
      author: item.author,
      metadata: {
        feedName: feed.name,
        publishedAt: this.parseDate(item.pubDate),
      },
      rawContent: JSON.stringify(item),
    };
  }
}
