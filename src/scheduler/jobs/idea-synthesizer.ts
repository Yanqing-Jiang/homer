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

import { readFileSync, existsSync } from "fs";
import { z } from "zod";
import type Database from "better-sqlite3";
import { executeClaudeCommand } from "../../executors/claude.js";
import { executeGeminiAPI } from "../../executors/gemini.js";
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
    const result = await executeGeminiAPI(prompt, {
      model: "flash3",
      maxTokens: 4096,
      responseMimeType: "application/json",
      temperature: 0.2,
    });

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
    // Primary: Sonnet via Claude Code CLI — full context window, best synthesis quality
    const sonnetResult = await executeClaudeCommand(prompt, {
      cwd: process.env.HOME ?? "/Users/yj",
      model: "sonnet",
      timeout: 120_000,
    });

    if (sonnetResult.exitCode === 0 && sonnetResult.output) {
      return parseSwarmJSON(sonnetResult.output, SynthesisOutputSchema);
    }

    // Fallback: retry Sonnet with higher timeout
    logger.warn({ exitCode: sonnetResult.exitCode }, "Sonnet synthesis failed, retrying with longer timeout");
    const retryResult = await executeClaudeCommand(prompt, {
      cwd: process.env.HOME ?? "/Users/yj",
      model: "sonnet",
      timeout: 180_000,
    });

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
    const result = await executeGeminiAPI(prompt, {
      model: "flash3",
      maxTokens: 2048,
      responseMimeType: "application/json",
      temperature: 0.1,
    });

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

    for (const idea of synthesizedIdeas) {
      // Quality gate: confidence threshold
      if (idea.confidenceScore < 0.4) {
        logger.info({ title: idea.title, score: idea.confidenceScore }, "Below quality threshold");
        continue;
      }

      // Critic filter
      if (!keepTitles.has(idea.title)) {
        logger.info({ title: idea.title }, "Filtered by critic");
        continue;
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
