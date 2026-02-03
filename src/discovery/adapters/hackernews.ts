/**
 * Hacker News Adapter
 *
 * Fetches top stories from HN front page.
 * Uses official HN Firebase API.
 */

import type { SourceConfig, RawDiscoveryItem } from "../types.js";
import { BaseAdapter } from "./base.js";

interface HNItem {
  id: number;
  title: string;
  url?: string;           // Optional - some are text posts
  text?: string;          // For text posts (Ask HN, etc.)
  by: string;
  score: number;
  descendants: number;    // Comment count
  time: number;           // Unix timestamp
  type: string;           // story, comment, job, poll, pollopt
}

export class HackerNewsAdapter extends BaseAdapter {
  readonly type = "hackernews" as const;
  readonly name = "Hacker News";

  private baseUrl = "https://hacker-news.firebaseio.com/v0";

  async isAvailable(): Promise<boolean> {
    // HN API is always available
    try {
      const response = await fetch(`${this.baseUrl}/topstories.json`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async fetch(config: SourceConfig): Promise<RawDiscoveryItem[]> {
    const maxItems = config.maxItems || 30;
    const minPoints = (config.options?.minPoints as number) || 50;

    // Fetch top story IDs
    const topStoriesResponse = await fetch(`${this.baseUrl}/topstories.json`);
    if (!topStoriesResponse.ok) {
      throw new Error(`HN API error: ${topStoriesResponse.status}`);
    }

    const storyIds = await topStoriesResponse.json() as number[];

    // Fetch story details in parallel (limited batch)
    const batchSize = Math.min(maxItems * 2, 60); // Fetch extra to filter by points
    const itemPromises = storyIds.slice(0, batchSize).map(id => this.fetchItem(id));

    const items = await Promise.all(itemPromises);

    // Filter by minPoints and transform
    return items
      .filter((item): item is HNItem => item !== null && item.score >= minPoints)
      .slice(0, maxItems)
      .map(item => this.transformItem(item));
  }

  private async fetchItem(id: number): Promise<HNItem | null> {
    try {
      const response = await fetch(`${this.baseUrl}/item/${id}.json`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return null;
      return await response.json() as HNItem;
    } catch {
      return null;
    }
  }

  private transformItem(item: HNItem): RawDiscoveryItem {
    const hnUrl = `https://news.ycombinator.com/item?id=${item.id}`;

    return {
      id: this.generateId(hnUrl, this.type),
      source: this.type,
      fetchedAt: new Date(),
      title: item.title,
      description: this.buildDescription(item),
      url: item.url || hnUrl, // Use linked URL if available, else HN discussion
      author: item.by,
      metadata: {
        hnId: item.id,
        points: item.score,
        commentCount: item.descendants || 0,
      },
      rawContent: JSON.stringify(item),
    };
  }

  private buildDescription(item: HNItem): string {
    const parts: string[] = [];

    // Add text content if it's a text post
    if (item.text) {
      // Strip HTML tags
      const cleanText = item.text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      parts.push(cleanText.slice(0, 500));
    }

    // Add metadata
    parts.push(`Points: ${item.score} | Comments: ${item.descendants || 0}`);

    // Calculate age
    const age = this.getRelativeTime(item.time);
    parts.push(`Posted ${age} by ${item.by}`);

    // Add HN discussion link if URL points elsewhere
    if (item.url) {
      parts.push(`Discussion: https://news.ycombinator.com/item?id=${item.id}`);
    }

    return parts.join("\n");
  }

  private getRelativeTime(unixTime: number): string {
    const now = Date.now() / 1000;
    const diff = now - unixTime;

    if (diff < 3600) {
      const mins = Math.floor(diff / 60);
      return `${mins} minute${mins === 1 ? "" : "s"} ago`;
    } else if (diff < 86400) {
      const hours = Math.floor(diff / 3600);
      return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    } else {
      const days = Math.floor(diff / 86400);
      return `${days} day${days === 1 ? "" : "s"} ago`;
    }
  }
}
