/**
 * Learning Engine — Multi-model swarm job
 *
 * Context-aware swarm that finds content patterns specifically useful
 * for Yanqing's career and content strategy.
 *
 * Uses Kimi (viral content research) + OpenCode Flash (pattern analysis),
 * consolidated via Gemini Flash API.
 *
 * Post-consolidation: updates ~/memory/patterns.md and writes content ideas
 * as idea files.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { z } from "zod";
import { fanOutAgents, consolidateResults, parseSwarmJSON } from "../../executors/model-swarm.js";
import type Database from "better-sqlite3";
import { buildCondensedContext, extractCurrentGoals, extractActiveProjects } from "../shared-context.js";
import { getRecentJobOutputs } from "../job-outputs.js";
import type { ParsedIdea } from "../../ideas/parser.js";
import { smartSaveIdea, type SmartSaveResult } from "../../ideas/smart-save.js";
import { logger } from "../../utils/logger.js";

const MEMORY_PATH = "/Users/yj/memory";
const DAILY_DIR = `${MEMORY_PATH}/daily`;
const PATTERNS_PATH = `${MEMORY_PATH}/patterns.md`;

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
      // Extract headers and first few lines as topic signals
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

// ============================================
// MAIN
// ============================================

export async function runLearningEngine(db?: Database.Database): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  try {
    // Pre-swarm: gather context
    const [condensedContext, goals, projects] = await Promise.all([
      buildCondensedContext(),
      extractCurrentGoals(),
      extractActiveProjects(),
    ]);

    const patternsFile = loadFileIfExists(PATTERNS_PATH);
    const recentTopics = await getRecentTopics();

    // Unified prompt for both agents (same task, different perspectives)
    const swarmPrompt = `Search the web for viral/trending content from the last 48 hours and analyze content patterns for Yanqing to build visibility as a thought leader.

## Domains to Search
- AI/ML engineering
- Career growth for senior engineers → director track
- Personal AI assistants / agent frameworks
- Algorithmic trading / quant finance
- Content creation strategy for technical professionals

## For Each Trending Content Found
1. Title and URL
2. Why it went viral (hook formula, format, timing)
3. Content structure (length, formatting, media)
4. How Yanqing could create similar content from his unique angle
5. Specific content idea for Yanqing (LinkedIn post, Medium article, or X thread) he could write THIS WEEK

## What Yanqing is working on this week
${recentTopics}

## Yanqing's Goals & Projects
${goals.slice(0, 1500)}
${projects.slice(0, 800)}

## Existing patterns (update, don't repeat)
${patternsFile.slice(0, 2000)}`;

    // Swarm: parallel execution — same task, two independent runs
    const results = await fanOutAgents([
      {
        id: "flash-learning-1",
        executor: "opencode",
        prompt: swarmPrompt,
        timeout: 300_000,
        required: false,
      },
      {
        id: "flash-learning-2",
        executor: "opencode",
        prompt: swarmPrompt,
        timeout: 300_000,
        required: false,
      },
    ]);

    // Check if any agent succeeded
    const succeeded = results.filter((r) => r.success);
    if (succeeded.length === 0) {
      const failures = results.map((r) => `${r.agentId}: ${r.output.slice(0, 100)}`).join("; ");
      return { success: false, output: "", error: `All agents failed: ${failures}` };
    }

    // Cross-job intelligence
    const recentActivity = db ? getRecentJobOutputs(db) : "";

    // Consolidation
    const consolidationPrompt = `You are a content strategy engine. Merge the agent results into patterns and content ideas for Yanqing.

## Who is Yanqing (for context)

${condensedContext.slice(0, 2500)}

## Instructions

### Patterns
1. Identify reusable content patterns (hook formulas, post structures, topic angles).
2. Merge with existing patterns — update stale ones, add genuinely new ones.
3. 3-8 patterns maximum.

### Content Ideas
1. Pick the top 3 most timely content ideas that connect to this week's actual work.
2. Each idea must have a specific hook (first line), platform recommendation, and outline.

## What Yanqing worked on this week
${recentTopics}

## Existing patterns (avoid duplicates)
${patternsFile.slice(0, 1500)}
${recentActivity ? `\n${recentActivity}\n` : ""}
## Output Format

Return ONLY a JSON object:
{"patterns": [{"platform": "linkedin"|"medium"|"x"|"general", "pattern": "description of the pattern", "example": "optional example"}], "contentIdeas": [{"title": "Post Title", "platform": "linkedin"|"medium"|"x", "hook": "First line that grabs attention", "outline": "2-3 sentence outline", "whyNow": "connects to current work/events"}]}`;

    const consolidated = await consolidateResults(results, consolidationPrompt, {
      temperature: 0.3,
    });

    // Parse and validate
    let output: { patterns: z.infer<typeof PatternSchema>[]; contentIdeas: z.infer<typeof ContentIdeaSchema>[] };
    try {
      const raw = parseSwarmJSON(consolidated, LearningOutputSchema);
      output = {
        patterns: raw.patterns ?? [],
        contentIdeas: raw.contentIdeas ?? [],
      };
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      logger.error({ error: msg }, "Failed to parse learning engine output");
      return { success: false, output: "", error: `Learning engine parse failed: ${msg}` };
    }

    // Post-consolidation: overwrite patterns.md (consolidation already merges existing)
    let patternsWritten = 0;
    if (output.patterns.length > 0) {
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

    // Post-consolidation: write content ideas via smart-save (dedup-at-write)
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
        const result = smartSaveIdea(parsed);
        ideaSaveResults.push(result);
        logger.info({ id, title: idea.title, platform: idea.platform, action: result.action }, "Learning engine idea processed");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ error: msg, title: idea.title }, "Failed to write content idea");
      }
    }

    const resultParts: string[] = [];
    resultParts.push(`${results.filter((r) => r.success).length} agents succeeded`);
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
