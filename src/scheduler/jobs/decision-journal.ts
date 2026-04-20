/**
 * Decision Journal — Extracts significant decisions from recent session summaries.
 *
 * Inspired by Huryn's "Decision Journal" pattern: before making a decision,
 * check if a prior decision exists. If not, log the full context.
 *
 * Writes structured decision files to ~/memory/decisions/ so Homer can
 * reference past reasoning when proposing changes or answering "why did we do X?"
 *
 * Schedule: After session-summaries (triggered downstream)
 * Executor: Internal (Gemini Flash for extraction)
 */

// @ts-ignore
import type Database from "better-sqlite3";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { executeFlashViaOpenCode } from "../../executors/gemini.js";
import { logger } from "../../utils/logger.js";
import { PATHS } from "../../config/paths.js";

const DECISIONS_DIR = join(PATHS.memory, "decisions");
const MAX_EXISTING_CONTEXT = 2000; // chars of existing decision titles to pass

interface DecisionEntry {
  decision: string;
  context: string;
  alternatives: string;
  reasoning: string;
  tradeoffs: string;
  area: string;
}

export async function runDecisionJournal(
  _db: Database.Database,
  _jobRunId?: number,
  _signal?: AbortSignal,
): Promise<{ success: boolean; output: string; error?: string }> {
  try {
    mkdirSync(DECISIONS_DIR, { recursive: true });

    // Load today's daily log
    const today = new Date().toISOString().slice(0, 10);
    const dailyLogPath = join(PATHS.daily, `${today}.md`);
    if (!existsSync(dailyLogPath)) {
      return { success: true, output: "No daily log yet for today. Skipping." };
    }

    const dailyLog = readFileSync(dailyLogPath, "utf-8");
    if (dailyLog.length < 200) {
      return { success: true, output: "Daily log too short for decision extraction." };
    }

    // Load existing decision titles to avoid duplicates
    let existingTitles = "";
    try {
      const files = readdirSync(DECISIONS_DIR).filter(f => f.endsWith(".md"));
      existingTitles = files
        .map(f => f.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, "").replace(/-/g, " "))
        .join("\n")
        .slice(0, MAX_EXISTING_CONTEXT);
    } catch { /* empty dir */ }

    // Ask Flash to extract decisions
    const prompt = `You are analyzing a daily activity summary to extract SIGNIFICANT decisions.

A "significant decision" is a choice that:
- Affects architecture, strategy, tooling, or workflow
- Would be worth explaining to someone asking "why did we do it this way?"
- Is NOT a routine task completion or status update

## Today's Activity Summary
${dailyLog.slice(0, 8000)}

## Existing Decisions (avoid duplicates)
${existingTitles || "(none yet)"}

Extract 0-3 significant decisions from today. If there are no significant decisions, return an empty JSON array.

Return ONLY a JSON array:
[
  {
    "decision": "What was decided (1 sentence)",
    "context": "Why this came up",
    "alternatives": "What else was considered",
    "reasoning": "Why this option won",
    "tradeoffs": "What was given up",
    "area": "architecture|strategy|tooling|workflow|data|process"
  }
]

Return [] if no significant decisions were made today.`;

    const result = await executeFlashViaOpenCode(prompt, { timeout: 900_000 });

    if (result.exitCode !== 0) {
      return { success: false, output: "", error: `Flash extraction failed: ${result.output.slice(0, 200)}` };
    }

    // Parse decisions
    let decisions: DecisionEntry[] = [];
    try {
      const jsonMatch = result.output.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        decisions = JSON.parse(jsonMatch[0]);
      }
    } catch (err) {
      logger.warn({ error: err }, "Failed to parse decision extraction JSON");
      return { success: true, output: "No parseable decisions extracted." };
    }

    if (!Array.isArray(decisions) || decisions.length === 0) {
      return { success: true, output: "No significant decisions found today." };
    }

    // Write decision files
    const written: string[] = [];
    for (const d of decisions) {
      if (!d.decision || !d.reasoning) continue;

      const slug = d.decision
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60);
      const filename = `${today}-${slug}.md`;
      const filepath = join(DECISIONS_DIR, filename);

      if (existsSync(filepath)) continue; // don't overwrite

      const content = `# ${d.decision}

**Date:** ${today}
**Area:** ${d.area || "general"}

## Context
${d.context || "N/A"}

## Alternatives Considered
${d.alternatives || "N/A"}

## Reasoning
${d.reasoning}

## Trade-offs Accepted
${d.tradeoffs || "N/A"}
`;

      writeFileSync(filepath, content);
      written.push(filename);
      logger.info({ filename, area: d.area }, "Decision journal entry written");
    }

    if (written.length === 0) {
      return { success: true, output: "Decisions extracted but all were duplicates." };
    }

    return {
      success: true,
      output: `Decision journal: ${written.length} entries written (${written.join(", ")})`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Decision journal extraction failed");
    return { success: false, output: "", error: msg };
  }
}
