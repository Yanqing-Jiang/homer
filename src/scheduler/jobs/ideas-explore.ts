/**
 * Ideas Explore — GitHub Trending Discovery
 *
 * Deterministic fetch via `gh api`, then Claude Sonnet filters for relevance.
 * Code fetches data, LLM decides what's relevant.
 *
 * Schedule: 30 0 * * * (daily at 00:30, also triggered by idea-ingest)
 */

import { execFileSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { z } from "zod";
// @ts-ignore
import type Database from "better-sqlite3";
import { executeClaudeCommand } from "../../executors/claude.js";
import { parseSwarmJSON } from "../../executors/model-swarm.js";
import * as ideaDao from "../../ideas/dao.js";
import { insertScrape } from "../../scraping/scrape-store.js";
import { extractCurrentGoals, extractActiveProjects } from "../shared-context.js";
import { logger } from "../../utils/logger.js";
import { PATHS } from "../../config/paths.js";

const DENY_HISTORY = PATHS.denyHistory;
const GH_BIN = "/opt/homebrew/bin/gh";

// ============================================
// SCHEMAS
// ============================================

const RepoSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  description: z.union([z.string(), z.null()]).transform((v): string => v ?? ""),
  stars: z.number().optional(),
  language: z.string().optional(),
  relevance: z.string(), // why this matters to Yanqing
});

const ReposArraySchema = z.array(RepoSchema);

function loadFileIfExists(path: string): string {
  if (!existsSync(path)) return "(file not found)";
  return readFileSync(path, "utf-8");
}

/**
 * Fetch trending repos from GitHub API deterministically.
 * Returns raw JSON string of repo objects.
 */
function fetchTrendingRepos(): string {
  const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  try {
    return execFileSync(
      GH_BIN,
      [
        "api",
        `search/repositories?q=created:>${since}+stars:>50&sort=stars&order=desc&per_page=30`,
        "--jq",
        `.items[] | {name: .full_name, description: .description, stars: .stargazers_count, language: .language, url: .html_url}`,
      ],
      { encoding: "utf-8", timeout: 30_000 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg }, "GitHub API fetch failed");
    return "";
  }
}

// ============================================
// MAIN
// ============================================

export async function runIdeasExplore(db?: Database.Database): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  if (!db) {
    return { success: false, output: "", error: "Database required for scrape store" };
  }

  try {
    const existingIdeas = ideaDao.getAllIdeas(db);
    const existingUrls = new Set(existingIdeas.map((i) => i.link).filter(Boolean));
    const denyHistory = loadFileIfExists(DENY_HISTORY);

    const [goals, projects] = await Promise.all([
      extractCurrentGoals(),
      extractActiveProjects(),
    ]);

    // Step 1: Deterministic fetch — code gathers data
    const rawRepos = fetchTrendingRepos();
    if (!rawRepos.trim()) {
      return { success: false, output: "", error: "GitHub API returned no results" };
    }

    // Step 2: Sonnet filters for relevance — LLM makes decisions
    const filterPrompt = `You are filtering GitHub trending repos for relevance to Yanqing's work.

## Repos fetched from GitHub (last 7 days, sorted by stars)
${rawRepos.slice(0, 20_000)}

## Filter criteria — keep repos related to Yanqing's CURRENT active focus
(Use the Active Goals + Active Projects lists below as the authoritative filter. Anything listed under "Paused" is context-only — do NOT prioritize repos for paused projects unless they directly support an active priority.)

## Yanqing's Active Goals
${goals.slice(0, 1500)}

## Yanqing's Active Projects
${projects.slice(0, 1000)}

## Deny History (skip these)
${denyHistory.slice(0, 3000)}

## Output
Return ONLY a JSON array of repos worth tracking. For each, add a "relevance" field explaining why it matters.
Format: [{"name": "owner/repo", "url": "https://github.com/...", "description": "...", "stars": 1234, "language": "TypeScript", "relevance": "connects to X because..."}]
If nothing relevant, return: []`;

    const result = await executeClaudeCommand(filterPrompt, {
      cwd: process.env.HOME ?? "/Users/yj",
      model: "sonnet",
      timeout: 180_000,
    });

    if (result.exitCode !== 0 || !result.output) {
      return { success: false, output: "", error: `Sonnet filter failed: exit ${result.exitCode}` };
    }

    let repos: z.infer<typeof ReposArraySchema>;
    try {
      repos = parseSwarmJSON(result.output, ReposArraySchema);
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      logger.error({ error: msg }, "Failed to parse GitHub trending output");
      return { success: false, output: "", error: `Parse failed: ${msg}` };
    }

    // Step 3: Write to scrapes table — code executes
    let inserted = 0;
    for (const repo of repos) {
      if (existingUrls.has(repo.url)) continue;

      const scrapeInserted = insertScrape(db, {
        id: `gh_${Date.now()}_${repo.name.replace(/[^a-z0-9]/gi, "_").slice(0, 30)}`,
        source: "github-trending",
        url: repo.url,
        title: repo.name,
        raw_content: `${repo.description}\n\nRelevance: ${repo.relevance}`,
        metadata: JSON.stringify({ stars: repo.stars, language: repo.language }),
      });
      if (scrapeInserted) inserted++;
    }

    const output = `GitHub trending: ${repos.length} found, ${inserted} new scrapes stored`;
    return { success: true, output };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Ideas explore failed");
    return { success: false, output: "", error: msg };
  }
}
