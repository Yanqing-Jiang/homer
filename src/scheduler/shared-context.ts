/**
 * Shared scheduler context builder
 *
 * Reads Yanqing's full context (soul, identity, career, tools, architecture,
 * preferences, recent activity) and assembles it into a system prompt that
 * lets any scheduler job "know Yanqing" — not follow frozen instructions.
 *
 * Used by session-summaries, weekly-consolidation, and memory-cleanup.
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { StateManager, type SessionSummaryRow } from "../state/manager.js";
import { PATHS } from "../config/paths.js";

// Re-export for backward compatibility (function lives in job-outputs.ts)
export { getRecentJobOutputs } from "./job-outputs.js";

const CLAUDE_MD_PATH = PATHS.claudeMd;
const MEMORY_DIR = PATHS.memory;
const ARCHITECTURE_MD_PATH = "/Users/yj/homer/architecture.md";

const CONTEXT_FILES: Array<{ path: string; label: string }> = [
  { path: `${MEMORY_DIR}/me.md`, label: "me.md (Identity, Goals, Ambition)" },
  { path: `${MEMORY_DIR}/work.md`, label: "work.md (Career, Projects, Org)" },
  { path: `${MEMORY_DIR}/life.md`, label: "life.md (Personal Context)" },
  { path: `${MEMORY_DIR}/tools.md`, label: "tools.md (Tool Configs, Subscriptions)" },
  { path: `${MEMORY_DIR}/preferences.md`, label: "preferences.md (Communication & Technical Preferences)" },
];

async function readFileIfExists(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  return readFile(path, "utf-8");
}

/**
 * Format session_summaries rows into markdown blocks by date.
 */
function formatSessionsAsMarkdown(sessions: SessionSummaryRow[]): Map<string, string> {
  const byDate = new Map<string, string[]>();

  for (const s of sessions) {
    const ts = s.startedAt ?? s.createdAt;
    const day = ts.slice(0, 10);
    const time = ts.slice(11, 16) || "00:00";
    const agent = s.agent ?? "unknown";
    const title = s.title ?? "untitled";
    const summary = s.summary ?? "";

    if (!byDate.has(day)) byDate.set(day, []);
    byDate.get(day)!.push(`[${time}] [${agent}] ${title}\n${summary}`);
  }

  const result = new Map<string, string>();
  for (const [day, entries] of byDate) {
    result.set(`${day}.md`, `### ${day}\n${entries.join("\n\n")}`);
  }
  return result;
}

/**
 * Read the last N days of activity from session_summaries.
 * Returns a Map<filename, content> matching the old getRecentDailyLogs signature.
 */
async function getRecentDailyLogs(
  days: number,
  _maxLines: number
): Promise<Map<string, string>> {
  if (days <= 0) return new Map();

  let sm: StateManager | null = null;
  try {
    sm = new StateManager(PATHS.db);
    const sessions = sm.getRecentSessions(days, { activeOnly: true });
    return formatSessionsAsMarkdown(sessions);
  } catch {
    return new Map();
  } finally {
    sm?.close();
  }
}

export interface SchedulerContextOptions {
  /** How many days of daily logs to include (default: 7, 0 = none) */
  dailyLogDays?: number;
  /** Max lines per daily log (default: 200) */
  dailyLogMaxLines?: number;
  /** Include preferences.md (default: true) */
  includePreferences?: boolean;
  /** Extra context sections to append (e.g. cross-reference for cleanup) */
  extraSections?: string;
}

/**
 * Build a rich system prompt from Yanqing's live context files.
 * This is the "know Yanqing" builder — no hardcoded bios.
 */
export async function buildSchedulerContext(
  options?: SchedulerContextOptions
): Promise<string> {
  const {
    dailyLogDays = 7,
    dailyLogMaxLines = 200,
    includePreferences = true,
    extraSections,
  } = options ?? {};

  // Core: CLAUDE.md (Homer's soul)
  const claudeMd = await readFileIfExists(CLAUDE_MD_PATH);
  if (!claudeMd) {
    throw new Error("Cannot build scheduler context: CLAUDE.md missing");
  }

  // Build sections array
  const sections: string[] = [];

  sections.push(`You are HOMER — Yanqing's personal AI operating system.

# CLAUDE.md (Homer's Soul & Operating Manual)

${claudeMd}`);

  // Memory files
  for (const { path, label } of CONTEXT_FILES) {
    if (!includePreferences && path.endsWith("preferences.md")) continue;
    const content = await readFileIfExists(path);
    if (content) {
      sections.push(`# ${label}\n\n${content}`);
    }
  }

  // Architecture
  const architectureMd = await readFileIfExists(ARCHITECTURE_MD_PATH);
  if (architectureMd) {
    sections.push(`# architecture.md (Homer System Design)\n\n${architectureMd}`);
  }

  // Recent daily logs
  if (dailyLogDays > 0) {
    const dailyLogs = await getRecentDailyLogs(dailyLogDays, dailyLogMaxLines);
    if (dailyLogs.size > 0) {
      const logEntries: string[] = [];
      for (const [date, content] of dailyLogs) {
        logEntries.push(`### ${date}\n${content}`);
      }
      sections.push(
        `# This Week's Activity\n\nWhat Yanqing actually did recently:\n\n${logEntries.join("\n\n---\n\n")}`
      );
    }
  }

  // Extra sections (e.g. cross-reference for cleanup)
  if (extraSections) {
    sections.push(extraSections);
  }

  return sections.join("\n\n");
}

/**
 * Extract the ## Goals section from me.md (Short-Term + Long-Term).
 * Returns the raw markdown so prompts can reference live goals instead of hardcoded ones.
 */
export async function extractCurrentGoals(): Promise<string> {
  const meMd = await readFileIfExists(`${MEMORY_DIR}/me.md`);
  if (!meMd) return "(Goals not available — me.md missing)";

  // Find ## Goals and capture everything until the next ## that isn't a sub-heading of Goals
  const goalsMatch = meMd.match(/## Goals\n([\s\S]*?)(?=\n## (?!#)|\n---|$)/);
  if (!goalsMatch) return "(No ## Goals section found in me.md)";

  return goalsMatch[1]!.trim();
}

/**
 * Extract ## Active Projects section from work.md.
 * Returns the raw markdown for project-aware prompts.
 */
export async function extractActiveProjects(): Promise<string> {
  const workMd = await readFileIfExists(`${MEMORY_DIR}/work.md`);
  if (!workMd) return "(Active projects not available — work.md missing)";

  const projectsMatch = workMd.match(/## Active Projects\n([\s\S]*?)(?=\n## (?!#)|\n---|$)/);
  if (!projectsMatch) return "(No ## Active Projects section found in work.md)";

  return projectsMatch[1]!.trim();
}

/**
 * Build a condensed "know Yanqing" context (~2K chars) for swarm agents
 * that can't afford the full 30K buildSchedulerContext().
 *
 * Extracts: role, active goals, active projects, key preferences.
 * Designed for injection into swarm agent prompts and consolidation prompts.
 */
export async function buildCondensedContext(): Promise<string> {
  const [goals, projects] = await Promise.all([
    extractCurrentGoals(),
    extractActiveProjects(),
  ]);

  // Extract role from me.md first line or ## Career section
  const meMd = await readFileIfExists(`${MEMORY_DIR}/me.md`);
  let roleSnippet = "Yanqing Jiang";
  if (meMd) {
    const roleMatch = meMd.match(/(?:^|\n)(.+?(?:Senior|Director|Manager|Engineer|Lead).+?)(?:\n|$)/i);
    if (roleMatch) roleSnippet = roleMatch[1]!.trim();
  }

  // Extract key preferences
  const prefsMd = await readFileIfExists(`${MEMORY_DIR}/preferences.md`);
  let prefsSnippet = "";
  if (prefsMd) {
    const techPrefs = prefsMd.match(/## Technical[^\n]*\n([\s\S]*?)(?=\n## |$)/);
    if (techPrefs) prefsSnippet = techPrefs[1]!.trim().slice(0, 500);
  }

  const sections = [
    `## Who is Yanqing\n${roleSnippet}`,
    `## Current Goals\n${goals.slice(0, 1200)}`,
    `## Active Projects\n${projects.slice(0, 800)}`,
  ];

  if (prefsSnippet) {
    sections.push(`## Key Preferences\n${prefsSnippet}`);
  }

  return sections.join("\n\n");
}

/**
 * Build goal scoreboard sections dynamically from me.md goals.
 * Returns markdown template sections for each goal found.
 */
export async function buildGoalScoreboard(): Promise<string> {
  const goals = await extractCurrentGoals();
  if (goals.startsWith("(")) return goals; // error message

  // Parse numbered goals from Short-Term section
  const lines = goals.split("\n");
  const goalSections: string[] = [];

  // Also capture Long-Term goals
  let inShortTerm = false;
  let inLongTerm = false;

  for (const line of lines) {
    if (line.includes("Short-Term")) {
      inShortTerm = true;
      inLongTerm = false;
      continue;
    }
    if (line.includes("Long-Term")) {
      inShortTerm = false;
      inLongTerm = true;
      continue;
    }

    if (inShortTerm) {
      // Match numbered goals like "1. **Side income stream:**..."
      const goalMatch = line.match(/^\d+\.\s+\*\*(.+?)\*\*/);
      if (goalMatch) {
        const goalName = goalMatch[1]!.replace(/:$/, "");
        goalSections.push(
          `**${goalName}**\n` +
            `- What moved: [specific actions, artifacts, file paths]\n` +
            `- Momentum: [accelerating / steady / stalled / regressing]\n` +
            `- Next lever to pull: [most impactful next step]`
        );
      }
    }

    if (inLongTerm) {
      // Match bullet goals like "- Free cash flow..."
      const bulletMatch = line.match(/^-\s+(.+)/);
      if (bulletMatch) {
        goalSections.push(
          `**${bulletMatch[1]}**\n` +
            `- What moved: [any progress]\n` +
            `- Momentum: [accelerating / steady / stalled / regressing]`
        );
      }
    }
  }

  // Always include HOMER as a goal (it's implicit in the system)
  const hasHomer = goalSections.some((s) => s.toLowerCase().includes("homer"));
  if (!hasHomer) {
    goalSections.push(
      `**HOMER (AI Operating System)**\n` +
        `- What moved: [capabilities added, bugs fixed, architecture improvements]\n` +
        `- Momentum: [accelerating / steady / stalled / regressing]\n` +
        `- Self-assessment: [is HOMER becoming more useful or just more complex?]`
    );
  }

  return goalSections.join("\n\n");
}

