/**
 * Learning Engine — Content Pattern Discovery
 *
 * Analyzes recent scrapes and existing patterns to update Yanqing's
 * content playbook. No web search — uses existing scraped content only.
 *
 * Post-analysis: updates ~/memory/patterns.md and writes content ideas
 * as idea files.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { z } from "zod";
import { parseSwarmJSON } from "../../executors/model-swarm.js";
import { executeClaudeCommand } from "../../executors/claude.js";
import { extractCurrentGoals, extractActiveProjects } from "../shared-context.js";
import { getRecentScrapes } from "../../scraping/scrape-store.js";
import { storeJobArtifact } from "./artifact-store.js";
import type { ParsedIdea } from "../../ideas/parser.js";
import { smartSaveIdea, type SmartSaveResult } from "../../ideas/smart-save.js";
import { logger } from "../../utils/logger.js";
import { PATHS } from "../../config/paths.js";

const DAILY_DIR = PATHS.daily;
const PATTERNS_PATH = PATHS.patterns;

// ============================================
// SCHEMAS
// ============================================

const PatternSchema = z.object({
  platform: z.enum(["linkedin", "medium", "x", "general"]),
  pattern: z.string().min(10),
  example: z.string().optional(),
});

const ContentIdeaSchema = z.object({
  title: z.string().min(5),
  platform: z.enum(["linkedin", "medium", "x"]),
  hook: z.string(),
  outline: z.string(),
  whyNow: z.string(),
});

const LearningOutputSchema = z.object({
  patterns: z.array(PatternSchema).default([]),
  contentIdeas: z.array(ContentIdeaSchema).default([]),
});

// ============================================
// HELPERS
// ============================================

function loadFileIfExists(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

/**
 * Extract topics from last 3 daily logs — what Yanqing is working on THIS WEEK
 */
async function getRecentTopics(): Promise<string> {
  const topics: string[] = [];
  const now = new Date();

  for (let i = 0; i < 3; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const logPath = `${DAILY_DIR}/${dateStr}.md`;

    if (existsSync(logPath)) {
      const content = readFileSync(logPath, "utf-8");
      const headers = content.match(/^##\s+.+$/gm);
      if (headers) {
        topics.push(`### ${dateStr}\n${headers.slice(0, 10).join("\n")}`);
      }
    }
  }

  return topics.length > 0
    ? topics.join("\n\n")
    : "(No recent daily logs found)";
}

/**
 * Build a digest from recent scrapes for the LLM to analyze.
 */
function buildScrapeDigest(db: Database.Database): string {
  const scrapes = getRecentScrapes(db, undefined, 48);
  if (scrapes.length === 0) return "(No recent scrapes found)";

  return scrapes
    .slice(0, 40)
    .map((s) => {
      const snippet = (s.raw_content ?? "").replace(/\s+/g, " ").slice(0, 600);
      return `## ${s.source} | ${s.title || "(untitled)"}\nURL: ${s.url || "N/A"}\n${snippet}`;
    })
    .join("\n\n---\n\n");
}

// ============================================
// MAIN
// ============================================

export async function runLearningEngine(db?: Database.Database, jobRunId?: number): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  try {
    const [goals, projects] = await Promise.all([
      extractCurrentGoals(),
      extractActiveProjects(),
    ]);

    const patternsFile = loadFileIfExists(PATTERNS_PATH);
    const recentTopics = await getRecentTopics();
    const scrapeDigest = db ? buildScrapeDigest(db) : "(No database available)";

    const prompt = `You are analyzing recent scraped content and existing patterns to update Yanqing's content playbook.

Use only the provided material. Do not invent external examples.

## Recent Scrapes (last 48 hours)
${scrapeDigest.slice(0, 24_000)}

## Existing Patterns (update, don't repeat)
${patternsFile.slice(0, 2_000)}

## What Yanqing is working on this week
${recentTopics}

## Yanqing's Goals & Projects
${goals.slice(0, 1_500)}
${projects.slice(0, 800)}

## Output Format

Return ONLY a valid JSON object (no markdown, no preamble):
{"patterns": [{"platform": "linkedin"|"medium"|"x"|"general", "pattern": "description of the pattern", "example": "optional example"}], "contentIdeas": [{"title": "Post Title", "platform": "linkedin"|"medium"|"x", "hook": "First line that grabs attention", "outline": "2-3 sentence outline", "whyNow": "connects to current work/events"}]}

If no patterns or ideas found, use empty arrays.`;

    const result = await executeClaudeCommand(prompt, {
      cwd: process.env.HOME ?? "/Users/yj",
      model: "sonnet",
      timeout: 1_200_000, // 20 min — matches schedule.json config
    });

    if (result.exitCode !== 0 || !result.output || result.output.length < 50) {
      // Single retry with same timeout
      const retry = await executeClaudeCommand(prompt, {
        cwd: process.env.HOME ?? "/Users/yj",
        model: "sonnet",
        timeout: 1_200_000,
      });
      if (retry.exitCode !== 0 || !retry.output || retry.output.length < 50) {
        return { success: false, output: "", error: `Learning engine failed after retry: ${retry.output?.slice(0, 200)}` };
      }
      result.output = retry.output;
    }

    // Parse and validate
    let output: { patterns: z.infer<typeof PatternSchema>[]; contentIdeas: z.infer<typeof ContentIdeaSchema>[] };
    try {
      const raw = parseSwarmJSON(result.output ?? "", LearningOutputSchema);
      output = {
        patterns: raw.patterns ?? [],
        contentIdeas: raw.contentIdeas ?? [],
      };
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      logger.error({ error: msg }, "Failed to parse learning engine output");
      return { success: false, output: "", error: `Learning engine parse failed: ${msg}` };
    }

    // Store consolidated output as artifact
    if (db && jobRunId) {
      storeJobArtifact(db, jobRunId, "learning-engine", "consolidated-output", "json",
        JSON.stringify(output), { patternsCount: output.patterns.length, ideasCount: output.contentIdeas.length });
    }

    // Post-consolidation: overwrite patterns.md
    let patternsWritten = 0;
    if (output.patterns.length > 0) {
      // memory_file_snapshots removed — git handles version control

      const today = new Date().toISOString().slice(0, 10);
      const header = `# Content Patterns\n\nAuto-maintained by learning engine. Last updated: ${today}\n\n`;
      const patternLines = output.patterns.map((p) => {
        const example = p.example ? ` (e.g., ${p.example})` : "";
        return `- **[${p.platform}]** ${p.pattern}${example}`;
      }).join("\n");
      writeFileSync(PATTERNS_PATH, header + patternLines + "\n");
      patternsWritten = output.patterns.length;
      logger.info({ count: patternsWritten }, "Overwrote patterns.md");
    }

    // Post-consolidation: write content ideas via smart-save
    const ideaSaveResults: SmartSaveResult[] = [];
    const now = new Date();
    const timestamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;

    for (const idea of output.contentIdeas) {
      const slug = idea.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);
      const id = `learn_${now.toISOString().slice(5, 10).replace("-", "")}_${slug}`;

      const parsed: ParsedIdea = {
        id,
        title: idea.title,
        status: "draft",
        source: "learning-engine",
        content: `**Platform:** ${idea.platform}\n**Hook:** ${idea.hook}\n\n${idea.outline}`,
        context: idea.whyNow,
        tags: ["content-idea", idea.platform, "learning-engine"],
        timestamp,
      };

      try {
        const saveResult = smartSaveIdea(parsed, db);
        ideaSaveResults.push(saveResult);
        logger.info({ id, title: idea.title, platform: idea.platform, action: saveResult.action }, "Learning engine idea processed");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ error: msg, title: idea.title }, "Failed to write content idea");
      }
    }

    const resultParts: string[] = [];
    resultParts.push("single Sonnet call");
    if (patternsWritten > 0) resultParts.push(`${patternsWritten} patterns updated`);
    const ideaCreated = ideaSaveResults.filter((r) => r.action === "created").length;
    const ideaEnhanced = ideaSaveResults.filter((r) => r.action === "enhanced").length;
    const ideaSkipped = ideaSaveResults.filter((r) => r.action === "skipped").length;
    if (ideaCreated > 0) resultParts.push(`${ideaCreated} new content ideas`);
    if (ideaEnhanced > 0) resultParts.push(`${ideaEnhanced} ideas enhanced`);
    if (ideaSkipped > 0) resultParts.push(`${ideaSkipped} ideas skipped`);
    if (patternsWritten === 0 && ideaCreated === 0 && ideaEnhanced === 0) resultParts.push("no new patterns or ideas");

    return { success: true, output: `Learning engine: ${resultParts.join(", ")}` };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Learning engine failed");
    return { success: false, output: "", error: msg };
  }
}
