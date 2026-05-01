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
import { hasMigration } from "../../state/migrations/index.js";
import { insertCandidate, approveCandidate, expireStaleCandidates, getPendingCandidates } from "../../memory/claims.js";
import type { ClaimType, TargetFile } from "../../memory/claims.js";
import { wouldConflict } from "../../memory/conflict-detection.js";
import { redactForLLM } from "../../memory/secret-filter.js";

// Phase 0.9: nightly-memory writes only to the core "profile" subset. Keys are
// hard-coded narrow literals so TS treats PERMANENT_FILES[key] as guaranteed
// under noUncheckedIndexedAccess. Keep aligned with memory/registry.ts.
type MemoryFileKey = "me" | "work" | "preferences" | "tools";
const MEMORY_FILE_KEYS = ["me", "work", "preferences", "tools"] as const;

const PERMANENT_FILES = {
  me: PATHS.me,
  work: PATHS.work,
  preferences: PATHS.preferences,
  tools: PATHS.tools,
} as const satisfies Record<MemoryFileKey, string>;

// ============================================
// SCHEMAS
// ============================================

const CLAIM_TYPES = [
  "fact",
  "decision",
  "preference",
  "hypothesis",
  "insight",
  "commitment",
  "question",
  "lesson",
] as const;

const PromotionSchema = z.object({
  content: z.string().min(10),
  file: z.enum(MEMORY_FILE_KEYS),
  section: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.5),
  claim_type: z.enum(CLAIM_TYPES).default("fact"),
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

## Extract Promotable Facts (2-5 max)

A "promotable fact" is genuinely novel information worth persisting in permanent memory. Quality over quantity — only extract facts that would be missed if not captured now.

COVERAGE PRIORITY (extract in this order):
1. **Work decisions & project status** — outcomes, milestones, blockers, pivots → work.md
2. **People & org dynamics** — who said what, relationships, power dynamics, roles → work.md
3. **Strategic insights** — career positioning, competitive moves, narrative framing → me.md or work.md
4. **Preferences expressed** — PAY SPECIAL ATTENTION to Explicit User Feedback. If Yanqing archived something with specific notes, extract as a new rule → preferences.md
5. **Tool configurations** — only if genuinely new configs/subscriptions changed → tools.md

BIAS CORRECTION: The system currently over-indexes on tools (36%) and preferences (37%). Actively prioritize work, people, and project facts. Only extract tool/preference facts if nothing else is promotable.

For each fact, classify which file it belongs to:
- me: identity, goals, ambitions, personal milestones, routines, life context
- work: career, projects, professional contacts, positioning
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
{"promotions": [{"content": "fact to promote", "file": "me"|"work"|"preferences"|"tools", "section": "Section Name", "confidence": 0.8, "claim_type": "fact"}]}

Each promotion MUST include:
- "confidence": 0.0-1.0 — meaning is calibrated against this rubric:

  • **0.95–1.00 (auto-approve eligible)** — explicit, unambiguous, written by Yanqing in the session.
    Example: "I just got the B3 promotion at P&G, effective May 1." → 0.97
    Example: "Decided to use ClickHouse over DuckDB for ProfitSphere." → 0.96
    Use only when the session text contains this fact essentially verbatim.

  • **0.70–0.94 (queue for HITL review)** — clear from context, but inferred or paraphrased.
    Example: Session shows multiple references to "the new analytics copilot" → "Yanqing renamed Next-Gen Analytics Copilot to NA DCOM Intelligence" → 0.85
    Use when you're confident in the fact but had to assemble it from multiple turns.

  • **0.40–0.69 (queue for HITL, low priority)** — plausible but ambiguous, single mention, hedged language.
    Example: "I'm thinking about pivoting MAHORAGA to options" → "Yanqing is considering MAHORAGA pivot to options" → 0.55
    Use when the session signals an idea or direction, not a commitment.

  • **0.20–0.39 (will be queued but likely rejected)** — speculation, off-hand mention, low signal.
    Example: A passing reference to "maybe trying Cursor" → 0.30

  • **< 0.20 (silently dropped — do not return)** — chatter, jokes, framing without substance.
    Do not emit promotions in this band; the daemon discards them.

  When in doubt, calibrate down — the cost of a missed fact is one Telegram review next session;
  the cost of a confident wrong fact is corrupted canonical memory.

- "claim_type": one of "fact"|"decision"|"preference"|"hypothesis"|"insight"|"commitment"|"question"|"lesson"
  - fact: objective information worth persisting
  - decision: a choice made (outcome can be checked later)
  - preference: expressed preference or style choice
  - hypothesis: unverified belief to test — can be invalidated by future evidence
  - insight: derived understanding or pattern recognition (not a raw fact; a synthesis)
  - commitment: explicit promise to do X by Y (outcome is binary — kept or broken)
  - question: open question worth tracking until answered
  - lesson: learned the hard way — surface proactively next time

If nothing to promote, use an empty array.`;

    logger.info({
      promptLength: unifiedPrompt.length,
      date: yesterday,
      sessionCount: sessions.length,
      executor: "claude",
      model: "opus[1m]",
    }, "Running nightly memory via Claude Opus 1M");

    // Phase 0.6: redact secrets from the prompt before sending to LLM.
    // Session transcripts and daily logs can embed API keys, env exports, etc.
    const safePrompt = redactForLLM(unifiedPrompt, "nightly-memory");

    const result = await executeClaudeCommand(
      safePrompt + "\n\nReturn ONLY valid JSON, no markdown fences.",
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

    const db = stateManager.getDb();
    if (!hasMigration(db, "069_knowledge_claims.sql")) {
      return { success: false, output: "", error: "knowledge_claims migration missing — HITL pipeline cannot run" };
    }

    const canonicalMemory = getCanonicalMemoryService(stateManager, getMemoryIndexer());
    let writtenPromos = 0;
    let candidatesCreated = 0;
    const writeErrors: string[] = [];
    const sessionIds = sessions.map(s => s.id);

    let autoApprovedCount = 0;
    let autoRejectedCount = 0;
    let conflictDeferredCount = 0;

    // Confidence-based routing (HITL is permanent):
    //   >= 0.95       → auto-approve (write directly, no Telegram prompt)
    //   0.20 … 0.95   → HITL (queue as candidate, user reviews on Telegram)
    //   < 0.20        → silently drop as noise
    for (const promo of promotions) {
      const confidence = promo.confidence ?? 0.5;

      if (confidence < 0.20) {
        autoRejectedCount++;
        logger.debug({ file: promo.file, confidence, content: promo.content.slice(0, 60) }, "Dropped as noise (confidence < 0.20)");
        continue;
      }

      try {
        const claimId = insertCandidate(db, {
          content: promo.content,
          targetFile: promo.file as TargetFile,
          section: promo.section,
          claimType: (promo.claim_type ?? "fact") as ClaimType,
          confidence,
          sessionIds,
          originChannel: "nightly-extractor",
        });

        if (claimId && confidence >= 0.95) {
          // Conflict guard: don't auto-approve if memory already has a near-duplicate.
          // Forces HITL when the new claim looks like it might be contradicting (or restating)
          // something already canonicalized — the kind of mistake calibration alone can't catch.
          const conflict = await wouldConflict(promo.content, promo.file, getMemoryIndexer());
          if (conflict.conflict) {
            conflictDeferredCount++;
            candidatesCreated++;
            logger.info(
              { file: promo.file, confidence, reason: conflict.reason, neighborScore: conflict.neighborScore, content: promo.content.slice(0, 60) },
              "Auto-approve deferred to HITL by conflict guard",
            );
          } else {
            const ok = await approveCandidate(db, claimId, canonicalMemory);
            if (ok) {
              db.prepare(`UPDATE knowledge_claims SET decided_by = 'auto-approve' WHERE id = ?`).run(claimId);
              autoApprovedCount++;
              writtenPromos++;
              logger.info({ file: promo.file, confidence, content: promo.content.slice(0, 60) }, "Auto-approved high-confidence claim");
              try {
                trackPromotion(db, promo.content.slice(0, 80), promo.file);
              } catch { /* outcome tracking best-effort */ }
            }
          }
        } else if (claimId) {
          candidatesCreated++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeErrors.push(`Candidate insert error for ${promo.file}: ${msg}`);
        logger.error({ error: msg, file: promo.file }, "Failed to insert candidate");
      }
    }

    // Queue health alert: surface backlog in job output (no auto-approve bypass).
    // HITL is permanent — review on Telegram, the daemon never silently approves.
    let backlogWarning: string | null = null;
    try {
      const pending = getPendingCandidates(db, 1);
      if (pending.length > 0) {
        const oldest = pending[0]!;
        const oldestAge = (Date.now() - new Date(oldest.createdAt).getTime()) / 86400000;
        const totalPending = db.prepare(
          "SELECT COUNT(*) as c FROM knowledge_claims WHERE status = 'candidate'"
        ).get() as { c: number };

        if (totalPending.c > 50 || oldestAge > 14) {
          backlogWarning = `⚠️ Memory review backlog: ${totalPending.c} pending, oldest ${Math.round(oldestAge)}d. Run /memory pending on Telegram.`;
          logger.warn({ queueSize: totalPending.c, oldestAgeDays: Math.round(oldestAge) }, "Memory review backlog above threshold");
        }
      }
    } catch (err) {
      logger.debug({ error: err }, "Queue health check skipped");
    }

    // Expire stale candidates (>7 days)
    try {
      expireStaleCandidates(db, 7);
    } catch { /* best-effort */ }

    logger.info({ candidatesCreated, autoApprovedCount, autoRejectedCount, promotions: promotions.length }, "HITL: processed promotions");

    // Mark sessions as processed only if no write errors (allows retry on failure)
    if (writeErrors.length === 0) {
      if (sessionIds.length > 0) {
        const marked = stateManager.markSessionsProcessed(sessionIds);
        logger.info({ marked, total: sessionIds.length }, "Marked sessions as processed for promotion");
      }
    } else {
      logger.warn({ writeErrors: writeErrors.length }, "Skipping processed mark — write errors occurred, sessions will be retried");
    }

    // Dirty flags for reindex/embeddings/git_commit are set by
    // canonicalMemory.promoteToFile() — no inline reindex needed.

    const parts: string[] = [];
    if (candidatesCreated > 0) {
      parts.push(`${candidatesCreated} candidates queued for review`);
    }
    if (autoApprovedCount > 0) {
      parts.push(`${autoApprovedCount} auto-approved (confidence >= 0.95)`);
    }
    if (autoRejectedCount > 0) {
      parts.push(`${autoRejectedCount} dropped as noise (confidence < 0.20)`);
    }
    if (conflictDeferredCount > 0) {
      parts.push(`${conflictDeferredCount} deferred to HITL by conflict guard`);
    }
    if (writtenPromos > 0) {
      parts.push(`Promoted ${writtenPromos}/${promotions.length} facts`);
    }
    parts.push(`${sessions.length} sessions processed`);
    if (writeErrors.length > 0) {
      parts.push(`errors: ${writeErrors.join("; ")}`);
    }
    if (backlogWarning) {
      parts.push(backlogWarning);
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
      const { purgeOldTraces } = await import("../../executors/trace-writer.js");
      const purgedTraces = purgeOldTraces(stateManager.getDb());
      if (purgedTraces > 0) {
        logger.info({ purged: purgedTraces }, "Purged old execution traces (>90 days)");
        parts.push(`purged ${purgedTraces} old traces`);
      }
    } catch (err) {
      logger.debug({ error: err }, "Execution trace purge skipped");
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

    // ── Consolidated post-processing (absorbed from standalone jobs) ──

    // 1. Preference updater (was preference-updater job at 3:45 AM)
    try {
      const { runPreferenceUpdater } = await import("./preference-updater.js");
      const prefResult = await runPreferenceUpdater(db);
      if (prefResult.success) {
        logger.info("Preference model updated (post-nightly)");
        parts.push("preferences updated");
      }
    } catch (err) {
      logger.debug({ error: err }, "Preference update skipped (post-nightly)");
    }

    // 2. Memory reindex (was memory-reindex job at 4:00 AM)
    try {
      const { runMemoryReindex } = await import("./memory-reindex.js");
      const reindexResult = await runMemoryReindex(stateManager);
      if (reindexResult.success) {
        logger.info("Memory reindex completed (post-nightly)");
        parts.push("reindexed");
      }
    } catch (err) {
      logger.debug({ error: err }, "Memory reindex skipped (post-nightly)");
    }

    // 3. Memory embeddings (was memory-embeddings job at 4:05 AM)
    try {
      const { runMemoryEmbeddings } = await import("./memory-embeddings.js");
      const embedResult = await runMemoryEmbeddings(stateManager);
      if (embedResult.success) {
        logger.info("Memory embeddings generated (post-nightly)");
        parts.push("embeddings updated");
      }
    } catch (err) {
      logger.debug({ error: err }, "Memory embeddings skipped (post-nightly)");
    }

    // 4. Regenerate session-bootstrap.md projection from current me.md/work.md
    try {
      const { generateBootstrap } = await import("../../memory/session-bootstrap.js");
      const { bytes } = await generateBootstrap();
      logger.info({ bytes }, "Session bootstrap regenerated (post-nightly)");
      parts.push("bootstrap regenerated");
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, "Session bootstrap regen skipped (post-nightly)");
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
