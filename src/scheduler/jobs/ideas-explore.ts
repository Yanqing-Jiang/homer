/**
 * Ideas Explore — GitHub Trending Scraper
 *
 * Scrapes GitHub trending repos and writes to the scrapes table.
 * X bookmark scraping has been moved to idea-ingest (single source of truth).
 * The idea-synthesizer reads from scrapes and creates ideas.
 *
 * Schedule: 30 0 * * * (daily at 00:30, also triggered by idea-ingest)
 */

import { readFileSync, existsSync } from "fs";
import { z } from "zod";
import type Database from "better-sqlite3";
import { executeOpenCodeCLI } from "../../executors/opencode-cli.js";
import { parseSwarmJSON } from "../../executors/model-swarm.js";
import { loadIdeasFromDir } from "../../ideas/parser.js";
import { insertScrape } from "../../scraping/scrape-store.js";
import { extractCurrentGoals, extractActiveProjects } from "../shared-context.js";
import { logger } from "../../utils/logger.js";
import { OPUS_COPILOT_MODEL } from "../../models.js";

const MEMORY_PATH = "/Users/yj/memory";
const DENY_HISTORY = `${MEMORY_PATH}/deny-history.md`;

// ============================================
// SCHEMAS
// ============================================

const RepoSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  description: z.string(),
  stars: z.number().optional(),
  language: z.string().optional(),
  relevance: z.string(), // why this matters to Yanqing
});

const ReposArraySchema = z.array(RepoSchema);

function loadFileIfExists(path: string): string {
  if (!existsSync(path)) return "(file not found)";
  return readFileSync(path, "utf-8");
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
    const existingIdeas = loadIdeasFromDir();
    const existingUrls = new Set(existingIdeas.map((i) => i.link).filter(Boolean));
    const denyHistory = loadFileIfExists(DENY_HISTORY);

    const [goals, projects] = await Promise.all([
      extractCurrentGoals(),
      extractActiveProjects(),
    ]);

    // Single Flash agent — GitHub trending discovery
    const discoveryPrompt = `You are a GitHub trending discovery agent.

Search GitHub trending repositories from the last 7 days that match Yanqing's interests.

Use this command to find trending repos:
gh api /search/repositories -f q='created:>${new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)} stars:>100' -f sort=stars --jq '.items[:15] | .[] | {name: .full_name, description: .description, stars: .stargazers_count, language: .language, url: .html_url}'

Filter criteria — MATCH repos related to Yanqing's active projects:
- Quant trading, algorithmic finance, IBKR integration (MAHORAGA project)
- Resume optimization, job search automation, career tools (Career OS)
- Data pipelines, DuckDB, Parquet, analytics dashboards (Work Analytics)
- Personal AI agents, memory systems, orchestration (Homer)
- Content creation tools, LinkedIn/Medium automation (Frontend-Slides)
- General: AI/ML, TypeScript/Python CLI tools, personal automation

AVOID: gaming, mobile-only, frontend-only frameworks, anything in deny history.

## Yanqing's Active Goals
${goals.slice(0, 1500)}

## Yanqing's Active Projects
${projects.slice(0, 1000)}

## Deny History (skip these)
${denyHistory.slice(0, 3000)}

## Output Format
Return ONLY a JSON array (no markdown, no commentary):
[{"name": "owner/repo", "url": "https://github.com/...", "description": "what it does", "stars": 1234, "language": "TypeScript", "relevance": "connects to Yanqing's X project because..."}]

If nothing relevant, return: []`;

    const flashResult = await executeOpenCodeCLI(discoveryPrompt, "", {
      model: "google/gemini-3-flash-preview",
      timeout: 180_000,
      researchOnly: true,
    });

    if (flashResult.exitCode !== 0 || !flashResult.output) {
      return { success: false, output: "", error: `GitHub discovery failed: exit ${flashResult.exitCode}` };
    }

    // Also run Opus competitive gap analysis (non-blocking)
    let gapAnalysisInserted = 0;
    const opusPromise = (async () => {
      try {
        const opusResult = await executeOpenCodeCLI(
          `Perform a focused competitive analysis: search GitHub for 3-5 personal AI assistant projects similar to Homer. For each, fetch its README and identify 1-2 feature gaps Homer doesn't have. Return ONLY a JSON array:
[{"name": "owner/repo", "url": "https://github.com/...", "description": "feature gap description", "relevance": "why Homer should have this"}]

Steps:
1. gh api /search/repositories -f q="personal AI assistant telegram bot" --jq '.items[:5] | .[] | {name: .full_name, url: .html_url}'
2. For top 3, fetch README: gh api repos/OWNER/REPO/readme -H "Accept: application/vnd.github.raw"
3. Identify actionable feature gaps`,
          "",
          {
            model: OPUS_COPILOT_MODEL,
            timeout: 300_000,
            researchOnly: true,
          },
        );

        if (opusResult.exitCode === 0 && opusResult.output) {
          try {
            const gaps = parseSwarmJSON(opusResult.output, ReposArraySchema);
            for (const gap of gaps) {
              if (!existingUrls.has(gap.url)) {
                const inserted = insertScrape(db, {
                  id: `gap_${Date.now()}_${gap.name.replace(/[^a-z0-9]/gi, "_").slice(0, 20)}`,
                  source: "github-gap-analysis",
                  url: gap.url,
                  title: `Gap: ${gap.name} — ${gap.description.slice(0, 60)}`,
                  raw_content: `${gap.description}\n\nRelevance: ${gap.relevance}`,
                  metadata: JSON.stringify({ stars: gap.stars, language: gap.language }),
                });
                if (inserted) gapAnalysisInserted++;
              }
            }
          } catch {
            // Parse failure is OK — gap analysis is best-effort
          }
        }
      } catch {
        // Opus failure is non-blocking
      }
    })();

    // Parse Flash results
    let repos: z.infer<typeof ReposArraySchema>;
    try {
      repos = parseSwarmJSON(flashResult.output, ReposArraySchema);
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      logger.error({ error: msg }, "Failed to parse GitHub trending output");
      return { success: false, output: "", error: `Parse failed: ${msg}` };
    }

    // Filter duplicates and write to scrapes table
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

    // Wait for Opus gap analysis to complete
    await opusPromise;

    const output = `GitHub trending: ${repos.length} found, ${inserted} new scrapes stored${gapAnalysisInserted > 0 ? `, ${gapAnalysisInserted} gap analysis scrapes` : ""}`;
    return { success: true, output };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Ideas explore failed");
    return { success: false, output: "", error: msg };
  }
}
