/**
 * Weekly Memory Consolidation — Codex GPT-5.4 handler
 *
 * Reads the past 7 days of daily logs + permanent memory files,
 * sends to Codex GPT-5.4 for cross-day analysis, then:
 * 1. Appends a weekly summary to the current daily log
 * 2. Promotes key facts to permanent memory files
 *
 * No hardcoded bios or frozen goals — reads live memory files every run.
 * Goals, career state, projects all come from me.md/work.md at execution time.
 */

import { readFile, appendFile } from "fs/promises";
import { existsSync } from "fs";
import { executeCodexCLI } from "../../executors/codex-cli.js";
import { logger } from "../../utils/logger.js";
import { StateManager, type SessionSummaryRow } from "../../state/manager.js";
import { buildSchedulerContext, buildGoalScoreboard } from "../shared-context.js";
import { flagClaimsStale, insertCandidate, type KnowledgeClaim, type TargetFile, type ClaimType } from "../../memory/claims.js";
import { PATHS } from "../../config/paths.js";
import { hasMigration } from "../../state/migrations/index.js";

const DAILY_LOG_DIR = PATHS.daily;

const FILE_PATH_MAP: Record<string, string> = {
  "me.md": PATHS.me,
  "work.md": PATHS.work,
  "tools.md": PATHS.tools,
  "preferences.md": PATHS.preferences,
};
const MAX_INPUT_CHARS = 800_000; // ~200K tokens, within Codex's 1M-token context

const PERMANENT_FILES = [
  { path: PATHS.me, label: "me.md (identity, goals, ambition, routines)" },
  { path: PATHS.work, label: "work.md (career, projects, org)" },
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
- Trend-level career shifts visible over the week (work.md)
- Architecture decisions that evolved across multiple sessions (tools.md)
- Goal progress or priority shifts apparent from the week's arc (me.md)
- Workflow patterns confirmed by repeated use (preferences.md)

Do NOT promote:
- Things already in the permanent files (check the context below)
- Single-session facts (nightly-memory handles these)
- Session-level debugging or ephemeral fixes
- Generic observations without specific facts

## PART 3: Memory Lint (Staleness Check)

Scan the permanent memory files for claims that are:
1. **Date-expired** — references to dates that have passed ("until Apr 11", "next Thursday", specific deadlines)
2. **Contradicted** — this week's sessions show something different from what memory says
3. **Stale status** — "in progress" / "pending" / "waiting on" with no recent activity supporting them
4. **Orphaned** — people, projects, or initiatives not mentioned in any session for 3+ weeks

Be HIGH-CONFIDENCE only. Better to catch 3 genuinely stale facts than flag 15 maybes. Only flag things you're confident are outdated based on the sessions you just read.

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
</promotions>

<lint_findings>
(JSON array, each with: "file", "section" (header text under which the stale line lives, or null), "stale_text", "reason", "suggestion")
Example:
[
  {"file": "work.md", "section": "Active Projects", "stale_text": "JT on vacation until ~Apr 11", "reason": "date passed", "suggestion": "remove or update with current status"}
]
If no findings: []
</lint_findings>`;
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
  lintFindings?: KnowledgeClaim[];
}> {
  const dates = getDateRange(daysBack);
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];

  logger.info({ startDate, endDate, days: daysBack }, "Starting weekly memory consolidation via Codex GPT-5.4");

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
  logger.info({ logsFound, inputSizeKB, totalRawSizeKB: Math.round(totalSize / 1024) }, "Sending to Codex GPT-5.4 high reasoning");

  try {
    const result = await executeCodexCLI(
      systemPrompt + "\n\n---\n\n" + fullInput,
      {
        cwd: process.env.HOME ?? "/Users/yj",
        model: "gpt-5.5",
        reasoningEffort: "high",
        timeout: 600_000, // 10 min — large context needs more time
      },
    );

    if (result.exitCode !== 0) {
      return { success: false, output: "", error: `Codex error: ${result.output}` };
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

    // Parse lint findings
    const lintMatch = response.match(/<lint_findings>([\s\S]*?)<\/lint_findings>/);
    let lintFindings: Array<{ file: string; section?: string | null; stale_text: string; reason: string; suggestion: string }> = [];

    if (lintMatch) {
      try {
        const jsonStr = lintMatch[1]!.trim();
        if (jsonStr !== "[]") {
          const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
          if (arrayMatch) {
            lintFindings = JSON.parse(arrayMatch[0]);
          }
        }
      } catch (parseErr) {
        logger.warn({ error: parseErr }, "Failed to parse lint findings JSON, continuing");
      }
    }

    // Append weekly summary to today's daily log
    const todayDate = getTodayDateString();
    const todayLogPath = `${DAILY_LOG_DIR}/${todayDate}.md`;
    const summaryBlock = `\n\n---\n\n## Weekly Consolidation (${startDate} → ${endDate})\n*Generated ${new Date().toLocaleTimeString("en-US", { hour12: false })} by HOMER via Codex GPT-5.4*\n\n${weeklySummary}\n`;

    if (existsSync(todayLogPath)) {
      await appendFile(todayLogPath, summaryBlock);
    } else {
      await appendFile(todayLogPath, `# ${todayDate}\n${summaryBlock}`);
    }

    // Apply promotions via CanonicalMemoryService (CAS dedup built in)
    let promotionsApplied = 0;
    let staleClaims: KnowledgeClaim[] = [];
    const promotionLog: string[] = [];
    const validFiles = new Set(PERMANENT_FILES.map(f => f.path.split("/").pop()));
    const dedupSm = stateManager ?? new StateManager(DB_PATH);
    const ownedDedupSm = !stateManager;
    if (!hasMigration(dedupSm.getDb(), "069_knowledge_claims.sql")) {
      logger.warn("knowledge_claims migration missing — weekly consolidation HITL pipeline cannot run");
      if (ownedDedupSm) dedupSm.close();
      return { success: false, output: "", error: "knowledge_claims migration missing" };
    }

    try {
      for (const promo of promotions) {
        const fileName = promo.file;
        if (!validFiles.has(fileName)) {
          logger.warn({ file: fileName }, "Skipping promotion to unknown file");
          continue;
        }

        // Strip .md extension for CanonicalMemoryService (expects "work", not "work.md")
        const fileKey = fileName.replace(/\.md$/, "");

        const filePath = FILE_PATH_MAP[fileName] ?? `${PATHS.memory}/${fileName}`;
        if (!existsSync(filePath)) {
          logger.warn({ filePath }, "Promotion target does not exist, skipping");
          continue;
        }

        // Route through knowledge_claims for human review. Weekly consolidation
        // doesn't carry per-promo confidence, so everything lands in the 0.20-0.95
        // HITL band (0.7 default) — never auto-approved.
        try {
          const claimId = insertCandidate(dedupSm.getDb(), {
            content: promo.content,
            targetFile: fileKey as TargetFile,
            section: "",
            claimType: "fact" as ClaimType,
            confidence: 0.7,
            originChannel: "weekly-consolidation",
          });
          if (claimId) {
            promotionsApplied++;
            promotionLog.push(`→ ${fileName}: ${promo.reason} (queued for review)`);
            logger.info({ file: fileName, reason: promo.reason }, "Weekly promotion queued as candidate for review");
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ error: msg, file: fileName }, "Failed to insert weekly candidate");
        }
      }

      // Process lint findings — flag matching claims as stale (must run before dedupSm.close())
      if (lintFindings.length > 0) {
        staleClaims = flagClaimsStale(dedupSm.getDb(), lintFindings);
      }
    } finally {
      if (ownedDedupSm) dedupSm.close();
    }

    const parts = [
      `Weekly consolidation ${startDate}→${endDate} in ${Math.round(result.duration / 1000)}s`,
      `${logsFound} logs analyzed, summary appended to ${todayDate}.md`,
    ];

    if (promotionsApplied > 0) {
      parts.push(`${promotionsApplied} facts promoted:`);
      parts.push(...promotionLog);
    } else {
      parts.push("No new promotions needed");
    }

    if (staleClaims.length > 0) {
      parts.push(`${staleClaims.length} lint findings flagged as stale`);
    }

    logger.info({
      startDate, endDate, logsFound,
      duration: result.duration,
      promotionsApplied,
      lintFindings: staleClaims.length,
    }, "Weekly consolidation complete");

    return { success: true, output: parts.join("\n"), lintFindings: staleClaims };
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
