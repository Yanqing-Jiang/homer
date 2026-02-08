/**
 * Ideas Explore — Multi-model swarm job
 *
 * Replaces the Claude-based ideas-explore scheduler job.
 * Uses Kimi (bookmark analysis) + OpenCode Flash (GitHub trending),
 * consolidated via Gemini Flash API.
 *
 * Pre-swarm: bird CLI scrape + load existing ideas for dedup.
 * Post-consolidation: write idea files, log results.
 */

import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { z } from "zod";
import { fanOutAgents, consolidateResults, parseSwarmJSON } from "../../executors/model-swarm.js";
import { loadIdeasFromDir, saveIdeaFile, type ParsedIdea } from "../../ideas/parser.js";
import { buildCondensedContext, extractCurrentGoals, extractActiveProjects } from "../shared-context.js";
import { logger } from "../../utils/logger.js";

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
  source: z.enum(["bookmark", "github-trending"]),
  context: z.string(),
  link: z.string().url(),
  score: z.number().min(0).max(50),
});

const IdeasArraySchema = z.array(IdeaSchema);

// ============================================
// PRE-SWARM: Bird CLI scrape
// ============================================

async function scrapeBookmarks(): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn("bird", ["bookmarks", "-n", "30", "--json"], {
      timeout: 60_000,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (code) => {
      if (code === 0 && stdout.length > 10) {
        resolve(stdout);
      } else {
        logger.warn({ code, stderr: stderr.slice(0, 300) }, "Bird CLI bookmark scrape failed");
        resolve("[]");
      }
    });

    proc.on("error", (err) => {
      logger.warn({ error: err.message }, "Bird CLI spawn error");
      resolve("[]");
    });
  });
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

export async function runIdeasExplore(): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  try {
    // Pre-swarm: gather data deterministically
    const [bookmarksJson, existingIdeas] = await Promise.all([
      scrapeBookmarks(),
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

    // Check if bookmarks are empty — adjust Kimi agent accordingly
    let bookmarksEmpty = false;
    try {
      const parsed = JSON.parse(bookmarksJson);
      bookmarksEmpty = !Array.isArray(parsed) || parsed.length === 0;
    } catch { bookmarksEmpty = true; }

    // Swarm: parallel execution
    const agents = [];

    if (!bookmarksEmpty) {
      agents.push({
        id: "kimi-analyze",
        executor: "kimi" as const,
        prompt: `Analyze these Twitter/X bookmarks and explain WHY Yanqing likely bookmarked each.

For each bookmark with an external URL, fetch and analyze the linked content using your FetchURL tool.

For each bookmark, provide:
1. The bookmark text and author
2. Any external URL found
3. A 2-3 sentence analysis of WHY this was bookmarked (connect to Yanqing's specific active projects and goals below)
4. Key themes and tags

## Yanqing's Active Goals
${goals.slice(0, 1500)}

## Yanqing's Active Projects
${projects.slice(0, 1000)}

## Bookmarks JSON

${bookmarksJson}`,
        context: goalContext,
        timeout: 300_000,
        required: true,
      });
    }

    agents.push({
      id: "flash-github",
      executor: "opencode" as const,
      prompt: `Search GitHub trending repositories from the last 7 days that match Yanqing's interests.

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
4. Relevance score (0-50)

## Deny History (skip these)

${denyHistory.slice(0, 3000)}`,
      context: goalContext,
      timeout: 300_000,
      required: !bookmarksEmpty ? false : true,
    });

    const results = await fanOutAgents(agents);

    // Consolidation — with personal context for accurate scoring
    const consolidationPrompt = `You are a consolidation engine. Merge the agent results below into a final list of idea candidates.

## Who is Yanqing (for scoring context)

${condensedContext.slice(0, 2500)}

## Instructions

1. **Dedup against existing ideas** — skip anything that matches by URL or has Jaccard title similarity >= 0.8 with existing ideas.
2. **Score each candidate** against Yanqing's SPECIFIC goals and projects (0-50 scale):
   - Career relevance: 0-15 (job hunt, B3/Director positioning, tech switch)
   - Homer/automation value: 0-15 (personal AI, memory, scheduling)
   - Income potential: 0-10 (trading, SaaS, content monetization)
   - Learning value: 0-10 (new skills, architecture patterns)
3. **Pick top 3** with score >= 15.
4. For bookmarks: set source="bookmark"
5. For GitHub repos: set source="github-trending"

## Existing Ideas (skip duplicates)

${existingIdeasList.slice(0, 4000)}

## Output Format

Return ONLY a JSON array:
[{"title": "...", "content": "...", "source": "bookmark"|"github-trending", "context": "why this matters for Yanqing specifically", "link": "https://...", "score": 25}]

If no candidates pass the threshold, return an empty array: []`;

    const consolidated = await consolidateResults(results, consolidationPrompt, {
      temperature: 0.2,
      maxTokens: 4096,
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

    // Filter out any that still match existing URLs
    const filtered = ideas.filter((idea) => !existingUrls.has(idea.link));

    // Write idea files
    const now = new Date();
    const timestamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;
    let written = 0;

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

      saveIdeaFile(parsed);
      written++;
      logger.info({ id, title: idea.title, score: idea.score }, "Wrote idea from swarm explore");
    }

    const output = written > 0
      ? `Explored ${results.filter((r) => r.success).length} agents, wrote ${written} ideas (${filtered.length} passed filters from ${ideas.length} candidates)`
      : `Explored ${results.filter((r) => r.success).length} agents, no new ideas passed thresholds (${ideas.length} candidates)`;

    return { success: true, output };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Ideas explore failed");
    return { success: false, output: "", error: msg };
  }
}
