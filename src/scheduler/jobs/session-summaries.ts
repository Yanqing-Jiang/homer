/**
 * Daily Session Summary — Gemini API handler
 *
 * Now reads from two sources:
 * 1. session_summaries table (pre-summarized CLI sessions from session-harvester)
 * 2. Daily log file (daemon outputs, personal notes — no longer contains raw transcripts)
 *
 * Generates a combined daily narrative, archives raw log to SQLite,
 * and rewrites the .md to summary-only.
 */

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { executeGeminiAPI } from "../../executors/gemini.js";
import { logger } from "../../utils/logger.js";
import { getMemoryIndexer } from "../../memory/indexer.js";
import { StateManager } from "../../state/manager.js";
import { buildSchedulerContext, extractCurrentGoals } from "../shared-context.js";

const DAILY_LOG_DIR = "/Users/yj/memory/daily";
const MAX_INPUT_CHARS = 900_000;

function getTodayDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const DB_PATH = "/Users/yj/homer/data/homer.db";

interface SessionSummaryRow {
  id: string;
  agent: string;
  title: string;
  summary: string;
  project: string | null;
  model: string | null;
  message_count: number;
  started_at: string | null;
  ended_at: string | null;
}

/**
 * Load today's pre-summarized sessions from session_summaries table
 */
function loadSessionSummaries(db: ReturnType<StateManager["getDb"]>, date: string): SessionSummaryRow[] {
  // Compute next day for range query (avoids date() wrapper which defeats indexes)
  const nextDay = new Date(date + "T00:00:00");
  nextDay.setDate(nextDay.getDate() + 1);
  const nextDayStr = nextDay.toISOString().slice(0, 10);
  try {
    return db.prepare(`
      SELECT id, agent, title, summary, project, model, message_count, started_at, ended_at
      FROM session_summaries
      WHERE (started_at >= ? AND started_at < ?)
         OR (ended_at >= ? AND ended_at < ?)
         OR (created_at >= ? AND created_at < ?)
      ORDER BY started_at ASC
    `).all(date, nextDayStr, date, nextDayStr, date, nextDayStr) as SessionSummaryRow[];
  } catch {
    // Table may not exist yet
    return [];
  }
}

/**
 * Format session summaries into a structured text block for the narrative prompt
 */
function formatSessionsForPrompt(sessions: SessionSummaryRow[]): string {
  if (sessions.length === 0) return "";

  let text = "## CLI Sessions (Pre-Summarized)\n\n";
  for (const s of sessions) {
    const time = s.started_at ? new Date(s.started_at).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" }) : "?";
    text += `### [${time}] ${s.agent}: ${s.title}\n`;
    text += `- Model: ${s.model || "unknown"} | Messages: ${s.message_count}`;
    if (s.project) text += ` | Project: ${s.project}`;
    text += `\n`;
    text += `${s.summary}\n\n`;
  }
  return text;
}

async function buildUserPrompt(sessionCount: number): Promise<string> {
  const goals = await extractCurrentGoals();

  return `You've been with Yanqing all day. What happened that matters for where he's headed?

Below you'll find TWO sources of data:
1. **CLI Sessions** — pre-summarized bullet points from all CLI tools (Claude Code, Codex, Gemini, Kimi, OpenCode)
2. **Daily Log** — daemon outputs, scheduled job results, and personal notes

Pay close attention to:
- **What Yanqing worked on** — connect sessions to goals
- **Key decisions** — architectural choices, tool preferences, workflow changes
- **What got stuck** — blockers, errors, failed experiments
- **Patterns** — was the day focused or scattered?

## Structure

### Progress on Goals
Map today's work to Yanqing's actual goals. For each active goal that got attention today:
- What moved forward, with specific details (file paths, numbers, concrete artifacts created)
- What's the next concrete step

Current goals from me.md:
${goals}

### Yanqing's Voice Today
Capture what the session summaries reveal about Yanqing's intent and decisions:
- **Questions & explorations** — what was he investigating?
- **Preferences expressed** — technical choices, workflow patterns
- **Wins** — what worked well?

### Key Decisions & Why
Not just "decided X" but WHY it matters in context. Connect decisions to goals.

### Technical Details
Specific artifacts:
- Files created/modified (paths)
- Architecture choices and rationale
- Numbers: token counts, durations, costs — whatever was measured

### What Got Stuck
Blockers: what needs to happen next to unblock?

### Context for Tomorrow
Things to know for efficient resumption:
- Open threads, half-finished work
- Time-sensitive items

### HOMER's Take
2-3 sentences. Honest and opinionated:
- Right things relative to goals?
- Focused or scattered? High-leverage or yak-shaving?
- Single highest-leverage thing for tomorrow?

## Rules
- Second person ("You did X")
- **Be specific** — names, numbers, file paths. Fidelity matters.
- No generic platitudes
- If something didn't happen, don't mention it
- Output ONLY the summary content — NO preamble, NO meta-commentary. Do NOT start with phrases like "Perfect!", "Now I have all the information", "Let me analyze", "Based on the data", etc. Jump straight into the ## Daily Summary heading.
- Use markdown with ## Daily Summary as top heading
- Today had ${sessionCount} CLI sessions`;
}

export async function runSessionSummary(
  dateOverride?: string,
  stateManager?: StateManager
): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  const date = dateOverride ?? getTodayDateString();
  const logPath = `${DAILY_LOG_DIR}/${date}.md`;

  const sm = stateManager ?? new StateManager(DB_PATH);
  const ownedSm = !stateManager;

  try {
    // Load pre-summarized sessions from session_summaries table
    const sessions = loadSessionSummaries(sm.getDb(), date);
    const sessionsBlock = formatSessionsForPrompt(sessions);

    // Load daily log (now just daemon outputs, much smaller)
    let dailyLogContent = "";
    if (existsSync(logPath)) {
      dailyLogContent = await readFile(logPath, "utf-8");

      // Always archive raw daily log to SQLite FIRST
      try {
        sm.archiveDailyLog(date, dailyLogContent);
        logger.info({ date, sizeKB: Math.round(dailyLogContent.length / 1024) }, "Raw daily log archived to SQLite");
      } catch (archiveErr) {
        const msg = archiveErr instanceof Error ? archiveErr.message : String(archiveErr);
        logger.error({ error: msg, date }, "Failed to archive raw daily log — aborting");
        return { success: false, output: "", error: `Archive failed: ${msg}` };
      }

      // Check if summary already exists
      if (dailyLogContent.includes("## Daily Summary")) {
        return { success: true, output: `Daily summary already exists for ${date}, skipping (raw archived)` };
      }
    }

    // Nothing to summarize?
    if (sessions.length === 0 && !dailyLogContent.trim()) {
      return { success: true, output: `No sessions or daily log for ${date}, skipping` };
    }

    // Build dynamic context
    let systemPrompt: string;
    try {
      systemPrompt = await buildSchedulerContext({ dailyLogDays: 0 });
    } catch (ctxErr) {
      const msg = ctxErr instanceof Error ? ctxErr.message : String(ctxErr);
      logger.error({ error: msg }, "Failed to build scheduler context");
      return { success: false, output: "", error: msg };
    }

    // Combine session summaries + daily log into input
    let combinedInput = "";
    if (sessionsBlock) {
      combinedInput += sessionsBlock + "\n---\n\n";
    }
    if (dailyLogContent.trim()) {
      combinedInput += `## Daily Log (Daemon Outputs)\n\n${dailyLogContent}`;
    }

    // Truncate if needed
    if (combinedInput.length > MAX_INPUT_CHARS) {
      combinedInput = combinedInput.slice(-MAX_INPUT_CHARS);
    }

    const userPrompt = await buildUserPrompt(sessions.length);
    const fullPrompt = `${userPrompt}\n\n---\n\n# Data for ${date}\n\n${combinedInput}`;

    logger.info(
      { date, sessions: sessions.length, dailyLogKB: Math.round(dailyLogContent.length / 1024) },
      "Running session summary via Gemini API"
    );

    const result = await executeGeminiAPI(fullPrompt, {
      model: "gemini-3-flash-preview",
      systemPrompt,
      temperature: 0.3,
      timeout: 180000,
      reasoningEffort: "high",
      useGrounding: false,
    });

    if (result.exitCode !== 0) {
      return { success: false, output: "", error: `Gemini API error: ${result.output}` };
    }

    const summaryText = result.output.trim();

    // Rewrite .md to summary-only
    const summaryBlock = `# ${date}\n\n---\n\n## Daily Summary\n*Generated ${new Date().toLocaleTimeString("en-US", { hour12: false })} by HOMER via Gemini API (${sessions.length} sessions)*\n\n${summaryText}\n`;

    // Ensure daily log directory exists
    if (!existsSync(logPath)) {
      // Create the file even if there was no daily log — we have session data
    }
    await writeFile(logPath, summaryBlock, "utf-8");

    // Record stripped
    try {
      sm.markDailyLogStripped(date, summaryText);
    } catch (markErr) {
      logger.warn({ error: markErr, date }, "Failed to mark daily log as stripped");
    }

    // Reindex
    try {
      const indexer = getMemoryIndexer();
      await indexer.indexFile(logPath, "general", date);
    } catch (indexErr) {
      logger.warn({ error: indexErr, date }, "Failed to reindex stripped daily log");
    }

    const tokenInfo = result.inputTokens
      ? ` (${result.inputTokens} in / ${result.outputTokens} out tokens)`
      : "";

    logger.info(
      { date, sessions: sessions.length, duration: result.duration, inputTokens: result.inputTokens },
      "Daily narrative generated from session_summaries + daily log"
    );

    return {
      success: true,
      output: `Summary for ${date} in ${Math.round(result.duration / 1000)}s${tokenInfo} — ${sessions.length} sessions + daily log`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message, date }, "Session summary failed");
    return { success: false, output: "", error: message };
  } finally {
    if (ownedSm) {
      sm.close();
    }
  }
}
