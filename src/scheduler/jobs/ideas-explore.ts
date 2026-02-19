/**
 * Ideas Explore — Multi-model swarm job
 *
 * Replaces the Claude-based ideas-explore scheduler job.
 * Uses Gemini Flash + agent-browser (bookmark scraping),
 * Kimi (bookmark analysis), OpenCode Flash (GitHub trending),
 * consolidated via Gemini Flash API.
 *
 * Pre-swarm: agent-browser scrape bookmarks + load existing ideas for dedup.
 * Post-consolidation: write idea files, log results.
 */

import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { z } from "zod";
import type Database from "better-sqlite3";
import { fanOutAgents, consolidateResults, parseSwarmJSON } from "../../executors/model-swarm.js";
import { executeOpenCodeCLI } from "../../executors/opencode-cli.js";
import { buildBookmarkScrapePrompt, SCRAPE_OPTIONS } from "../../scraping/browser-prompts.js";
import { loadIdeasFromDir, type ParsedIdea } from "../../ideas/parser.js";
import { smartSaveIdea, type SmartSaveResult } from "../../ideas/smart-save.js";
import { buildCondensedContext, extractCurrentGoals, extractActiveProjects } from "../shared-context.js";
import { formatForPrompt as getPreferenceContext } from "../../preferences/engine.js";
import { getRecentJobOutputs } from "../job-outputs.js";
import { logger } from "../../utils/logger.js";
import { OPUS_COPILOT_MODEL } from "../../models.js";

const MEMORY_PATH = "/Users/yj/memory";
const ME_MD = `${MEMORY_PATH}/me.md`;
const WORK_MD = `${MEMORY_PATH}/work.md`;
const DENY_HISTORY = `${MEMORY_PATH}/deny-history.md`;

// ============================================
// SCHEMAS
// ============================================

const IdeaSchema = z.object({
  title: z.string().min(5),
  content: z.string().min(20),
  source: z.enum(["bookmark", "github-trending", "openclaw"]),
  context: z.string(),
  link: z.string().url().or(z.literal("")),
});

const IdeasArraySchema = z.array(IdeaSchema);

// ============================================
// PRE-SWARM: Browser-based bookmark scraping
// ============================================

async function scrapeBookmarksViaBrowser(): Promise<string> {
  try {
    const result = await executeOpenCodeCLI(
      buildBookmarkScrapePrompt(30),
      "",
      SCRAPE_OPTIONS,
    );

    if (result.exitCode !== 0) {
      logger.warn({ exitCode: result.exitCode, output: result.output?.slice(0, 300) }, "Browser bookmark scrape failed");
      return "[]";
    }

    // Try to extract JSON array from output
    const output = result.output ?? "";
    const arrayMatch = output.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      // Validate it's parseable JSON
      try {
        JSON.parse(arrayMatch[0]);
        return arrayMatch[0];
      } catch {
        logger.warn({ preview: output.slice(0, 300) }, "Browser bookmark output not valid JSON");
        return "[]";
      }
    }

    logger.warn({ outputLen: output.length }, "No JSON array found in browser bookmark output");
    return "[]";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg }, "Browser bookmark scrape error");
    return "[]";
  }
}

function loadFileIfExists(path: string): string {
  if (!existsSync(path)) return "(file not found)";
  return readFileSync(path, "utf-8");
}

function buildExistingIdeasContext(ideas: ParsedIdea[]): string {
  const entries = ideas.slice(0, 100).map((i) => {
    const parts = [i.title];
    if (i.link) parts.push(i.link);
    return `- ${parts.join(" | ")}`;
  });
  return entries.join("\n");
}

// ============================================
// MAIN
// ============================================

export async function runIdeasExplore(db?: Database.Database): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  try {
    // Pre-swarm: gather data deterministically
    const [bookmarksJson, existingIdeas] = await Promise.all([
      scrapeBookmarksViaBrowser(),
      Promise.resolve(loadIdeasFromDir()),
    ]);

    const denyHistory = loadFileIfExists(DENY_HISTORY);
    const existingIdeasList = buildExistingIdeasContext(existingIdeas);
    const existingUrls = new Set(existingIdeas.map((i) => i.link).filter(Boolean));

    // Build personalized context using shared-context helpers
    const [condensedContext, goals, projects] = await Promise.all([
      buildCondensedContext(),
      extractCurrentGoals(),
      extractActiveProjects(),
    ]);

    // Full context for agents (me.md + work.md with generous limits)
    const meContext = loadFileIfExists(ME_MD);
    const workContext = loadFileIfExists(WORK_MD);
    const goalContext = `## Yanqing's Identity & Goals\n\n${meContext.slice(0, 8000)}\n\n## Work Context\n\n${workContext.slice(0, 6000)}`;

    // Load HOMER's bot command list for competitive comparison
    let homerCapabilities = "";
    try {
      homerCapabilities = execSync(
        "grep -E '(bot\\.command|case \"|handler)' /Users/yj/homer/src/bot/index.ts 2>/dev/null | head -30",
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
    } catch {
      homerCapabilities = "(could not load HOMER capabilities)";
    }

    // Check if bookmarks are empty — adjust Kimi agent accordingly
    let bookmarksEmpty = false;
    try {
      const parsed = JSON.parse(bookmarksJson);
      bookmarksEmpty = !Array.isArray(parsed) || parsed.length === 0;
    } catch { bookmarksEmpty = true; }

    // Swarm: 2 agents — Flash (discovery) + Opus (gap analysis)
    const agents = [];

    // Agent 1: Flash — bookmark analysis + GitHub trending (merged)
    const discoveryParts: string[] = [];
    if (!bookmarksEmpty) {
      discoveryParts.push(`## Part 1: Twitter/X Bookmark Analysis

Analyze these bookmarks and explain WHY Yanqing likely bookmarked each.
For each bookmark with an external URL, use web search to analyze the linked content.

For each bookmark, provide:
1. The bookmark text and author
2. Any external URL found
3. A 2-3 sentence analysis of WHY this was bookmarked (connect to Yanqing's active projects and goals)
4. Key themes and tags

### Bookmarks JSON
${bookmarksJson}`);
    }

    discoveryParts.push(`## ${bookmarksEmpty ? "Part 1" : "Part 2"}: GitHub Trending Repos

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

For each relevant repo, provide:
1. Repo name and URL
2. What it does (1-2 sentences)
3. Which of Yanqing's projects it connects to

### Deny History (skip these)
${denyHistory.slice(0, 3000)}`);

    agents.push({
      id: "flash-discover",
      executor: "opencode" as const,
      prompt: `You are a discovery agent. Complete ALL parts below sequentially.

## Yanqing's Active Goals
${goals.slice(0, 1500)}

## Yanqing's Active Projects
${projects.slice(0, 1000)}

${discoveryParts.join("\n\n---\n\n")}`,
      context: goalContext,
      timeout: 300_000,
      required: true,
    });

    // Agent 2: Opus 4.6 via OpenCode — deep competitive gap analysis
    agents.push({
      id: "opus-gap-analysis",
      executor: "opencode" as const,
      model: OPUS_COPILOT_MODEL,
      prompt: `Perform a deep competitive analysis of personal AI assistant projects on GitHub. Identify features and patterns that HOMER doesn't have but should.

Steps:
1. Search for similar projects: gh api /search/repositories -f q="personal AI assistant telegram bot" --jq '.items[:5] | .[] | {name: .full_name, desc: .description, url: .html_url, stars: .stargazers_count}'
2. Also search: gh api /search/repositories -f q="AI agent memory orchestration" --jq '.items[:5] | .[] | {name: .full_name, desc: .description, url: .html_url, stars: .stargazers_count}'
3. For the top 2-3 most relevant repos, fetch their READMEs: gh api repos/OWNER/REPO/readme -H "Accept: application/vnd.github.raw"
4. Analyze feature gaps compared to HOMER

## HOMER's Current Capabilities
${homerCapabilities}

## Yanqing's Priorities
${goals.slice(0, 1000)}

For each feature gap provide: feature name, what it enables, benefit to Yanqing, implementation complexity (low/med/high), and which of Yanqing's projects it connects to.

Focus on genuinely useful gaps — not cosmetic differences. Quality over quantity.`,
      context: goalContext,
      timeout: 600_000, // 10 min — Opus is slower
      required: false,
    });

    const results = await fanOutAgents(agents);

    // Cross-job intelligence: inject recent outputs if db available
    const recentActivity = db ? getRecentJobOutputs(db) : "";

    // Consolidation — with personal context for accurate filtering
    const consolidationPrompt = `You are a consolidation engine. Merge the agent results below into a final list of idea candidates.

## Who is Yanqing (for context)

${condensedContext.slice(0, 2500)}

## Instructions

1. **Dedup against existing ideas** — skip anything that matches by URL or has Jaccard title similarity >= 0.8 with existing ideas.
2. **Pick top 3 most relevant candidates.** Drop anything that doesn't connect to Yanqing's active goals/projects.
3. For bookmarks: set source="bookmark"
4. For GitHub repos: set source="github-trending"
5. For OpenClaw competitive intel: set source="openclaw" — weight toward Homer enhancement

## Existing Ideas (skip duplicates)

${existingIdeasList.slice(0, 4000)}
${recentActivity ? `\n${recentActivity}\n` : ""}
## Output Format

Return ONLY a JSON array:
[{"title": "...", "content": "...", "source": "bookmark"|"github-trending"|"openclaw", "context": "why this matters for Yanqing specifically", "link": "https://..."}]

If no candidates pass the threshold, return an empty array: []`;

    // Inject preference context if available
    let preferenceContext = "";
    try {
      const Database = (await import("better-sqlite3")).default;
      const prefDb = new Database("/Users/yj/homer/data/homer.db", { readonly: true });
      preferenceContext = getPreferenceContext(prefDb);
      prefDb.close();
    } catch { /* preference model may not exist yet */ }

    const consolidated = await consolidateResults(results, consolidationPrompt, {
      temperature: 0.2,
      preferenceContext,
    });

    // Parse and validate
    let ideas: z.infer<typeof IdeasArraySchema>;
    try {
      ideas = parseSwarmJSON(consolidated, IdeasArraySchema);
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      logger.error({ error: msg }, "Failed to parse consolidated ideas");
      return { success: false, output: "", error: `Consolidation parse failed: ${msg}` };
    }

    // Filter out any that still match existing URLs (skip empty links from openclaw)
    const filtered = ideas.filter((idea) => !idea.link || !existingUrls.has(idea.link));

    // Write idea files via smart-save (dedup-at-write)
    const now = new Date();
    const timestamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;
    const saveResults: SmartSaveResult[] = [];

    for (const idea of filtered) {
      const slug = idea.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);
      const id = `explore_${now.toISOString().slice(5, 10).replace("-", "")}_${slug}`;

      const parsed: ParsedIdea = {
        id,
        title: idea.title,
        status: "draft",
        source: idea.source,
        content: idea.content,
        context: idea.context,
        link: idea.link,
        tags: [idea.source, "swarm-explore"],
        timestamp,
      };

      const result = smartSaveIdea(parsed);
      saveResults.push(result);
      logger.info({ id, title: idea.title, action: result.action }, "Swarm explore idea processed");
    }

    const created = saveResults.filter((r) => r.action === "created").length;
    const enhanced = saveResults.filter((r) => r.action === "enhanced").length;
    const skipped = saveResults.filter((r) => r.action === "skipped").length;
    const agentCount = results.filter((r) => r.success).length;

    const parts: string[] = [`${agentCount} agents`];
    if (created > 0) parts.push(`${created} new ideas`);
    if (enhanced > 0) parts.push(`${enhanced} enhanced`);
    if (skipped > 0) parts.push(`${skipped} skipped (duplicate)`);
    if (created === 0 && enhanced === 0) parts.push("no new ideas");
    parts.push(`from ${ideas.length} candidates`);
    const output = `Explored ${parts.join(", ")}`;

    return { success: true, output };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Ideas explore failed");
    return { success: false, output: "", error: msg };
  }
}
