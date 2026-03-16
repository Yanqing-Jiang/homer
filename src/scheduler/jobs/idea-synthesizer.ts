/**
 * Idea Synthesizer — The Brain
 *
 * Architecture: Single-pass Claude Sonnet with SKILLS.md
 *   - Loads unprocessed scrapes + context
 *   - Sends everything to Claude Sonnet in one call
 *   - Sonnet scores, synthesizes, critiques, and enriches in a single pass
 *   - Post-processes the JSON output into ideas via smartSaveIdea()
 *
 * Pre-scored/pre-enriched scrapes from deep-linker are passed through as context.
 *
 * Schedule: 30 1 * * * (daily at 1:30am, after deep-linker at 1:00am)
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import type Database from "better-sqlite3";
import { executeClaudeCommand } from "../../executors/claude.js";
import { getUnprocessedScrapes, markProcessed, type StoredScrape } from "../../scraping/scrape-store.js";
import type { ParsedIdea } from "../../ideas/parser.js";
import * as ideaDao from "../../ideas/dao.js";
import { smartSaveIdea, type SmartSaveResult } from "../../ideas/smart-save.js";
import { formatForPrompt as getPreferenceContext } from "../../preferences/engine.js";
import { buildCondensedContext } from "../shared-context.js";
import { logger } from "../../utils/logger.js";
import { storeJobArtifact } from "./artifact-store.js";
import { PATHS } from "../../config/paths.js";

const DENY_HISTORY = PATHS.denyHistory;
const SKILL_PATH = "/Users/yj/.claude/skills/idea-synthesizer/SKILLS.md";
const SONNET_TIMEOUT = 1_200_000; // 20 min for single-pass
const MAX_SCRAPES_PER_BATCH = 10;
const RETRY_BATCH_SIZE = 5;

// ============================================
// SCHEMAS
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

const SonnetIdeaSchema = z.object({
  title: z.string(),
  content: z.string(),
  source: z.string(),
  link: z.string(),
  tags: z.array(z.string()),
  relevance: z.string(),
  confidenceScore: z.number().min(0).max(1),
  scrapeIds: z.array(z.string()),
  critic: z.object({
    novelty: z.number(),
    goalAlignment: z.number(),
    feasibility: z.number(),
  }),
  enrichment: EnrichmentSchema,
});

const SonnetOutputSchema = z.object({
  scores: z.array(z.object({
    scrapeId: z.string(),
    score: z.number(),
    summary: z.string(),
    dimensions: z.array(z.string()),
  })),
  ideas: z.array(SonnetIdeaSchema),
  stats: z.object({
    totalScraped: z.number(),
    scored: z.number(),
    aboveThreshold: z.number(),
    synthesized: z.number(),
    criticPassed: z.number(),
    enriched: z.number(),
  }),
});

// ============================================
// HELPERS
// ============================================

function loadFileIfExists(path: string, maxChars?: number): string {
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf-8");
  return maxChars ? content.slice(0, maxChars) : content;
}

function formatScrapesForPrompt(scrapes: StoredScrape[]): string {
  return scrapes.map((s, i) => {
    const meta = s.metadata ? JSON.parse(s.metadata) : {};
    const preScore = s.quality_score != null ? ` | Pre-score: ${s.quality_score}` : "";
    let preEnrichment = "";
    if (meta.deep_linker?.enrichment) {
      preEnrichment = `\nPre-enrichment (from deep-linker): ${JSON.stringify(meta.deep_linker.enrichment).slice(0, 500)}`;
    }
    return `### [${i + 1}] ${s.title || "(no title)"} (ID: ${s.id})
Source: ${s.source} | URL: ${s.url || "N/A"} | Author: ${s.author || "N/A"}${preScore}
${meta.stars ? `Stars: ${meta.stars} | ` : ""}${meta.language ? `Language: ${meta.language} | ` : ""}${meta.topic ? `Topic: ${meta.topic}` : ""}${preEnrichment}

${(s.raw_content || "").slice(0, 2000)}
`;
  }).join("\n---\n");
}

/**
 * Load .md files modified in the last N days from output/plan dirs.
 * Returns a single concatenated string, truncated to maxTotalChars.
 * Files are sorted newest-first, each capped at perFileCap chars.
 */
export function loadRecentMdFiles(maxDays = 7, maxTotalChars = 6000, perFileCap = 800): string {
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

function parseJsonFromOutput(output: string): unknown {
  // Try direct parse first
  try {
    return JSON.parse(output);
  } catch { /* continue */ }

  // Extract JSON from markdown fences or mixed output
  const fenceMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* continue */ }
  }

  // Find the largest JSON object
  const jsonMatch = output.match(/\{[\s\S]*"ideas"[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch { /* continue */ }
  }

  return null;
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
    const unprocessed = getUnprocessedScrapes(db, 48);

    if (unprocessed.length === 0) {
      return { success: true, output: "No unprocessed scrapes to synthesize" };
    }

    logger.info({ count: unprocessed.length }, "Starting idea synthesis via Sonnet");

    // Load context in parallel
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
    const recentOutputs = loadRecentMdFiles(7, 4000, 600);

    // Load SKILLS.md
    const skillContent = existsSync(SKILL_PATH)
      ? readFileSync(SKILL_PATH, "utf-8")
      : "";

    // Shared context for all batches
    const sharedContext = `${skillContent}

---

## Context for Scoring & Synthesis

### Yanqing's Goals & Context
${condensedContext.slice(0, 5000)}

### Learned Preferences
${preferences || "(no preferences yet)"}

### Deny History (topics/patterns to AVOID)
${denyHistory.slice(0, 3000)}

### Existing Idea Titles (AVOID duplicates)
${existingTitles.slice(0, 2000)}

### Recent Agent Outputs (last 7 days)
${recentOutputs.slice(0, 3000) || "(none)"}

---`;

    // Helper: synthesize a single batch of scrapes
    async function synthesizeBatch(scrapes: StoredScrape[]): Promise<z.infer<typeof SonnetOutputSchema> | null> {
      const prompt = `${sharedContext}

## Scrapes to Process (${scrapes.length} items)

${formatScrapesForPrompt(scrapes)}

---

Process all ${scrapes.length} scrapes through the full pipeline (score → synthesize → critic → enrich).
Return ONLY a valid JSON object matching the output format in the skill. No markdown fences.`;

      logger.info({ scrapeCount: scrapes.length, promptChars: prompt.length }, "Calling Sonnet for batch");

      const result = await executeClaudeCommand(prompt, {
        cwd: "/tmp",
        model: "sonnet",
        timeout: SONNET_TIMEOUT,
      });

      if (result.exitCode !== 0 || !result.output) {
        logger.error({ exitCode: result.exitCode, output: result.output?.slice(0, 500) }, "Sonnet batch call failed");
        return null;
      }

      const rawParsed = parseJsonFromOutput(result.output);
      if (!rawParsed) {
        logger.error({ outputLen: result.output.length, sample: result.output.slice(0, 500) }, "Failed to parse Sonnet batch JSON");
        return null;
      }

      try {
        return SonnetOutputSchema.parse(rawParsed);
      } catch (err) {
        logger.error({ error: err, sample: JSON.stringify(rawParsed).slice(0, 500) }, "Sonnet batch schema validation failed");
        return null;
      }
    }

    // Process scrapes in chunks with retry
    const chunks: StoredScrape[][] = [];
    for (let i = 0; i < unprocessed.length; i += MAX_SCRAPES_PER_BATCH) {
      chunks.push(unprocessed.slice(i, i + MAX_SCRAPES_PER_BATCH));
    }

    logger.info({ totalScrapes: unprocessed.length, batchCount: chunks.length, batchSize: MAX_SCRAPES_PER_BATCH }, "Processing scrapes in batches");

    const batchResults: z.infer<typeof SonnetOutputSchema>[] = [];
    const failedScrapeIds: string[] = [];

    for (const chunk of chunks) {
      let result = await synthesizeBatch(chunk);

      if (!result && chunk.length > RETRY_BATCH_SIZE) {
        // Retry by splitting into smaller sub-batches
        logger.warn({ chunkSize: chunk.length, retrySize: RETRY_BATCH_SIZE }, "Batch failed, retrying with smaller sub-batches");
        for (let i = 0; i < chunk.length; i += RETRY_BATCH_SIZE) {
          const subChunk = chunk.slice(i, i + RETRY_BATCH_SIZE);
          const subResult = await synthesizeBatch(subChunk);
          if (subResult) {
            batchResults.push(subResult);
          } else {
            logger.error({ scrapeIds: subChunk.map(s => s.id) }, "Sub-batch also failed, marking scrapes as processed");
            failedScrapeIds.push(...subChunk.map(s => s.id));
          }
        }
        continue;
      }

      if (result) {
        batchResults.push(result);
      } else {
        logger.error({ scrapeIds: chunk.map(s => s.id) }, "Batch failed (small batch), marking scrapes as processed");
        failedScrapeIds.push(...chunk.map(s => s.id));
      }
    }

    // Mark double-failed scrapes as processed to prevent infinite retry
    for (const scrapeId of failedScrapeIds) {
      markProcessed(db, scrapeId);
    }

    if (batchResults.length === 0) {
      return { success: false, output: "", error: "All batches failed to produce valid output" };
    }

    // Merge batch results
    const sonnetResult: z.infer<typeof SonnetOutputSchema> = {
      scores: batchResults.flatMap(r => r.scores),
      ideas: batchResults.flatMap(r => r.ideas),
      stats: {
        totalScraped: batchResults.reduce((sum, r) => sum + r.stats.totalScraped, 0),
        scored: batchResults.reduce((sum, r) => sum + r.stats.scored, 0),
        aboveThreshold: batchResults.reduce((sum, r) => sum + r.stats.aboveThreshold, 0),
        synthesized: batchResults.reduce((sum, r) => sum + r.stats.synthesized, 0),
        criticPassed: batchResults.reduce((sum, r) => sum + r.stats.criticPassed, 0),
        enriched: batchResults.reduce((sum, r) => sum + r.stats.enriched, 0),
      },
    };

    logger.info({
      scores: sonnetResult.scores.length,
      ideas: sonnetResult.ideas.length,
      stats: sonnetResult.stats,
    }, "Sonnet synthesis complete");

    // Store artifacts
    if (jobRunId) {
      storeJobArtifact(db, jobRunId, "idea-synthesizer", "sonnet-scores", "json",
        JSON.stringify(sonnetResult.scores), { count: sonnetResult.scores.length });
      if (sonnetResult.ideas.length > 0) {
        storeJobArtifact(db, jobRunId, "idea-synthesizer", "sonnet-ideas", "json",
          JSON.stringify(sonnetResult.ideas), sonnetResult.stats);
      }
    }

    // Save ideas
    const now = new Date();
    const timestamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;
    const saveResults: SmartSaveResult[] = [];

    for (const idea of sonnetResult.ideas) {
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
        context: `Confidence: ${idea.confidenceScore.toFixed(2)} | Critic: N${idea.critic.novelty}/G${idea.critic.goalAlignment}/F${idea.critic.feasibility} | Provenance: ${idea.scrapeIds.join(", ")}`,
        link: idea.link || undefined,
        tags: [...idea.tags, "synthesized"],
        timestamp,
        enrichment: JSON.stringify(idea.enrichment),
      };

      const saveResult = smartSaveIdea(parsed, db);
      saveResults.push(saveResult);

      for (const scrapeId of idea.scrapeIds) {
        markProcessed(db, scrapeId, saveResult.ideaId, idea.confidenceScore);
      }

      logger.info({ id, title: idea.title, action: saveResult.action, confidence: idea.confidenceScore }, "Idea saved");
    }

    // Mark remaining scrapes as processed
    const usedScrapeIds = new Set(sonnetResult.ideas.flatMap(i => i.scrapeIds));
    for (const scrape of unprocessed) {
      if (!usedScrapeIds.has(scrape.id)) {
        markProcessed(db, scrape.id);
      }
    }

    const created = saveResults.filter(r => r.action === "created").length;
    const enhanced = saveResults.filter(r => r.action === "enhanced").length;
    const skipped = saveResults.filter(r => r.action === "skipped").length;

    if (jobRunId) {
      storeJobArtifact(db, jobRunId, "idea-synthesizer", "final-decisions", "json",
        JSON.stringify(saveResults.map(r => ({ id: r.ideaId, action: r.action }))),
        { created, enhanced, skipped });
    }

    const parts: string[] = [];
    parts.push(`${unprocessed.length} scrapes → Sonnet`);
    parts.push(`${sonnetResult.stats.aboveThreshold} above threshold`);
    parts.push(`${sonnetResult.stats.criticPassed} critic-passed`);
    if (created > 0) parts.push(`${created} new ideas`);
    if (enhanced > 0) parts.push(`${enhanced} enhanced`);
    if (skipped > 0) parts.push(`${skipped} skipped (duplicate)`);

    const output = `Synthesizer: ${parts.join(", ")}`;
    return { success: true, output };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Idea synthesizer failed");
    return { success: false, output: "", error: msg };
  }
}
