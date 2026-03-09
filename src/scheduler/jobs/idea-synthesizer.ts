/**
 * Idea Synthesizer — The Brain
 *
 * 2-pass architecture:
 *   Pass 1: Per-source scoring via Gemini Flash (3x parallel)
 *   Pass 2: Cross-source synthesis via Gemini 3.1 Pro API
 *   Post: Quality gate → smartSaveIdea() with provenance
 *
 * Reads unprocessed scrapes from the scrapes table.
 * Creates high-quality, goal-aligned ideas with provenance tracking.
 *
 * Schedule: 0 1 * * * (daily at 1am, triggered by idea-ingest/ideas-explore/content-scraper)
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import type Database from "better-sqlite3";
import { executeGeminiCLIDirect, GEMINI_CLI_PRO_MODEL } from "../../executors/gemini-cli.js";
import { parseSwarmJSON } from "../../executors/model-swarm.js";
import { getUnprocessedScrapes, markProcessed, type StoredScrape } from "../../scraping/scrape-store.js";
import type { ParsedIdea } from "../../ideas/parser.js";
import * as ideaDao from "../../ideas/dao.js";
import { smartSaveIdea, type SmartSaveResult } from "../../ideas/smart-save.js";
import { formatForPrompt as getPreferenceContext } from "../../preferences/engine.js";
import { buildCondensedContext } from "../shared-context.js";
import { logger } from "../../utils/logger.js";
import { storeJobArtifact } from "./artifact-store.js";
import { PATHS } from "../../config/paths.js";

const ME_MD = PATHS.me;
const WORK_MD = PATHS.work;
const DENY_HISTORY = PATHS.denyHistory;

// ============================================
// SCHEMAS
// ============================================

const ScoredSummarySchema = z.object({
  scrapeId: z.string(),
  score: z.number().min(0).max(10),
  summary: z.string().min(10),
  dimensions: z.array(z.string()),
});

const ScoredArraySchema = z.array(ScoredSummarySchema);

const SynthesizedIdeaSchema = z.object({
  title: z.string().min(10).max(120),
  content: z.string().min(100),
  source: z.string(),
  link: z.string().url().or(z.literal("")),
  tags: z.array(z.string()),
  relevance: z.string(),
  confidenceScore: z.number().min(0).max(1),
  scrapeIds: z.array(z.string()),
});

const SynthesisOutputSchema = z.object({
  ideas: z.array(SynthesizedIdeaSchema),
  stats: z.object({
    candidatesGenerated: z.number().optional(),
    candidatesFiltered: z.number().optional(),
  }).optional(),
});

// ============================================
// HELPERS
// ============================================

function loadFileIfExists(path: string, maxChars?: number): string {
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf-8");
  return maxChars ? content.slice(0, maxChars) : content;
}

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item);
    if (!groups[k]) groups[k] = [];
    groups[k]!.push(item);
  }
  return groups;
}

function formatScrapesForPrompt(scrapes: StoredScrape[]): string {
  return scrapes.map((s, i) => {
    const meta = s.metadata ? JSON.parse(s.metadata) : {};
    return `### [${i + 1}] ${s.title || "(no title)"} (ID: ${s.id})
Source: ${s.source} | URL: ${s.url || "N/A"} | Author: ${s.author || "N/A"}
${meta.stars ? `Stars: ${meta.stars} | ` : ""}${meta.language ? `Language: ${meta.language} | ` : ""}${meta.topic ? `Topic: ${meta.topic}` : ""}

${(s.raw_content || "").slice(0, 2000)}
`;
  }).join("\n---\n");
}

/**
 * Load .md files modified in the last N days from output/plan dirs.
 * Returns a single concatenated string, truncated to maxTotalChars.
 * Files are sorted newest-first, each capped at perFileCap chars.
 */
function loadRecentMdFiles(maxDays = 7, maxTotalChars = 6000, perFileCap = 800): string {
  const home = process.env.HOME ?? "/Users/yj";
  const searchDirs = [
    join(home, "homer", "output", "claude"),
    join(home, "homer", "output", "codex"),
    join(home, "homer", "output", "gemini"),
    join(home, "homer", "output", "opus"),
    join(home, "homer", "output", "kimi"),
    join(home, "homer", "output", "swarm"),
    PATHS.plans,
  ];

  const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
  const entries: { path: string; mtime: number }[] = [];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".md")) continue;
        const full = join(dir, name);
        try {
          const st = statSync(full);
          if (st.mtimeMs >= cutoff) entries.push({ path: full, mtime: st.mtimeMs });
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip unreadable dir */ }
  }

  entries.sort((a, b) => b.mtime - a.mtime);

  const parts: string[] = [];
  let total = 0;

  for (const { path } of entries) {
    if (total >= maxTotalChars) break;
    try {
      const raw = readFileSync(path, "utf-8").slice(0, perFileCap);
      const name = path.split("/").slice(-2).join("/");
      const snippet = `### ${name}\n${raw}`;
      parts.push(snippet);
      total += snippet.length;
    } catch { /* skip */ }
  }

  return parts.join("\n\n---\n\n");
}

/**
 * Digest recent .md outputs into a compact summary via a single Gemini Flash session.
 * Keeps each enrichment Pro session's context small — raw files stay out of N parallel calls.
 * Returns a ~1.5KB digest string, or raw content (truncated) on failure.
 */
async function digestRecentOutputs(rawContent: string): Promise<string> {
  if (!rawContent || rawContent.trim().length < 100) return "(no recent outputs)";

  const prompt = `You are summarizing recent agent work for Yanqing's idea pipeline.

Read the following output files from the past 7 days and produce a compact digest (max 1500 chars).

Extract:
- What projects/tasks were worked on (1 line each)
- Key findings or decisions made (bullet points)
- Open gaps or next steps explicitly mentioned
- Any patterns that suggest unmet needs or missed opportunities

Be terse. This digest will be injected into multiple enrichment prompts, so dense > verbose.

## Recent Output Files
${rawContent}

Return plain text only. No headers, no markdown fences.`;

  try {
    const result = await executeGeminiCLIDirect(
      prompt,
      { timeout: 90_000 }, // Flash default
    );
    if (result.exitCode === 0 && result.output?.trim()) {
      return result.output.trim().slice(0, 1800);
    }
  } catch { /* fall through */ }

  // Fallback: return raw truncated content
  return rawContent.slice(0, 1800);
}

// ============================================
// PASS 1: Per-Source Scoring (Flash, parallel)
// ============================================

async function scoreSourceScrapes(
  scrapes: StoredScrape[],
  sourceName: string,
  preferences: string,
  goals: string,
): Promise<z.infer<typeof ScoredArraySchema>> {
  if (scrapes.length === 0) return [];

  const prompt = `You are a relevance scorer for Yanqing's idea pipeline.
Score each scraped item 0-10 based on relevance to Yanqing's goals and interests.
Extract a 2-3 sentence summary for each (compress to essentials).
Tag with preference dimensions (e.g., "topic:ai-agents", "source:github").

## Yanqing's Goals
${goals.slice(0, 2000)}

## Learned Preferences
${preferences || "(no preferences yet)"}

## Scraped Items (${sourceName})
${formatScrapesForPrompt(scrapes)}

## Scoring Criteria
- 8-10: Directly connects to an active project or stated goal
- 5-7: Relevant to interests but not immediately actionable
- 3-4: Tangentially related, might be useful later
- 0-2: Off-topic or low quality

## Output
Return ONLY a JSON array (no markdown):
[{"scrapeId": "...", "score": 7, "summary": "...", "dimensions": ["topic:X", "source:Y"]}]`;

  try {
    const result = await executeGeminiCLIDirect(
      prompt + "\n\nReturn ONLY a valid JSON array, no markdown fences.",
      { timeout: 120_000 },
    );

    if (result.exitCode !== 0 || !result.output) {
      logger.warn({ source: sourceName, exitCode: result.exitCode }, "Flash scoring failed");
      return [];
    }

    return parseSwarmJSON(result.output, ScoredArraySchema);
  } catch (err) {
    logger.warn({ error: err, source: sourceName }, "Flash scoring parse failed");
    return [];
  }
}

// ============================================
// PASS 2: Cross-Source Synthesis (Pro 3.1 API)
// ============================================

async function synthesizeIdeas(
  scoredSummaries: z.infer<typeof ScoredArraySchema>,
  context: {
    condensedContext: string;
    preferences: string;
    denyHistory: string;
    existingTitles: string;
  },
): Promise<z.infer<typeof SynthesisOutputSchema>> {
  const topSummaries = scoredSummaries
    .filter(s => s.score >= 5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30); // Cap at 30 for context window

  if (topSummaries.length === 0) {
    return { ideas: [], stats: { candidatesGenerated: 0, candidatesFiltered: scoredSummaries.length } };
  }

  const summariesText = topSummaries.map((s, i) =>
    `[${i + 1}] (score: ${s.score}, id: ${s.scrapeId}) ${s.summary}\n  Dims: ${s.dimensions.join(", ")}`
  ).join("\n\n");

  const prompt = `You are Homer's idea curator. Synthesize the scored content below into 3-8 high-quality idea candidates for Yanqing.

## 1. Yanqing's Goals & Context
${context.condensedContext.slice(0, 5000)}

## 2. Learned Preferences
${context.preferences || "(no preferences yet)"}

## 3. Deny History (topics/patterns to avoid)
${context.denyHistory.slice(0, 3000)}

## 4. Existing Idea Titles (avoid duplicates)
${context.existingTitles.slice(0, 2000)}

## 5. Scored Content Summaries
${summariesText}

## Instructions
- Generate 3-8 synthesized ideas. Each idea may combine insights from multiple scrapes.
- Every idea MUST connect to one of Yanqing's active goals or projects.
- Title: specific and actionable (10-120 chars). No generic titles like "AI Tool" or "Interesting Repo".
- Content: 200+ chars explaining WHAT it is, WHY it matters to Yanqing, and WHAT he could do with it.
- Relevance: explicit connection to a specific project (Homer, MAHORAGA, Career OS, etc.)
- confidenceScore: 0-1, where 1 = perfect fit, 0.4 = marginal
- scrapeIds: which scrape(s) this idea draws from (provenance)
- Deduplicate against existing titles. Skip anything already covered.

## Output
Return ONLY a JSON object (no markdown):
{"ideas": [{"title": "...", "content": "...", "source": "x-bookmark|github-trending|medium-trending|github-gap-analysis", "link": "https://...", "tags": ["tag1"], "relevance": "why this matters", "confidenceScore": 0.8, "scrapeIds": ["id1", "id2"]}], "stats": {"candidatesGenerated": N, "candidatesFiltered": M}}`;

  try {
    // Gemini 3.1 Pro — no Claude Code tokens consumed
    const proResult = await executeGeminiCLIDirect(
      prompt + "\n\nReturn ONLY a valid JSON object, no markdown fences.",
      { model: GEMINI_CLI_PRO_MODEL, timeout: 180_000 },
    );

    if (proResult.exitCode === 0 && proResult.output) {
      return parseSwarmJSON(proResult.output, SynthesisOutputSchema);
    }

    logger.warn({ exitCode: proResult.exitCode }, "Pro synthesis failed, retrying");
    const retryResult = await executeGeminiCLIDirect(
      prompt + "\n\nReturn ONLY a valid JSON object, no markdown fences.",
      { model: GEMINI_CLI_PRO_MODEL, timeout: 300_000 },
    );

    if (retryResult.exitCode !== 0 || !retryResult.output) {
      return { ideas: [], stats: { candidatesGenerated: 0, candidatesFiltered: 0 } };
    }

    return parseSwarmJSON(retryResult.output, SynthesisOutputSchema);
  } catch (err) {
    logger.warn({ error: err }, "Synthesis parse failed");
    return { ideas: [], stats: { candidatesGenerated: 0, candidatesFiltered: 0 } };
  }
}

// ============================================
// FLASH CRITIC PASS
// ============================================

const CriticSchema = z.array(z.object({
  title: z.string(),
  novelty: z.number().min(0).max(10),
  goalAlignment: z.number().min(0).max(10),
  feasibility: z.number().min(0).max(10),
  keep: z.boolean(),
}));

async function criticReview(
  ideas: z.infer<typeof SynthesisOutputSchema>["ideas"],
): Promise<Set<string>> {
  if (ideas.length === 0) return new Set();

  const ideaList = ideas.map((idea, i) =>
    `[${i + 1}] "${idea.title}" (confidence: ${idea.confidenceScore})\n${idea.content.slice(0, 300)}`
  ).join("\n\n");

  const prompt = `You are a quality critic. Score each idea and decide if it should be kept.

Ideas:
${ideaList}

For each idea, score 0-10 on:
- novelty: Is this genuinely new/useful or generic?
- goalAlignment: Does it clearly connect to a specific project?
- feasibility: Can Yanqing act on this?

Keep an idea only if average score >= 7.

Return ONLY a JSON array:
[{"title": "...", "novelty": 8, "goalAlignment": 9, "feasibility": 7, "keep": true}]`;

  try {
    const result = await executeGeminiCLIDirect(
      prompt + "\n\nReturn ONLY a valid JSON array, no markdown fences.",
      { timeout: 60_000 },
    );

    if (result.exitCode !== 0 || !result.output) return new Set(ideas.map(i => i.title));

    const criticScores = parseSwarmJSON(result.output, CriticSchema);
    const keepTitles = new Set<string>();

    for (const score of criticScores) {
      if (score.keep) {
        keepTitles.add(score.title);
      } else {
        logger.info({
          title: score.title,
          novelty: score.novelty,
          goalAlignment: score.goalAlignment,
          feasibility: score.feasibility,
        }, "Critic filtered out idea");
      }
    }

    return keepTitles;
  } catch {
    // Critic failure is non-blocking — keep all ideas
    return new Set(ideas.map(i => i.title));
  }
}

// ============================================
// PASS 3: Idea Enrichment (Gemini Pro, parallel)
// ============================================

const EnrichmentSchema = z.object({
  deep_dive: z.object({
    core_claim: z.string(),
    evidence: z.string(),
    risks: z.array(z.string()).max(3),
    validation_path: z.string(),
  }),
  deep_links: z.array(z.object({
    target: z.string(),
    relationship: z.string(),
    strength: z.number().min(0).max(1),
  })).max(5),
  homer_improvement: z.object({
    relevant: z.boolean(),
    summary: z.string(),
    area: z.enum(["idea-pipeline", "morning-brief", "scheduler", "career-os", "mahoraga", "content-pipeline", "new-mcp", "none"]),
    priority: z.enum(["high", "medium", "low"]),
    user_context: z.string(),
    plan: z.array(z.object({
      step: z.number(),
      action: z.string(),
      file: z.string(),
      effort: z.enum(["S", "M", "L"]),
    })).max(5),
    automation_potential: z.string(),
  }),
});

type IdeaEnrichment = z.infer<typeof EnrichmentSchema>;

async function enrichIdea(
  idea: z.infer<typeof SynthesizedIdeaSchema>,
  context: {
    meMd: string;
    workMd: string;
    existingIdeaTitles: string;
    recentOutputs: string;
  },
): Promise<IdeaEnrichment | null> {
  const prompt = `You are Homer enriching one idea for Yanqing. Return ONLY a JSON object, no markdown.

## Yanqing's Profile (me.md)
${context.meMd.slice(0, 2500)}

## Active Work (work.md)
${context.workMd.slice(0, 2500)}

## Existing Idea Titles (for deep link matching)
${context.existingIdeaTitles.slice(0, 1500)}

## Recent Agent Outputs & Plans (last 7 days — check for overlapping work or reusable findings)
${context.recentOutputs || "(none)"}

## Homer Architecture
Subsystems: idea-pipeline, morning-brief, scheduler, career-os, mahoraga, content-pipeline, new-mcp
Available MCPs: notebooklm-mcp (notebooks, audio overviews, slides), gmail-mcp, elevenlabs-mcp, cloudflare-mcp
User subscriptions: 3x Google Pro (= 3 NotebookLM Pro sessions), ElevenLabs, Cloudflare Workers
Active projects: Homer Career OS (Stagehand browser agents), MAHORAGA (TQQQ/SQQQ trading), Shadow Data Pulse (DuckDB), PICE (2 posts/week content), ProfitSphere (chargeback prevention)

## Idea to Enrich
Title: ${idea.title}
Content: ${idea.content}
Source: ${idea.source}
Tags: ${idea.tags.join(", ")}
Relevance: ${idea.relevance}

## Output JSON Schema
{
  "deep_dive": {
    "core_claim": "What this idea is actually saying in 1-2 sentences",
    "evidence": "Concrete signals from the source that support it",
    "risks": ["Risk 1", "Risk 2"],
    "validation_path": "Single fastest way to test or apply this"
  },
  "deep_links": [
    {"target": "project or idea name", "relationship": "accelerates|enables|replaces|feeds into|conflicts with", "strength": 0.0-1.0}
  ],
  "homer_improvement": {
    "relevant": true,
    "summary": "One-line Homer action this idea suggests",
    "area": "idea-pipeline|morning-brief|scheduler|career-os|mahoraga|content-pipeline|new-mcp|none",
    "priority": "high|medium|low",
    "user_context": "Why this fits Yanqing specifically — subscriptions, goals, existing tools",
    "plan": [
      {"step": 1, "action": "specific action", "file": "src/path/file.ts or skill name", "effort": "S|M|L"}
    ],
    "automation_potential": "What Homer could do autonomously with this"
  }
}

Rules:
- homer_improvement.relevant = false if the idea has no Homer automation angle; set area="none" and leave plan empty
- high priority = directly unblocks an active project or adds revenue/career leverage within 1 week
- deep_links must reference real active projects or existing idea titles
- Check recent agent outputs — if similar work was already done, note it in deep_links with relationship="already explored"
- Be specific. Avoid vague statements like "could be useful"`;

  try {
    const result = await executeGeminiCLIDirect(
      prompt + "\n\nReturn ONLY a valid JSON object, no markdown fences.",
      { model: GEMINI_CLI_PRO_MODEL, timeout: 150_000 },
    );

    if (result.exitCode !== 0 || !result.output) {
      logger.warn({ title: idea.title }, "Enrichment Pro call failed");
      return null;
    }

    return parseSwarmJSON(result.output, EnrichmentSchema);
  } catch (err) {
    logger.warn({ error: err, title: idea.title }, "Enrichment parse failed");
    return null;
  }
}

// ============================================
// MAIN
// ============================================

export async function runIdeaSynthesizer(db: Database.Database, jobRunId?: number): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  try {
    // Load unprocessed scrapes from last 48 hours
    const unprocessed = getUnprocessedScrapes(db, 48);

    if (unprocessed.length === 0) {
      return { success: true, output: "No unprocessed scrapes to synthesize" };
    }

    logger.info({ count: unprocessed.length }, "Starting idea synthesis");

    // Load context
    const [condensedContext, preferences, existingIdeas] = await Promise.all([
      buildCondensedContext(),
      (async () => {
        try { return getPreferenceContext(db); }
        catch { return ""; }
      })(),
      Promise.resolve(ideaDao.getAllIdeas(db)),
    ]);

    const denyHistory = loadFileIfExists(DENY_HISTORY, 5000);
    const existingTitles = existingIdeas.slice(0, 100).map(i => i.title).join("\n");
    const goals = loadFileIfExists(ME_MD, 3000) + "\n" + loadFileIfExists(WORK_MD, 3000);

    // PASS 1: Per-source scoring (3x Flash, parallel)
    const bySource = groupBy(unprocessed, s => s.source);
    const sourceNames = Object.keys(bySource);

    logger.info({ sources: sourceNames, counts: sourceNames.map(s => bySource[s]!.length) }, "Pass 1: scoring by source");

    const scoringResults = await Promise.allSettled(
      sourceNames.map(source =>
        scoreSourceScrapes(bySource[source]!, source, preferences, goals)
      )
    );

    const allScored = scoringResults.flatMap((result, i) => {
      if (result.status === "fulfilled") return result.value;
      logger.warn({ source: sourceNames[i], error: result.reason }, "Source scoring failed");
      return [];
    });

    logger.info({ totalScored: allScored.length, aboveThreshold: allScored.filter(s => s.score >= 5).length }, "Pass 1 complete");

    // Store Pass 1 artifact
    if (jobRunId && allScored.length > 0) {
      storeJobArtifact(db, jobRunId, "idea-synthesizer", "pass1-scores", "json",
        JSON.stringify(allScored), { sourceCount: sourceNames.length, scoredCount: allScored.length });
    }

    if (allScored.length === 0) {
      // Mark all as processed even if scoring produced nothing
      for (const scrape of unprocessed) {
        markProcessed(db, scrape.id);
      }
      return { success: true, output: "All scrapes scored but none above threshold" };
    }

    // PASS 2: Cross-source synthesis (Pro 3.1 API)
    logger.info("Pass 2: cross-source synthesis via Gemini 3.1 Pro");

    const synthesisResult = await synthesizeIdeas(allScored, {
      condensedContext,
      preferences,
      denyHistory,
      existingTitles,
    });

    const { ideas: synthesizedIdeas, stats } = synthesisResult;

    logger.info({
      candidateCount: synthesizedIdeas.length,
      stats,
    }, "Pass 2 complete");

    // Store Pass 2 artifact
    if (jobRunId && synthesizedIdeas.length > 0) {
      storeJobArtifact(db, jobRunId, "idea-synthesizer", "pass2-candidates", "json",
        JSON.stringify(synthesizedIdeas), { candidateCount: synthesizedIdeas.length, stats });
    }

    if (synthesizedIdeas.length === 0) {
      // Mark all as processed
      for (const scrape of unprocessed) {
        markProcessed(db, scrape.id);
      }
      return { success: true, output: `Synthesis produced 0 ideas from ${unprocessed.length} scrapes (all filtered)` };
    }

    // CRITIC PASS: Flash quality check (free, fast)
    const keepTitles = await criticReview(synthesizedIdeas);

    // Store critic artifact
    if (jobRunId) {
      const criticData = synthesizedIdeas.map(i => ({
        title: i.title,
        kept: keepTitles.has(i.title),
        confidence: i.confidenceScore,
      }));
      storeJobArtifact(db, jobRunId, "idea-synthesizer", "critic-scores", "json",
        JSON.stringify(criticData), { kept: keepTitles.size, filtered: synthesizedIdeas.length - keepTitles.size });
    }

    // POST-SYNTHESIS: Quality gate + write
    const now = new Date();
    const timestamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;
    const saveResults: SmartSaveResult[] = [];

    // Filter to quality-passing ideas before enrichment
    const qualityIdeas = synthesizedIdeas.filter(idea => {
      if (idea.confidenceScore < 0.4) {
        logger.info({ title: idea.title, score: idea.confidenceScore }, "Below quality threshold");
        return false;
      }
      if (!keepTitles.has(idea.title)) {
        logger.info({ title: idea.title }, "Filtered by critic");
        return false;
      }
      return true;
    });

    // PASS 3: Enrichment — run all in parallel via Gemini Pro
    logger.info({ count: qualityIdeas.length }, "Pass 3: enrichment via Gemini Pro");

    // Pre-pass: digest recent .md files in one Flash session, then share the compact
    // digest across all parallel enrichment Pro sessions (keeps each session's context small)
    const recentMdRaw = loadRecentMdFiles(7, 8000, 1000);
    const recentDigest = await digestRecentOutputs(recentMdRaw);
    logger.info({ rawChars: recentMdRaw.length, digestChars: recentDigest.length }, "Recent outputs digested");

    const enrichmentContext = {
      meMd: loadFileIfExists(ME_MD, 2500),
      workMd: loadFileIfExists(WORK_MD, 2500),
      existingIdeaTitles: existingIdeas.slice(0, 80).map(i => `${i.title} [${(i.tags ?? []).join(",")}]`).join("\n"),
      recentOutputs: recentDigest,
    };

    const enrichmentResults = await Promise.allSettled(
      qualityIdeas.map(idea => enrichIdea(idea, enrichmentContext))
    );

    for (let i = 0; i < qualityIdeas.length; i++) {
      const idea = qualityIdeas[i]!;
      const enrichmentResult = enrichmentResults[i];
      const enrichment = enrichmentResult?.status === "fulfilled" ? enrichmentResult.value : null;

      if (enrichment) {
        logger.info({ title: idea.title, homerArea: enrichment.homer_improvement.area, priority: enrichment.homer_improvement.priority }, "Enrichment complete");
      }

      const slug = idea.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);
      const id = `synth_${now.toISOString().slice(5, 10).replace("-", "")}_${slug}`;

      const parsed: ParsedIdea = {
        id,
        title: idea.title,
        status: "draft",
        source: idea.source,
        content: `${idea.content}\n\n**Why this matters:** ${idea.relevance}`,
        context: `Confidence: ${idea.confidenceScore.toFixed(2)} | Provenance: ${idea.scrapeIds.join(", ")}`,
        link: idea.link || undefined,
        tags: [...idea.tags, "synthesized"],
        timestamp,
        enrichment: enrichment ? JSON.stringify(enrichment) : undefined,
      };

      const result = smartSaveIdea(parsed, db);
      saveResults.push(result);

      // Update provenance in scrapes table
      for (const scrapeId of idea.scrapeIds) {
        markProcessed(db, scrapeId, result.ideaId, idea.confidenceScore);
      }

      logger.info({ id, title: idea.title, action: result.action, confidence: idea.confidenceScore }, "Synthesized idea processed");
    }

    // Mark remaining unprocessed scrapes as processed (low score or unused)
    const processedScrapeIds = new Set(
      synthesizedIdeas.flatMap(i => i.scrapeIds)
    );
    for (const scrape of unprocessed) {
      if (!processedScrapeIds.has(scrape.id)) {
        markProcessed(db, scrape.id);
      }
    }

    const created = saveResults.filter(r => r.action === "created").length;
    const enhanced = saveResults.filter(r => r.action === "enhanced").length;
    const skipped = saveResults.filter(r => r.action === "skipped").length;

    // Store final decisions artifact
    if (jobRunId) {
      storeJobArtifact(db, jobRunId, "idea-synthesizer", "final-decisions", "json",
        JSON.stringify(saveResults.map(r => ({ id: r.ideaId, action: r.action }))),
        { created, enhanced, skipped });
    }

    const parts: string[] = [];
    parts.push(`${unprocessed.length} scrapes processed`);
    parts.push(`${synthesizedIdeas.length} synthesized`);
    if (created > 0) parts.push(`${created} new ideas`);
    if (enhanced > 0) parts.push(`${enhanced} enhanced`);
    if (skipped > 0) parts.push(`${skipped} skipped (duplicate)`);
    const criticFiltered = synthesizedIdeas.length - keepTitles.size;
    if (criticFiltered > 0) parts.push(`${criticFiltered} critic-filtered`);

    const output = `Synthesizer: ${parts.join(", ")}`;
    return { success: true, output };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Idea synthesizer failed");
    return { success: false, output: "", error: msg };
  }
}
