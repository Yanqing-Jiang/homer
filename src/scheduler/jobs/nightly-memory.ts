/**
 * Nightly Memory Processing — Multi-model swarm job
 *
 * Replaces the Claude-based nightly-memory scheduler job.
 * Uses Flash (fact extraction) + Kimi (cross-reference),
 * consolidated via Gemini Flash API.
 *
 * CRITICAL: Reads yesterday's raw daily log from SQLite archive,
 * not the .md file (which is stripped by session-summaries at 22:00).
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "fs";
import { z } from "zod";
import { fanOutAgents, consolidateResults, parseSwarmJSON } from "../../executors/model-swarm.js";
import { buildCondensedContext, extractCurrentGoals, extractActiveProjects } from "../shared-context.js";
import { getRecentJobOutputs } from "../job-outputs.js";
import { logger } from "../../utils/logger.js";
import { getMemoryIndexer } from "../../memory/indexer.js";
import { loadIdeasFromDir, type ParsedIdea } from "../../ideas/parser.js";
import { smartSaveIdea, type SmartSaveResult } from "../../ideas/smart-save.js";
import type { StateManager } from "../../state/manager.js";

const MEMORY_PATH = "/Users/yj/memory";
const DAILY_DIR = `${MEMORY_PATH}/daily`;

const PERMANENT_FILES: Record<string, string> = {
  me: `${MEMORY_PATH}/me.md`,
  work: `${MEMORY_PATH}/work.md`,
  life: `${MEMORY_PATH}/life.md`,
  preferences: `${MEMORY_PATH}/preferences.md`,
  tools: `${MEMORY_PATH}/tools.md`,
};

// ============================================
// SCHEMAS
// ============================================

const PromotionSchema = z.object({
  content: z.string().min(10),
  file: z.enum(["me", "work", "life", "preferences", "tools"]),
  section: z.string().min(1),
});

const PromotionsArraySchema = z.array(PromotionSchema);

const MinedIdeaSchema = z.object({
  title: z.string().min(5),
  content: z.string().min(20),
  context: z.string(),
});

const NightlyOutputSchema = z.object({
  promotions: PromotionsArraySchema,
  ideas: z.array(MinedIdeaSchema).default([]),
});

// ============================================
// HELPERS
// ============================================

function getYesterdayDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function loadPermanentFiles(): Record<string, string> {
  const contents: Record<string, string> = {};
  for (const [key, path] of Object.entries(PERMANENT_FILES)) {
    if (existsSync(path)) {
      contents[key] = readFileSync(path, "utf-8");
    }
  }
  return contents;
}

function appendToSection(filePath: string, section: string, content: string): boolean {
  if (!existsSync(filePath)) {
    logger.warn({ filePath }, "Target file does not exist");
    return false;
  }

  const fileContent = readFileSync(filePath, "utf-8");

  // Find the section header
  const sectionPattern = new RegExp(`(## ${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\n]*\n)`, "i");
  const match = fileContent.match(sectionPattern);

  if (match && match.index !== undefined) {
    // Insert after the section header
    const insertPoint = match.index + match[0].length;
    const updated =
      fileContent.slice(0, insertPoint) +
      `\n- ${content}\n` +
      fileContent.slice(insertPoint);

    writeFileSync(filePath, updated, "utf-8");
    return true;
  }

  // Section not found — append at end with new section header
  appendFileSync(filePath, `\n\n## ${section}\n\n- ${content}\n`);
  return true;
}

// ============================================
// MAIN
// ============================================

export async function runNightlyMemory(stateManager: StateManager): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  const yesterday = getYesterdayDate();

  try {
    // Read from SQLite archive (raw content before session-summaries stripped it)
    let rawLog: string | null = null;

    const archive = stateManager.getDailyLogArchive(yesterday);
    if (archive?.rawContent) {
      rawLog = archive.rawContent;
      logger.info({ date: yesterday, sizeKB: Math.round(rawLog.length / 1024) }, "Read raw daily log from SQLite archive");
    }

    // Fallback to .md file
    if (!rawLog) {
      const mdPath = `${DAILY_DIR}/${yesterday}.md`;
      if (existsSync(mdPath)) {
        rawLog = readFileSync(mdPath, "utf-8");
        logger.info({ date: yesterday, sizeKB: Math.round(rawLog.length / 1024) }, "Read daily log from .md file (archive not available)");
      }
    }

    if (!rawLog || rawLog.length < 100) {
      return { success: true, output: `No substantial daily log for ${yesterday}, skipping` };
    }

    // Load permanent memory files
    const permanentFiles = loadPermanentFiles();
    const permanentContext = Object.entries(permanentFiles)
      .map(([key, content]) => `## ${key}.md\n\n${content.slice(0, 6000)}`)
      .join("\n\n---\n\n");

    // Build condensed context for agents that need to know what Yanqing cares about
    const [condensedContext, goals, projects] = await Promise.all([
      buildCondensedContext(),
      extractCurrentGoals(),
      extractActiveProjects(),
    ]);

    // Warn if input appears to be summary-only (degraded quality)
    if (rawLog.length < 5000 && rawLog.includes("## Daily Summary")) {
      logger.warn({ date: yesterday, size: rawLog.length },
        "Daily log appears to be summary-only, not raw. Fact extraction may be degraded.");
    }

    // Swarm: parallel execution
    const results = await fanOutAgents([
      {
        id: "flash-parser",
        executor: "opencode",
        prompt: `Extract promotable facts from yesterday's daily log.

A "promotable fact" is information that should be persisted in permanent memory files. Focus on:
- Outcomes and decisions (NOT process steps)
- New preferences expressed by Yanqing
- Career milestones or changes
- Tool configurations or subscriptions changed
- Life events or context changes
- Architecture decisions or patterns discovered

For each fact, classify which file it belongs to:
- me: identity, goals, ambitions, personal milestones
- work: career, projects, professional contacts, positioning
- life: life context, routines, health, relationships, travel
- preferences: communication style, technical choices, workflow preferences
- tools: tool configs, subscriptions, API keys, service settings

And specify which SECTION within that file (use existing section names from the file when possible).

## What Yanqing Cares About (for calibrating "promotable")

Use this to distinguish milestones from routine work. A fact about MAHORAGA trading or Career OS pipeline is a milestone. A fact about routine daemon restarts is noise.

${goals.slice(0, 1200)}

### Active Projects
${projects.slice(0, 800)}

Quality bar: 3-8 facts max. Skip trivial/routine items.

## Daily Log (${yesterday})

${rawLog.slice(0, 80000)}`,
        timeout: 300_000,
        required: true,
      },
      {
        id: "flash-idea-mining",
        executor: "opencode",
        prompt: `Extract up to 3 actionable ideas from yesterday's daily log.

An "idea" is different from a "fact to promote":
- Facts go to permanent memory (what happened, what was decided)
- Ideas go to the idea pipeline (what SHOULD happen next, what could be built)

Focus on:
1. Problems Yanqing encountered that could be automated
2. Tools/repos mentioned that deserve deeper exploration
3. Patterns or insights that suggest a new project or feature
4. Career opportunities mentioned or implied

For each idea provide: title, content (2-3 sentences), and why it matters for Yanqing's goals.

## Yanqing's Current Goals
${goals.slice(0, 1200)}

## Active Projects
${projects.slice(0, 800)}

## Daily Log (${yesterday})
${rawLog.slice(0, 40000)}`,
        timeout: 300_000,
        required: false,
      },
      {
        id: "flash-crossref",
        executor: "opencode",
        prompt: `Cross-reference Yanqing's permanent memory files and identify:

1. What's already well-captured in each file
2. Any areas that seem stale or outdated
3. Gaps — things that should be documented but aren't

For each file, list the SECTION NAMES so the consolidation step can target promotions accurately.

This helps the consolidation step avoid duplicating existing content.

Summarize each file's coverage in 2-3 sentences, then list section names.

## Permanent Memory Files

${permanentContext}`,
        timeout: 300_000,
        required: false,
      },
    ]);

    // Cross-job intelligence
    const recentActivity = getRecentJobOutputs(stateManager.getDb());

    // Consolidation — with personal context for accurate dedup
    // Build existing idea titles for dedup
    const existingIdeas = loadIdeasFromDir();
    const existingTitles = existingIdeas.slice(0, 100).map((i) => i.title).join(", ");

    const consolidationPrompt = `You are a memory promotion engine. Merge the extracted facts with cross-reference context to produce final promotions AND actionable ideas.

## Who is Yanqing (for context)

${condensedContext.slice(0, 2000)}

## Instructions

### Promotions (facts → permanent memory)
1. Keep only GENUINELY NEW information — deduplicate against what's already in the permanent files (use the cross-reference agent's summary to check).
2. Map each promotion to the correct file and section.
3. Quality bar: outcomes over process, specific over vague, milestones over routine.
4. 3-8 promotions maximum.
5. Each promotion should be a single, self-contained statement.
6. Use existing section names from the files when possible (the cross-reference agent should have listed them).

### Ideas (forward-looking → idea pipeline)
1. Extract from the idea-mining agent's output.
2. Deduplicate against existing idea titles: ${existingTitles.slice(0, 2000)}
3. Only include genuinely actionable ideas that connect to current work.
4. 0-3 ideas maximum.
${recentActivity ? `\n${recentActivity}\n` : ""}
## Output Format

Return ONLY a JSON object:
{"promotions": [{"content": "fact to promote", "file": "me"|"work"|"life"|"preferences"|"tools", "section": "Section Name"}], "ideas": [{"title": "Idea Title", "content": "what and why", "context": "how this connects to Yanqing's goals"}]}

If nothing to promote/no ideas, use empty arrays.`;

    const consolidated = await consolidateResults(results, consolidationPrompt, {
      temperature: 0.2,
    });

    // Parse and validate — try new combined schema first, fall back to promotions-only
    let promotions: z.infer<typeof PromotionsArraySchema>;
    let minedIdeas: z.infer<typeof MinedIdeaSchema>[] = [];

    try {
      const nightlyOutput = parseSwarmJSON(consolidated, NightlyOutputSchema);
      promotions = nightlyOutput.promotions ?? [];
      minedIdeas = nightlyOutput.ideas ?? [];
    } catch {
      // Fall back to legacy promotions-only format
      try {
        promotions = parseSwarmJSON(consolidated, PromotionsArraySchema);
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        logger.error({ error: msg, rawOutput: consolidated.slice(0, 500) }, "Failed to parse nightly memory output");
        return { success: false, output: "", error: `Nightly output parse failed: ${msg}` };
      }
    }

    // Write promotions
    let writtenPromos = 0;
    const writeErrors: string[] = [];

    for (const promo of promotions) {
      const filePath = PERMANENT_FILES[promo.file];
      if (!filePath) {
        writeErrors.push(`Unknown target file: ${promo.file}`);
        continue;
      }

      try {
        const ok = appendToSection(filePath, promo.section, promo.content);
        if (ok) {
          writtenPromos++;
          logger.info({ file: promo.file, section: promo.section, content: promo.content.slice(0, 80) }, "Promoted fact to permanent memory");
        } else {
          writeErrors.push(`Failed to write to ${promo.file}/${promo.section}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeErrors.push(`Write error for ${promo.file}: ${msg}`);
        logger.error({ error: msg, file: promo.file }, "Failed to promote fact");
      }
    }

    // Write mined ideas via smart-save (dedup-at-write)
    const ideaSaveResults: SmartSaveResult[] = [];
    const now = new Date();
    const timestamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;

    for (const idea of minedIdeas) {
      const slug = idea.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);
      const id = `nightly_${now.toISOString().slice(5, 10).replace("-", "")}_${slug}`;

      const parsed: ParsedIdea = {
        id,
        title: idea.title,
        status: "draft",
        source: "nightly-mining",
        content: idea.content,
        context: idea.context,
        tags: ["nightly-mining", "auto-extracted"],
        timestamp,
      };

      try {
        const result = smartSaveIdea(parsed);
        ideaSaveResults.push(result);
        logger.info({ id, title: idea.title, action: result.action }, "Nightly idea processed");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ error: msg, title: idea.title }, "Failed to write mined idea");
      }
    }

    // Reindex FTS5
    try {
      const indexer = getMemoryIndexer();
      await indexer.reindexAll();
      logger.info("Memory FTS5 reindexed after nightly promotions");
    } catch (indexErr) {
      logger.warn({ error: indexErr }, "Failed to reindex memory after promotions");
    }

    const parts: string[] = [];
    if (writtenPromos > 0 || promotions.length > 0) {
      parts.push(`Promoted ${writtenPromos}/${promotions.length} facts`);
    }
    const ideaCreated = ideaSaveResults.filter((r) => r.action === "created").length;
    const ideaEnhanced = ideaSaveResults.filter((r) => r.action === "enhanced").length;
    const ideaSkipped = ideaSaveResults.filter((r) => r.action === "skipped").length;
    if (ideaCreated > 0) parts.push(`${ideaCreated} new ideas`);
    if (ideaEnhanced > 0) parts.push(`${ideaEnhanced} ideas enhanced`);
    if (ideaSkipped > 0) parts.push(`${ideaSkipped} ideas skipped`);
    if (writeErrors.length > 0) {
      parts.push(`errors: ${writeErrors.join("; ")}`);
    }
    const output = parts.length > 0
      ? `${parts.join(", ")} from ${yesterday}'s log`
      : `No new facts or ideas from ${yesterday}'s daily log`;

    return { success: true, output };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Nightly memory processing failed");
    return { success: false, output: "", error: msg };
  }
}
