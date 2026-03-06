/**
 * Weekly Memory Consolidation — Gemini 3.1 Pro API handler
 *
 * Reads the past 7 days of daily logs + permanent memory files,
 * sends to Gemini 3.1 Pro for cross-day analysis (large context up to 1.8M chars), then:
 * 1. Appends a weekly summary to the current daily log
 * 2. Promotes key facts to permanent memory files
 *
 * No hardcoded bios or frozen goals — reads live memory files every run.
 * Goals, career state, projects all come from me.md/work.md at execution time.
 */

import { readFile, appendFile } from "fs/promises";
import { existsSync } from "fs";
import { executeGeminiAPI } from "../../executors/gemini.js";
import { logger } from "../../utils/logger.js";
import { StateManager, type SessionSummaryRow } from "../../state/manager.js";
import { buildSchedulerContext, buildGoalScoreboard } from "../shared-context.js";
import { PATHS } from "../../config/paths.js";

const DAILY_LOG_DIR = PATHS.daily;

const FILE_PATH_MAP: Record<string, string> = {
  "me.md": PATHS.me,
  "work.md": PATHS.work,
  "life.md": PATHS.life,
  "tools.md": PATHS.tools,
  "preferences.md": PATHS.preferences,
};
const MAX_INPUT_CHARS = 1_800_000; // ~450K tokens, well within 1M context

const PERMANENT_FILES = [
  { path: PATHS.me, label: "me.md (identity, goals, ambition)" },
  { path: PATHS.work, label: "work.md (career, projects, org)" },
  { path: PATHS.life, label: "life.md (personal, routines)" },
  { path: PATHS.tools, label: "tools.md (HOMER config, fixes)" },
  { path: PATHS.preferences, label: "preferences.md" },
] as const;

async function buildConsolidationPrompt(): Promise<string> {
  const goalScoreboard = await buildGoalScoreboard();

  return `You know Yanqing's goals, his trajectory, and what he did this week. What moved the needle? What didn't? Where's the gap between where he's spending time and where he says he wants to go?

Produce two outputs.

## PART 1: Weekly Summary

Write this as HOMER addressing Yanqing directly ("you", "your"). Be specific and detailed — fidelity matters.

### Week at a Glance
2-3 sentence executive summary. Was this a productive week? Focused or scattered? What was the dominant theme?

### Goal Scoreboard
For EACH of Yanqing's active goals, rate the week's progress:

${goalScoreboard}

### Yanqing's Voice This Week
This is critical. Capture how Yanqing's thinking evolved across the week:
- **Questions he kept asking** — what was he curious about? What themes recurred?
- **Preferences that emerged** — technical choices, workflow opinions, architectural decisions
- **Corrections & redirects** — moments where he changed course or overrode the AI's suggestions
- **Frustrations** — what broke, what was slow, what annoyed him? Recurring pain points.
- **Evolution** — did his focus shift across the week? Did Monday's priority become Friday's afterthought?

### Decisions That Matter
Not every decision — only ones that set direction or closed off options. Include Yanqing's reasoning where he expressed it. Quote him when his words capture the "why."

### Technical Highlights
Specific artifacts and numbers with fidelity:
- Key files created/modified (paths, what they do)
- Performance numbers (durations, token counts, file sizes)
- Architecture changes and their rationale
- Tools tested, APIs wired, integrations built

### Unresolved & Carrying Forward
Open threads, blocked items, things that need attention next week. Be specific about what's blocking and who/what can unblock it.

### Patterns HOMER Noticed
You have Homer's full architecture and soul now. Be sharp:
- Time allocation: Where did the hours actually go vs. where Yanqing says they should go?
- Recurring themes: What keeps coming up across days?
- Risk flags: Anything Yanqing should be aware of but might be overlooking?
- Delegation patterns: What does Yanqing trust HOMER with vs. what does he insist on doing himself?
- Homer evolution: Is HOMER becoming more useful or just more complex? Was Homer work this week high-leverage or yak-shaving?
- Opportunity: What's the highest-leverage thing Yanqing could do next week?

### What HOMER Can Do Better
1-2 concrete things HOMER should improve to serve Yanqing better next week. Based on what went wrong, what was slow, or what was missing this week.

## PART 2: Promotion Suggestions

Facts from this week that should be promoted to permanent memory. These are DURABLE facts — things that will be useful weeks/months from now, not session-level details.

Weekly consolidation focuses on CROSS-DAY SYNTHESIS — patterns and insights that only emerge from looking at the full week. Nightly-memory handles individual daily facts via CAS dedup.

Criteria for weekly promotion (cross-day only):
- Recurring themes across 3+ days (e.g., "spent most of the week on X" → work.md)
- Trend-level career or life shifts visible over the week (work.md, life.md)
- Architecture decisions that evolved across multiple sessions (tools.md)
- Goal progress or priority shifts apparent from the week's arc (me.md)
- Workflow patterns confirmed by repeated use (preferences.md)

Do NOT promote:
- Things already in the permanent files (check the context below)
- Single-session facts (nightly-memory handles these)
- Session-level debugging or ephemeral fixes
- Generic observations without specific facts

Output format — you MUST use this exact structure:

<weekly_summary>
(your markdown summary here)
</weekly_summary>

<promotions>
(JSON array of promotions, each with: "file", "content", "reason")
Example:
[
  {"file": "tools.md", "content": "### [2026-02-05] Session Summary API Migration\\nSwitched session-summaries from Gemini CLI to Gemini API internal handler. CLI timed out on 500KB+ logs; API processes in ~15s.", "reason": "HOMER architecture decision affecting reliability"},
  {"file": "work.md", "content": "### [2026-02-05] Segmentation Ownership\\nFormally pitched to JT for ownership of segmentation workstream.", "reason": "Career milestone — taking ownership of highest-leverage P&G project"}
]
If no promotions needed, output: []
</promotions>`;
}

function getDateRange(days: number): string[] {
  const dates: string[] = [];
  const now = new Date();
  for (let i = 1; i <= days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    dates.push(`${y}-${m}-${day}`);
  }
  return dates.reverse(); // oldest first
}

async function readFileIfExists(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  return readFile(path, "utf-8");
}

const DB_PATH = PATHS.db;

export async function runWeeklyConsolidation(daysBack = 7, stateManager?: StateManager): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  const dates = getDateRange(daysBack);
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];

  logger.info({ startDate, endDate, days: daysBack }, "Starting weekly memory consolidation via Gemini 3.1 Pro API");

  // Build dynamic system prompt — no hardcoded bio
  let systemPrompt: string;
  try {
    systemPrompt = await buildSchedulerContext({ dailyLogDays: 0 });
  } catch (ctxErr) {
    const msg = ctxErr instanceof Error ? ctxErr.message : String(ctxErr);
    logger.error({ error: msg }, "Failed to build scheduler context");
    return { success: false, output: "", error: msg };
  }

  // Primary: collect from session_summaries (richer than daily .md files)
  const dailyLogs: string[] = [];
  let totalSize = 0;
  let logsFound = 0;

  let sessionSm: StateManager | null = null;
  try {
    sessionSm = stateManager ?? new StateManager(DB_PATH);
    const sessions = sessionSm.getRecentSessions(daysBack, { activeOnly: true });

    // Group sessions by date
    const byDate = new Map<string, SessionSummaryRow[]>();
    for (const s of sessions) {
      const day = (s.startedAt ?? s.createdAt).slice(0, 10);
      if (!byDate.has(day)) byDate.set(day, []);
      byDate.get(day)!.push(s);
    }

    for (const date of dates) {
      const daySessions = byDate.get(date);
      if (daySessions && daySessions.length > 0) {
        logsFound++;
        const entries = daySessions.map(s => {
          const ts = s.startedAt ?? s.createdAt;
          const time = ts.slice(11, 16) || "00:00";
          return `[${time}] [${s.agent}] ${s.title ?? "untitled"}\n${s.summary ?? ""}`;
        }).join("\n\n");
        totalSize += entries.length;
        dailyLogs.push(`# ${date}\n\n${entries}`);
      } else {
        // Fallback: check daily_log_archive for historical data (pre-migration)
        const archive = sessionSm.getDailyLogArchive(date);
        if (archive) {
          logsFound++;
          const text = archive.summaryContent ?? archive.rawContent;
          totalSize += text.length;
          dailyLogs.push(`# ${date}\n\n${text}`);
        }
      }
    }
  } catch (err) {
    logger.warn({ error: err }, "Failed to load sessions for weekly consolidation");
  } finally {
    if (!stateManager && sessionSm) sessionSm.close();
  }

  if (logsFound === 0) {
    return { success: true, output: `No daily logs found for ${startDate} to ${endDate}, skipping` };
  }

  // Collect current permanent memory (so LLM knows what's already there and avoids duplication)
  const permanentContext: string[] = [];
  for (const { path, label } of PERMANENT_FILES) {
    const content = await readFileIfExists(path);
    if (content) {
      permanentContext.push(`## Current ${label}\n\n${content}`);
    }
  }

  // Build the consolidation prompt with dynamic goals
  const consolidationPrompt = await buildConsolidationPrompt();

  // Build the full input
  const dailySection = dailyLogs.join("\n\n---\n\n");
  const permanentSection = permanentContext.join("\n\n---\n\n");

  let fullInput = `${consolidationPrompt}\n\n` +
    `# Week: ${startDate} to ${endDate} (${logsFound} daily logs)\n\n` +
    `## Current Permanent Memory (DO NOT duplicate what's already here)\n\n${permanentSection}\n\n` +
    `---\n\n## Daily Logs (summaries where available, raw where not)\n\n${dailySection}`;

  // Truncate if needed (keep most recent days)
  if (fullInput.length > MAX_INPUT_CHARS) {
    logger.warn({ totalChars: fullInput.length, max: MAX_INPUT_CHARS }, "Input too large, truncating older logs");
    fullInput = fullInput.slice(-MAX_INPUT_CHARS);
  }

  const inputSizeKB = Math.round(fullInput.length / 1024);
  logger.info({ logsFound, inputSizeKB, totalRawSizeKB: Math.round(totalSize / 1024) }, "Sending to Gemini 3.1 Pro API");

  try {
    const result = await executeGeminiAPI(fullInput, {
      model: "pro31",
      systemPrompt,
      temperature: 0.3,
      timeout: 300000, // 5 min
      useGrounding: false,
    });

    if (result.exitCode !== 0) {
      return { success: false, output: "", error: `Gemini API error: ${result.output}` };
    }

    const response = result.output;

    // Parse weekly summary
    const summaryMatch = response.match(/<weekly_summary>([\s\S]*?)<\/weekly_summary>/);
    const weeklySummary = summaryMatch?.[1]?.trim();

    if (!weeklySummary) {
      return { success: false, output: "", error: "Failed to parse weekly summary from API response" };
    }

    // Parse promotions
    const promotionsMatch = response.match(/<promotions>([\s\S]*?)<\/promotions>/);
    let promotions: Array<{ file: string; content: string; reason: string }> = [];

    if (promotionsMatch) {
      try {
        const jsonStr = promotionsMatch[1]!.trim();
        if (jsonStr !== "[]") {
          const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
          if (arrayMatch) {
            promotions = JSON.parse(arrayMatch[0]);
          }
        }
      } catch (parseErr) {
        logger.warn({ error: parseErr }, "Failed to parse promotions JSON, continuing without promotions");
      }
    }

    // Append weekly summary to today's daily log
    const todayDate = getTodayDateString();
    const todayLogPath = `${DAILY_LOG_DIR}/${todayDate}.md`;
    const summaryBlock = `\n\n---\n\n## Weekly Consolidation (${startDate} → ${endDate})\n*Generated ${new Date().toLocaleTimeString("en-US", { hour12: false })} by HOMER via Gemini 3.1 Pro*\n\n${weeklySummary}\n`;

    if (existsSync(todayLogPath)) {
      await appendFile(todayLogPath, summaryBlock);
    } else {
      await appendFile(todayLogPath, `# ${todayDate}\n${summaryBlock}`);
    }

    // Snapshot target files before promotion writes
    if (promotions.length > 0) {
      const sm = stateManager ?? new StateManager(DB_PATH);
      const ownedSm = !stateManager;
      try {
        const targetFiles = new Set(promotions.map((p: { file: string }) => p.file));
        for (const fileName of targetFiles) {
          const filePath = FILE_PATH_MAP[fileName] ?? `${PATHS.memory}/${fileName}`;
          if (!existsSync(filePath)) continue;
          try {
            const content = await readFile(filePath, "utf-8");
            sm.snapshotMemoryFile(fileName, content, "pre-weekly-consolidation");
          } catch (snapErr) {
            logger.warn({ error: snapErr, file: fileName }, "Failed to snapshot before promotion");
          }
        }
      } finally {
        if (ownedSm) sm.close();
      }
    }

    // Apply promotions (CAS dedup via promoted_facts table)
    let promotionsApplied = 0;
    const promotionLog: string[] = [];
    const validFiles = new Set(PERMANENT_FILES.map(f => f.path.split("/").pop()));
    const dedupSm = stateManager ?? new StateManager(DB_PATH);
    const ownedDedupSm = !stateManager;

    try {
      for (const promo of promotions) {
        const fileName = promo.file;
        if (!validFiles.has(fileName)) {
          logger.warn({ file: fileName }, "Skipping promotion to unknown file");
          continue;
        }

        const filePath = FILE_PATH_MAP[fileName] ?? `${PATHS.memory}/${fileName}`;
        if (!existsSync(filePath)) {
          logger.warn({ filePath }, "Promotion target does not exist, skipping");
          continue;
        }

        // CAS dedup check — skip if already promoted
        if (dedupSm.checkFactExists(promo.content, fileName)) {
          logger.debug({ file: fileName, content: promo.content.slice(0, 60) }, "Skipping duplicate promoted fact (CAS)");
          continue;
        }

        await appendFile(filePath, `\n\n${promo.content}\n`);
        dedupSm.recordPromotedFact(promo.content, fileName, null, "weekly");
        promotionsApplied++;
        promotionLog.push(`→ ${fileName}: ${promo.reason}`);

        logger.info({ file: fileName, reason: promo.reason }, "Promoted fact to permanent memory");
      }
    } finally {
      if (ownedDedupSm) dedupSm.close();
    }

    const tokenInfo = result.inputTokens
      ? ` (${result.inputTokens} in / ${result.outputTokens} out tokens)`
      : "";

    const parts = [
      `Weekly consolidation ${startDate}→${endDate} in ${Math.round(result.duration / 1000)}s${tokenInfo}`,
      `${logsFound} logs analyzed, summary appended to ${todayDate}.md`,
    ];

    if (promotionsApplied > 0) {
      parts.push(`${promotionsApplied} facts promoted:`);
      parts.push(...promotionLog);
    } else {
      parts.push("No new promotions needed");
    }

    logger.info({
      startDate, endDate, logsFound,
      duration: result.duration,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      promotionsApplied,
    }, "Weekly consolidation complete");

    return { success: true, output: parts.join("\n") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "Weekly consolidation failed");
    return { success: false, output: "", error: message };
  }
}

function getTodayDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
