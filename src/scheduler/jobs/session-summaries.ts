/**
 * Daily Session Summary — Gemini API handler
 *
 * Reads today's daily log, builds full Yanqing context dynamically
 * (soul, identity, career, tools, architecture, preferences),
 * sends to Gemini API for personalized summarization,
 * and rewrites the daily log to summary-only.
 *
 * No hardcoded bios or frozen goals — reads live memory files every run.
 */

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { executeGeminiAPI } from "../../executors/gemini.js";
import { logger } from "../../utils/logger.js";
import { getMemoryIndexer } from "../../memory/indexer.js";
import { StateManager } from "../../state/manager.js";
import { buildSchedulerContext, extractCurrentGoals } from "../shared-context.js";

const DAILY_LOG_DIR = "/Users/yj/memory/daily";
const MAX_INPUT_CHARS = 900_000; // ~225K tokens, well within 1M context

function getTodayDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const DB_PATH = "/Users/yj/homer/data/homer.db";

async function buildUserPrompt(): Promise<string> {
  const goals = await extractCurrentGoals();

  return `You've been with Yanqing all day. What happened that matters for where he's headed?

The daily log below contains RAW session transcripts between Yanqing and Claude Code (his primary CLI). Pay close attention to:
- **What Yanqing asked** — his questions reveal what's on his mind, what he's unsure about, what he's exploring
- **What Yanqing chose** — when given options, which did he pick and why?
- **What Yanqing corrected** — when he interrupted or redirected, that's a preference signal
- **What Yanqing's tone was** — frustrated? excited? rapid-fire? contemplative?
- **What preferences emerged** — technical choices, workflow patterns, architectural opinions
- **What he told HOMER to do vs. what he did himself** — trust boundaries and delegation patterns

## Structure

### Progress on Goals
Map today's work to Yanqing's actual goals. For each active goal that got attention today:
- What moved forward, with specific details (file paths, numbers, concrete artifacts created)
- What's the next concrete step
- How much time/sessions were spent on this vs other goals

Current goals from me.md:
${goals}

### Yanqing's Voice Today
This is the most important section. Capture what Yanqing actually said and decided:
- **Questions he asked** — quote or paraphrase his actual questions to Claude Code
- **Preferences expressed** — any technical choices, workflow preferences, or opinions he stated
- **Corrections & redirects** — moments where he course-corrected the AI or changed direction
- **Frustrations** — what annoyed him? What broke? What took too long?
- **Wins** — what made him satisfied? What worked well?

### Key Decisions & Why
Not just "decided X" but WHY it matters in context. Connect decisions to goals. Include the reasoning Yanqing expressed or that's implied by his choices.

### Technical Details
Specific artifacts, with fidelity:
- Files created/modified (paths)
- Commands run, tools tested, APIs wired
- Architecture choices and their rationale
- Numbers: token counts, durations, file sizes, costs — whatever was measured

### What Got Stuck
Blockers, framed as: what needs to happen next to unblock? Who/what is the dependency? Include error messages or failure modes if they appeared.

### Context for Tomorrow
Things Yanqing needs to know to resume efficiently:
- Open threads, pending responses, half-finished work
- State of running experiments or deployments
- Any time-sensitive items (deadlines, meetings, personal events)

### HOMER's Take
2-3 sentences. Be honest and opinionated:
- Is Yanqing spending time on the right things relative to his goals?
- Was today focused or scattered? Building or firefighting? High-leverage or yak-shaving?
- Any pattern worth noting? Any risk HOMER sees that Yanqing might not?
- What's the single highest-leverage thing for tomorrow?

You know Homer's architecture now. If HOMER work happened today, assess whether it was high-leverage (new capability, reliability improvement) or yak-shaving (cosmetic changes, over-engineering).

## Rules
- Write in second person ("You did X", "Your trading system...")
- **Be specific** — names, numbers, file paths, exact error messages, concrete details. Fidelity matters.
- **Quote Yanqing** when his words reveal preferences or decisions
- No generic platitudes. No "great progress!" without evidence
- If something didn't happen today, don't mention it
- Skip sessions that were just HOMER maintenance unless they produced a meaningful capability
- Output ONLY the summary content (no preamble)
- Use markdown formatting with ## Daily Summary as the top heading`;
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

  if (!existsSync(logPath)) {
    return { success: true, output: `No daily log found for ${date}, skipping` };
  }

  const content = await readFile(logPath, "utf-8");

  // Always archive raw content to SQLite FIRST — even if summary already exists.
  // This prevents data loss when something adds "## Daily Summary" before session-summaries runs.
  const sm = stateManager ?? new StateManager(DB_PATH);
  const ownedSm = !stateManager;
  try {
    sm.archiveDailyLog(date, content);
    logger.info({ date, sizeKB: Math.round(content.length / 1024) }, "Raw daily log archived to SQLite");
  } catch (archiveErr) {
    // If archive fails, abort — do NOT continue to strip the .md or raw data is permanently lost
    const msg = archiveErr instanceof Error ? archiveErr.message : String(archiveErr);
    logger.error({ error: msg, date }, "Failed to archive raw daily log — aborting to preserve raw content");
    if (ownedSm) sm.close();
    return { success: false, output: "", error: `Archive failed: ${msg}` };
  }

  // Check if summary already appended (AFTER archiving raw content)
  if (content.includes("## Daily Summary")) {
    if (ownedSm) sm.close();
    return { success: true, output: `Daily summary already exists for ${date}, skipping (raw archived)` };
  }

  // Build dynamic context — no hardcoded bio, reads live files
  let systemPrompt: string;
  try {
    systemPrompt = await buildSchedulerContext({ dailyLogDays: 0 });
  } catch (ctxErr) {
    const msg = ctxErr instanceof Error ? ctxErr.message : String(ctxErr);
    logger.error({ error: msg }, "Failed to build scheduler context");
    if (ownedSm) sm.close();
    return { success: false, output: "", error: msg };
  }

  logger.info({ date, logPath, sizeKB: Math.round(content.length / 1024) }, "Running session summary via Gemini API");

  // Truncate if extremely large
  const inputContent = content.length > MAX_INPUT_CHARS
    ? content.slice(-MAX_INPUT_CHARS)
    : content;

  const truncated = content.length > MAX_INPUT_CHARS;
  const truncateNote = truncated
    ? `\n\n(Note: Log was ${Math.round(content.length / 1024)}KB, truncated to last ${Math.round(MAX_INPUT_CHARS / 1024)}KB)`
    : "";

  // Build the user prompt with dynamic goals
  const userPrompt = await buildUserPrompt();
  const fullPrompt = `${userPrompt}\n\n---\n\n# Daily Log: ${date}\n\n${inputContent}`;

  try {
    const result = await executeGeminiAPI(fullPrompt, {
      model: "gemini-3-flash-preview",
      systemPrompt,
      maxTokens: 12288,
      temperature: 0.3,
      timeout: 180000,
      reasoningEffort: "high",
      useGrounding: false,
    });

    if (result.exitCode !== 0) {
      return { success: false, output: "", error: `Gemini API error: ${result.output}` };
    }

    const summaryText = result.output.trim();

    // Rewrite .md to summary-only (strip raw content)
    const summaryBlock = `# ${date}\n\n---\n\n## Daily Summary\n*Generated ${new Date().toLocaleTimeString("en-US", { hour12: false })} by HOMER via Gemini API*${truncateNote}\n\n${summaryText}\n`;

    await writeFile(logPath, summaryBlock, "utf-8");

    // Record that we stripped the file
    try {
      sm.markDailyLogStripped(date, summaryText);
    } catch (markErr) {
      logger.warn({ error: markErr, date }, "Failed to mark daily log as stripped");
    }

    // Reindex the now-smaller .md file
    try {
      const indexer = getMemoryIndexer();
      await indexer.indexFile(logPath, "general", date);
    } catch (indexErr) {
      logger.warn({ error: indexErr, date }, "Failed to reindex stripped daily log");
    }

    const tokenInfo = result.inputTokens
      ? ` (${result.inputTokens} in / ${result.outputTokens} out tokens)`
      : "";

    const rawSizeKB = Math.round(content.length / 1024);
    const newSizeKB = Math.round(summaryBlock.length / 1024);

    logger.info(
      { date, duration: result.duration, inputTokens: result.inputTokens, outputTokens: result.outputTokens, rawSizeKB, newSizeKB },
      "Session summary: raw archived, .md stripped to summary-only"
    );

    return {
      success: true,
      output: `Summary for ${date}.md in ${Math.round(result.duration / 1000)}s${tokenInfo} — raw archived (${rawSizeKB}KB → ${newSizeKB}KB)`,
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
