/**
 * Nightly Memory Processing — Claude Opus 1M fact extraction
 *
 * Reads unprocessed session_summaries from SQLite, extracts promotable facts
 * via Claude Opus (1M context), writes to permanent memory, and requires the
 * full core memory set to be loaded before the model runs.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { z } from "zod";
import { parseSwarmJSON } from "../../executors/model-swarm.js";
import { executeClaudeCommand } from "../../executors/claude.js";
import { buildCondensedContext, extractCurrentGoals, extractActiveProjects } from "../shared-context.js";
import { getRecentJobOutputs } from "../job-outputs.js";
import { logger } from "../../utils/logger.js";
import { getMemoryIndexer } from "../../memory/indexer.js";
import { getCanonicalMemoryService } from "../../memory/canonical-service.js";
import type { StateManager } from "../../state/manager.js";
import { trackPromotion } from "../../outcomes/hooks.js";
import { PATHS } from "../../config/paths.js";

type MemoryFileKey = "me" | "work" | "life" | "preferences" | "tools";

const PERMANENT_FILES: Record<MemoryFileKey, string> = {
  me: PATHS.me,
  work: PATHS.work,
  life: PATHS.life,
  preferences: PATHS.preferences,
  tools: PATHS.tools,
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

function loadRequiredMemoryFiles(): Record<MemoryFileKey, string> {
  const requiredKeys = Object.keys(PERMANENT_FILES) as MemoryFileKey[];
  const missing: string[] = [];
  const contents = {} as Record<MemoryFileKey, string>;

  for (const key of requiredKeys) {
    const path = PERMANENT_FILES[key];
    if (!existsSync(path)) {
      missing.push(`${key}.md`);
      continue;
    }
    contents[key] = readFileSync(path, "utf-8");
  }

  if (missing.length > 0) {
    throw new Error(`Missing required memory files: ${missing.join(", ")}`);
  }

  return contents;
}

// ============================================
// MAIN
// ============================================

export async function runNightlyMemory(stateManager: StateManager): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  // Yesterday label for feedback log and output messages
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const yesterday = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  try {
    // Read unprocessed sessions — queue-based, no date filter
    const sessions = stateManager.getUnprocessedSessionsBatch(50);
    logger.info({ sessionCount: sessions.length }, "Loaded unprocessed sessions for nightly memory");

    // Read yesterday's explicit feedback to include in analysis
    let feedbackLog = "";
    try {
      const feedbackPath = PATHS.feedback;
      if (existsSync(feedbackPath)) {
        const lines = readFileSync(feedbackPath, "utf-8").split("\n");
        const yesterdayFeedback: string[] = [];
        const keepLines: string[] = [];
        let inYesterday = false;
        let lineDateStr = "";

        const keepThreshold = new Date();
        keepThreshold.setDate(keepThreshold.getDate() - 3);
        const y = keepThreshold.getFullYear();
        const m = String(keepThreshold.getMonth() + 1).padStart(2, "0");
        const d = String(keepThreshold.getDate()).padStart(2, "0");
        const keepThresholdStr = `${y}-${m}-${d}`;

        const archiveLines: string[] = [];

        for (const line of lines) {
          if (line.startsWith("### [")) {
            lineDateStr = line.substring(5, 15);
            inYesterday = line.includes(`[${yesterday}`);

            if (inYesterday) yesterdayFeedback.push(line);

            if (lineDateStr >= keepThresholdStr) keepLines.push(line);
            else archiveLines.push(line);
          } else if (inYesterday) {
            yesterdayFeedback.push(line);
            if (lineDateStr >= keepThresholdStr) keepLines.push(line);
            else archiveLines.push(line);
          } else {
             if (lineDateStr >= keepThresholdStr) keepLines.push(line);
             else if (lineDateStr) archiveLines.push(line);
             else keepLines.push(line);
          }
        }

        if (yesterdayFeedback.length > 0) {
          feedbackLog = `\n\n## Explicit User Feedback from Telegram/UI (${yesterday})\n\n` + yesterdayFeedback.join("\n");
          logger.info({ date: yesterday, feedbackLines: yesterdayFeedback.length }, "Loaded yesterday's explicit feedback");
        }

        if (archiveLines.length > 0) {
            writeFileSync(feedbackPath, keepLines.join("\n"), "utf-8");
            try {
              if (!existsSync(PATHS.archive)) mkdirSync(PATHS.archive, { recursive: true });
              appendFileSync(`${PATHS.archive}/feedback-archive.md`, "\n" + archiveLines.join("\n"), "utf-8");
            } catch (err) {
              logger.warn({ error: err }, "Failed to write to feedback archive");
            }
            logger.info({ archivedLines: archiveLines.length }, "Rotated feedback.md to archive");
        }
      }
    } catch (err) {
      logger.warn({ error: err }, "Failed to read feedback log");
    }

    if (sessions.length === 0 && !feedbackLog) {
      return { success: true, output: "No unprocessed sessions or feedback, skipping" };
    }

    const permanentFiles = loadRequiredMemoryFiles();
    logger.info({
      memoryFiles: Object.fromEntries(
        (Object.keys(permanentFiles) as MemoryFileKey[]).map((key) => [key, permanentFiles[key].length])
      ),
    }, "Loaded required memory files for nightly memory");

    // Format sessions as structured blocks grouped by project
    const byProject = new Map<string, string[]>();
    for (const s of sessions) {
      const proj = s.project || "Daemon Events";
      const ts = s.startedAt ?? s.createdAt;
      const time = ts.slice(11, 16) || "00:00";
      const agent = s.agent ?? "unknown";
      const title = s.title ?? "untitled";
      const summary = s.summary ?? "";

      if (!byProject.has(proj)) byProject.set(proj, []);
      byProject.get(proj)!.push(`[${time}] ${agent}: ${title}\n${summary}`);
    }

    const sessionBlocks: string[] = [];
    for (const [proj, entries] of byProject) {
      sessionBlocks.push(`## Project: ${proj}\n${entries.join("\n\n")}`);
    }
    const sessionInput = sessionBlocks.join("\n\n") + feedbackLog;

    const permanentContext = Object.entries(permanentFiles)
      .map(([key, content]) => `## ${key}.md\n\n${content}`)
      .join("\n\n---\n\n");

    const [condensedContext, goals, projects] = await Promise.all([
      buildCondensedContext(),
      extractCurrentGoals(),
      extractActiveProjects(),
    ]);

    const recentActivity = getRecentJobOutputs(stateManager.getDb());

    const unifiedPrompt = `You are a memory processing engine for Yanqing's personal AI assistant. Analyze yesterday's session summaries, cross-reference against permanent memory files, and extract promotable facts.

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

## Session Summaries (${yesterday})

${sessionInput.length > 80000 ? sessionInput.slice(0, 80000) + "\n\n... (truncated) ..." : sessionInput}

## Output Format

Return ONLY a valid JSON object (no markdown, no preamble):
{"promotions": [{"content": "fact to promote", "file": "me"|"work"|"life"|"preferences"|"tools", "section": "Section Name"}]}

If nothing to promote, use an empty array.`;

    logger.info({
      promptLength: unifiedPrompt.length,
      date: yesterday,
      sessionCount: sessions.length,
      executor: "claude",
      model: "opus[1m]",
    }, "Running nightly memory via Claude Opus 1M");

    const result = await executeClaudeCommand(
      unifiedPrompt + "\n\nReturn ONLY valid JSON, no markdown fences.",
      {
        cwd: process.env.HOME ?? "/Users/yj",
        model: "opus[1m]",
        timeout: 600_000, // 10 min — large context with all memory files
      },
    );

    if (result.exitCode !== 0 || !result.output) {
      return { success: false, output: "", error: `Codex error: ${(result.output ?? "").slice(0, 200)}` };
    }

    // Valid empty responses (e.g. [] or {"promotions":[]}) are not errors
    const trimmed = result.output.trim();
    if (trimmed === "[]" || trimmed === '{"promotions":[]}') {
      // Mark sessions as processed — they were analyzed, just nothing to promote
      const sessionIds = sessions.map(s => s.id);
      if (sessionIds.length > 0) stateManager.markSessionsProcessed(sessionIds);
      return { success: true, output: `No promotable facts from ${yesterday} (${sessions.length} sessions analyzed)` };
    }

    const consolidated = result.output;

    // Parse and validate
    let promotions: z.infer<typeof PromotionsArraySchema>;

    try {
      const nightlyOutput = parseSwarmJSON(consolidated, NightlyOutputSchema);
      promotions = nightlyOutput.promotions ?? [];
    } catch {
      try {
        promotions = parseSwarmJSON(consolidated, PromotionsArraySchema);
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        logger.error({ error: msg, rawOutput: consolidated.slice(0, 500) }, "Failed to parse nightly memory output");
        // Leave sessions unprocessed for retry
        return { success: false, output: "", error: `Nightly output parse failed: ${msg}` };
      }
    }

    // Snapshot target files before promotion writes
    const snapshotTargets = new Set(promotions.map(p => p.file));
    for (const target of snapshotTargets) {
      const filePath = PERMANENT_FILES[target];
      if (!filePath || !existsSync(filePath)) continue;
      try {
        const content = readFileSync(filePath, "utf-8");
        stateManager.snapshotMemoryFile(`${target}.md`, content, "pre-promotion");
      } catch (snapErr) {
        logger.warn({ error: snapErr, file: target }, "Failed to snapshot before promotion");
      }
    }

    // Write promotions via CanonicalMemoryService
    const canonicalMemory = getCanonicalMemoryService(stateManager, getMemoryIndexer());
    let writtenPromos = 0;
    const writeErrors: string[] = [];

    for (const promo of promotions) {
      const filePath = PERMANENT_FILES[promo.file];
      if (!filePath) {
        writeErrors.push(`Unknown target file: ${promo.file}`);
        continue;
      }

      try {
        const ok = await canonicalMemory.promoteToFile(promo.content, promo.file, promo.section, "nightly");
        if (ok) {
          writtenPromos++;
          logger.info({ file: promo.file, section: promo.section, content: promo.content.slice(0, 80) }, "Promoted fact to permanent memory");
          try {
            trackPromotion(stateManager.getDb(), promo.content.slice(0, 80), promo.file);
          } catch { /* outcome tracking best-effort */ }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeErrors.push(`Write error for ${promo.file}: ${msg}`);
        logger.error({ error: msg, file: promo.file }, "Failed to promote fact");
      }
    }

    // Mark sessions as processed only if no write errors (allows retry on failure)
    if (writeErrors.length === 0) {
      const sessionIds = sessions.map(s => s.id);
      if (sessionIds.length > 0) {
        const marked = stateManager.markSessionsProcessed(sessionIds);
        logger.info({ marked, total: sessionIds.length }, "Marked sessions as processed for promotion");
      }
    } else {
      logger.warn({ writeErrors: writeErrors.length }, "Skipping processed mark — write errors occurred, sessions will be retried");
    }

    // Dirty flags for reindex/embeddings/context_bridge/git_commit are set by
    // canonicalMemory.promoteToFile() — no inline reindex or markContextBridgeDirty needed.

    const parts: string[] = [];
    if (writtenPromos > 0 || promotions.length > 0) {
      parts.push(`Promoted ${writtenPromos}/${promotions.length} facts`);
    }
    parts.push(`${sessions.length} sessions processed`);
    if (writeErrors.length > 0) {
      parts.push(`errors: ${writeErrors.join("; ")}`);
    }
    // ── Nightly maintenance: purge old executor feedback, archive stale skills ──
    try {
      const { purgeOldFeedback } = await import("../../executors/router.js");
      const purged = purgeOldFeedback();
      if (purged > 0) {
        logger.info({ purged }, "Purged old executor feedback records (>90 days)");
        parts.push(`purged ${purged} old feedback records`);
      }
    } catch (err) {
      logger.debug({ error: err }, "Executor feedback purge skipped");
    }

    try {
      // Archive skills inactive for >30 days
      const archiveRows = stateManager.getDb().prepare(`
        SELECT id FROM skills_catalog
        WHERE status = 'active'
          AND (last_used_at IS NULL OR last_used_at < datetime('now', '-30 days'))
      `).all() as Array<{ id: string }>;
      if (archiveRows.length > 0) {
        const cms = getCanonicalMemoryService(stateManager, getMemoryIndexer());
        let archived = 0;
        for (const row of archiveRows) {
          if (cms.archiveSkill(row.id)) archived++;
        }
        if (archived > 0) {
          logger.info({ archived }, "Auto-archived inactive skills (>30 days)");
          parts.push(`archived ${archived} stale skills`);
        }
      }
    } catch (err) {
      logger.debug({ error: err }, "Skill auto-archive skipped");
    }

    // Cleanup old run events (7 day retention)
    try {
      const cleaned = stateManager.cleanupOldRunEvents(7);
      if (cleaned > 0) {
        logger.info({ cleaned }, "Cleaned up old run events");
        parts.push(`cleaned ${cleaned} old run events`);
      }
    } catch (err) {
      logger.warn({ error: err }, "Run event cleanup failed");
    }

    const output = parts.length > 0
      ? `${parts.join(", ")} from ${yesterday}`
      : `No new facts from ${yesterday}`;

    return { success: true, output };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Nightly memory processing failed");
    return { success: false, output: "", error: msg };
  }
}
