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

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { z } from "zod";
import { parseSwarmJSON } from "../../executors/model-swarm.js";
import { executeClaudeCommand } from "../../executors/claude.js";
import { executeOpenCodeCLI } from "../../executors/opencode-cli.js";
import { buildCondensedContext, extractCurrentGoals, extractActiveProjects } from "../shared-context.js";
import { getRecentJobOutputs } from "../job-outputs.js";
import { logger } from "../../utils/logger.js";
import { OPUS_COPILOT_MODEL } from "../../models.js";
import { getMemoryIndexer } from "../../memory/indexer.js";
import type { StateManager } from "../../state/manager.js";
import { trackPromotion } from "../../outcomes/hooks.js";

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

const NightlyOutputSchema = z.object({
  promotions: PromotionsArraySchema,
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

    if (!rawLog) rawLog = "";

    // Read yesterday's explicit feedback to include in analysis
    let feedbackLog = "";
    try {
      const feedbackPath = `${MEMORY_PATH}/feedback.md`;
      if (existsSync(feedbackPath)) {
        const lines = readFileSync(feedbackPath, "utf-8").split("\n");
        const yesterdayFeedback: string[] = [];
        const keepLines: string[] = [];
        let inYesterday = false;
        let lineDateStr = "";
        
        // Only keep lines from today/yesterday in the active file, move rest to archive
        const keepThreshold = new Date();
        keepThreshold.setDate(keepThreshold.getDate() - 3);
        const y = keepThreshold.getFullYear();
        const m = String(keepThreshold.getMonth() + 1).padStart(2, "0");
        const d = String(keepThreshold.getDate()).padStart(2, "0");
        const keepThresholdStr = `${y}-${m}-${d}`;
        
        const archiveLines: string[] = [];

        for (const line of lines) {
          if (line.startsWith("### [")) {
            lineDateStr = line.substring(5, 15); // Extract YYYY-MM-DD
            inYesterday = line.includes(`[${yesterday}`);
            
            if (inYesterday) yesterdayFeedback.push(line);
            
            if (lineDateStr >= keepThresholdStr) keepLines.push(line);
            else archiveLines.push(line);
          } else if (inYesterday) {
            yesterdayFeedback.push(line);
            if (lineDateStr >= keepThresholdStr) keepLines.push(line);
            else archiveLines.push(line);
          } else {
             // Not yesterday, check if we keep it
             if (lineDateStr >= keepThresholdStr) keepLines.push(line);
             else if (lineDateStr) archiveLines.push(line); // Has a date but is old
             else keepLines.push(line); // No date (header/padding), keep it
          }
        }
        
        if (yesterdayFeedback.length > 0) {
          feedbackLog = `\n\n## Explicit User Feedback from Telegram/UI (${yesterday})\n\n` + yesterdayFeedback.join("\n");
          rawLog += feedbackLog;
          logger.info({ date: yesterday, feedbackLines: yesterdayFeedback.length }, "Appended yesterday's explicit feedback to daily log for analysis");
        }

        // Rotate old feedback
        if (archiveLines.length > 0) {
            writeFileSync(feedbackPath, keepLines.join("\n"), "utf-8");
            try {
              if (!existsSync("/Users/yj/archive")) mkdirSync("/Users/yj/archive", { recursive: true });
              appendFileSync("/Users/yj/archive/feedback-archive.md", "\n" + archiveLines.join("\n"), "utf-8");
            } catch (err) {
              logger.warn({ error: err }, "Failed to write to feedback archive");
            }
            logger.info({ archivedLines: archiveLines.length }, "Rotated feedback.md to archive");
        }
      }
    } catch (err) {
      logger.warn({ error: err }, "Failed to read feedback log");
    }

    if (rawLog.length < 100) {
      return { success: true, output: `No substantial daily log or feedback for ${yesterday}, skipping` };
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

    // Cross-job intelligence
    const recentActivity = getRecentJobOutputs(stateManager.getDb());

    // Single Opus 4.6 call — fact extraction only (idea mining moved to idea-synthesizer)
    const unifiedPrompt = `You are a memory processing engine for Yanqing's personal AI assistant. Analyze yesterday's daily log, cross-reference against permanent memory files, and extract promotable facts.

## Extract Promotable Facts (3-8 max)

A "promotable fact" is information worth persisting in permanent memory. Focus on:
- Outcomes and decisions (NOT process steps)
- New preferences expressed (PAY SPECIAL ATTENTION to the Explicit User Feedback section. If Yanqing archived something with specific notes or instructions, extract that as a new rule or preference to remember).
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

And specify which SECTION within that file. Use EXISTING section names from the permanent files below when possible. Only genuinely NEW information — skip anything already well-captured.

## Context

### Who is Yanqing
${condensedContext.slice(0, 2000)}

### Current Goals
${goals.slice(0, 1200)}

### Active Projects
${projects.slice(0, 800)}
${recentActivity ? `\n### Recent Job Activity\n${recentActivity}\n` : ""}
## Permanent Memory Files (cross-reference to avoid duplicates)

${permanentContext}

## Daily Log (${yesterday})

${rawLog.length > 80000 ? rawLog.slice(0, 80000) + "\n\n... (log truncated) ...\n\n" + feedbackLog : rawLog}

## Output Format

Return ONLY a valid JSON object (no markdown, no preamble):
{"promotions": [{"content": "fact to promote", "file": "me"|"work"|"life"|"preferences"|"tools", "section": "Section Name"}]}

If nothing to promote, use an empty array.`;

    logger.info({ promptLength: unifiedPrompt.length, date: yesterday }, "Running nightly memory via Claude Opus 4.6");

    let consolidated = "";

    try {
      const opusResult = await executeClaudeCommand(unifiedPrompt, {
        cwd: "/tmp/homer-swarm",
        model: "opus",
        timeout: 600_000, // 10 min — Opus is slower but one call replaces 4
      });

      consolidated = opusResult.output ?? "";

      if (!consolidated || consolidated.length < 50) {
        throw new Error(`Opus output too short: ${consolidated.length} chars`);
      }
    } catch (opusErr) {
      // Fallback to Opus 4.6 via opencode (free tokens via Copilot)
      const msg = opusErr instanceof Error ? opusErr.message : String(opusErr);
      logger.warn({ error: msg }, "Claude CLI Opus failed, falling back to Opus 4.6 via opencode");

      const fallback = await executeOpenCodeCLI(unifiedPrompt, "", {
        model: OPUS_COPILOT_MODEL,
        timeout: 600_000,
        researchOnly: true,
      });

      if (fallback.exitCode !== 0 || !fallback.output || fallback.output.length < 50) {
        return { success: false, output: "", error: `Nightly memory failed (both Opus paths): ${fallback.output?.slice(0, 200)}` };
      }
      consolidated = fallback.output;
    }

    // Parse and validate
    let promotions: z.infer<typeof PromotionsArraySchema>;

    try {
      const nightlyOutput = parseSwarmJSON(consolidated, NightlyOutputSchema);
      promotions = nightlyOutput.promotions ?? [];
    } catch {
      // Fall back to promotions-only array format
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
          // Track outcome for this promotion
          try {
            trackPromotion(stateManager.getDb(), promo.content.slice(0, 80), promo.file);
          } catch { /* outcome tracking best-effort */ }
        } else {
          writeErrors.push(`Failed to write to ${promo.file}/${promo.section}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeErrors.push(`Write error for ${promo.file}: ${msg}`);
        logger.error({ error: msg, file: promo.file }, "Failed to promote fact");
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
    if (writeErrors.length > 0) {
      parts.push(`errors: ${writeErrors.join("; ")}`);
    }
    const output = parts.length > 0
      ? `${parts.join(", ")} from ${yesterday}'s log`
      : `No new facts from ${yesterday}'s daily log`;

    return { success: true, output };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Nightly memory processing failed");
    return { success: false, output: "", error: msg };
  }
}
