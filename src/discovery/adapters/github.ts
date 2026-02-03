/**
 * GitHub Trending Adapter
 *
 * Fetches trending repositories from GitHub.
 * Uses GitHub API or scraping fallback.
 */

import { exec } from "child_process";
import { promisify } from "util";
import type { SourceConfig, RawDiscoveryItem } from "../types.js";
import { BaseAdapter } from "./base.js";

const execAsync = promisify(exec);

interface GitHubRepo {
  name: string;
  full_name: string;          // owner/repo
  description: string | null;
  html_url: string;
  stargazers_count: number;
  language: string | null;
  topics: string[];
  created_at: string;
  updated_at: string;
  owner: {
    login: string;
  };
  // Trending-specific (from scraping)
  todayStars?: number;
}

export class GitHubAdapter extends BaseAdapter {
  readonly type = "github_trending" as const;
  readonly name = "GitHub Trending";

  async isAvailable(): Promise<boolean> {
    // Always available - uses public endpoints
    return true;
  }

  async fetch(config: SourceConfig): Promise<RawDiscoveryItem[]> {
    const maxItems = config.maxItems || 25;
    const since = (config.options?.since as string) || "daily";
    const languages = (config.options?.languages as string[]) || [];

    const items: RawDiscoveryItem[] = [];

    // Fetch for each language (or all if none specified)
    const langList = languages.length > 0 ? languages : [""];

    for (const lang of langList) {
      if (items.length >= maxItems) break;

      try {
        const repos = await this.fetchTrending(lang, since, maxItems - items.length);
        items.push(...repos.map(repo => this.transformRepo(repo)));
      } catch (error) {
        console.error(`Failed to fetch GitHub trending for ${lang || "all"}: ${error}`);
      }
    }

    return items.slice(0, maxItems);
  }

  private async fetchTrending(language: string, since: string, limit: number): Promise<GitHubRepo[]> {
    // Use gh CLI if available for better rate limits
    try {
      return await this.fetchViaGhCli(language, since, limit);
    } catch {
      // Fallback to direct API
      return await this.fetchViaApi(language, since, limit);
    }
  }

  private async fetchViaGhCli(language: string, since: string, limit: number): Promise<GitHubRepo[]> {
    // Search for recently created repos with many stars
    const dateFilter = this.getDateFilter(since);
    const langFilter = language ? `language:${language}` : "";

    const query = `stars:>100 ${langFilter} created:>${dateFilter}`;
    const cmd = `gh api "search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${limit}" --jq '.items'`;

    const { stdout } = await execAsync(cmd, { timeout: 30000 });
    return JSON.parse(stdout) as GitHubRepo[];
  }

  private async fetchViaApi(language: string, since: string, limit: number): Promise<GitHubRepo[]> {
    const dateFilter = this.getDateFilter(since);
    const langFilter = language ? `+language:${encodeURIComponent(language)}` : "";

    const url = `https://api.github.com/search/repositories?q=stars:>100${langFilter}+created:>${dateFilter}&sort=stars&order=desc&per_page=${limit}`;

    const response = await fetch(url, {
      headers: {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "HOMER-Discovery",
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const data = await response.json() as { items: GitHubRepo[] };
    return data.items;
  }

  private getDateFilter(since: string): string {
    const now = new Date();
    switch (since) {
      case "daily":
        now.setDate(now.getDate() - 1);
        break;
      case "weekly":
        now.setDate(now.getDate() - 7);
        break;
      case "monthly":
        now.setMonth(now.getMonth() - 1);
        break;
      default:
        now.setDate(now.getDate() - 1);
    }
    return now.toISOString().split("T")[0] ?? "";
  }

  private transformRepo(repo: GitHubRepo): RawDiscoveryItem {
    return {
      id: this.generateId(repo.html_url, this.type),
      source: this.type,
      fetchedAt: new Date(),
      title: `${repo.full_name}: ${repo.description?.slice(0, 100) || "No description"}`,
      description: this.buildDescription(repo),
      url: repo.html_url,
      author: repo.owner.login,
      metadata: {
        stars: repo.stargazers_count,
        language: repo.language || undefined,
        topics: repo.topics,
        todayStars: repo.todayStars,
      },
      rawContent: JSON.stringify(repo),
    };
  }

  private buildDescription(repo: GitHubRepo): string {
    const parts: string[] = [];

    if (repo.description) {
      parts.push(repo.description);
    }

    parts.push(`\nStars: ${repo.stargazers_count.toLocaleString()}`);

    if (repo.language) {
      parts.push(`Language: ${repo.language}`);
    }

    if (repo.topics.length > 0) {
      parts.push(`Topics: ${repo.topics.slice(0, 5).join(", ")}`);
    }

    return parts.join(" | ");
  }
}
