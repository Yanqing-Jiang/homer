/**
 * Shared scheduler context builder
 *
 * Reads Yanqing's full context (soul, identity, career, tools, architecture,
 * preferences, recent activity) and assembles it into a system prompt that
 * lets any scheduler job "know Yanqing" — not follow frozen instructions.
 *
 * Used by weekly-consolidation and memory-cleanup.
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { StateManager, type SessionSummaryRow } from "../state/manager.js";
import { PATHS } from "../config/paths.js";
import { getCurrentFocus } from "../memory/session-bootstrap.js";
import { logger } from "../utils/logger.js";

// Re-export for backward compatibility (function lives in job-outputs.ts)
export { getRecentJobOutputs } from "./job-outputs.js";

const CONTEXT_FILES: Array<{ path: string; label: string }> = [
  { path: PATHS.me, label: "me.md (Identity, Goals, Ambition)" },
  { path: PATHS.work, label: "work.md (Career, Projects, Org)" },
  { path: PATHS.tools, label: "tools.md (Tool Configs, Subscriptions)" },
  { path: PATHS.preferences, label: "preferences.md (Communication & Technical Preferences)" },
];

async function readFileIfExists(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  return readFile(path, "utf-8");
}

/**
 * Build a compact execution bootstrap preamble.
 * Gives sub-agents runtime awareness: where they are, what's running, budget limits.
 */
export function buildBootstrapPreamble(options?: {
  executor?: string;
  lane?: string;
  jobId?: string;
  timeoutMs?: number;
}): string {
  const now = new Date().toISOString().slice(0, 19) + "Z";
  return `<execution_bootstrap>
  <cwd>${PATHS.homerRoot}</cwd>
  <date>${now}</date>
  <executor>${options?.executor ?? "unknown"}</executor>
  <lane>${options?.lane ?? "default"}</lane>
  <job_id>${options?.jobId ?? "ad-hoc"}</job_id>
  <budget timeout_ms="${options?.timeoutMs ?? 600000}" />
</execution_bootstrap>`;
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
  const claudeMd = await readFileIfExists(PATHS.claudeMd);
  if (!claudeMd) {
    throw new Error("Cannot build scheduler context: CLAUDE.md missing");
  }

  // Build sections array
  const sections: string[] = [];

  // Environment bootstrap — gives sub-agents runtime awareness
  sections.push(buildBootstrapPreamble());

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
  const architectureMd = await readFileIfExists(PATHS.architectureMd);
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
 * Render current goals as a curated active-vs-paused summary.
 *
 * Routes through getCurrentFocus() so paused items (MAHORAGA, Career OS automation)
 * can never resurface as "active goals" via raw `## Goals` parsing. See
 * ~/homer/src/memory/session-bootstrap.ts for the source-of-truth rules.
 */
export async function extractCurrentGoals(): Promise<string> {
  try {
    const focus = await getCurrentFocus();
    const lines: string[] = [];
    if (focus.active.length > 0) {
      lines.push("### Active");
      focus.active.slice(0, 6).forEach((g, i) => lines.push(`${i + 1}. ${g}`));
    }
    if (focus.paused.length > 0) {
      lines.push("\n### Paused (do not surface as current goals)");
      focus.paused.forEach((p) => lines.push(`- ${p}`));
    }
    return lines.length > 0 ? lines.join("\n") : "(No goals parsed from me.md)";
  } catch (err) {
    return `(Goals unavailable: ${err instanceof Error ? err.message : String(err)})`;
  }
}

/**
 * Render active work projects (paused entries filtered out).
 *
 * Uses getCurrentFocus() so a `**Status:** paused` block in work.md is never
 * treated as an active project by downstream prompts.
 */
export async function extractActiveProjects(): Promise<string> {
  try {
    const focus = await getCurrentFocus();
    if (focus.activeProjects.length === 0) return "(No active projects parsed from work.md)";
    const lines = focus.activeProjects.map((p) => `- ${p}`);
    if (focus.pausedProjects.length > 0) {
      lines.push("", "### Paused (context only)");
      focus.pausedProjects.forEach((p) => lines.push(`- ${p}`));
    }
    return lines.join("\n");
  } catch (err) {
    return `(Active projects unavailable: ${err instanceof Error ? err.message : String(err)})`;
  }
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
  const meMd = await readFileIfExists(PATHS.me);
  let roleSnippet = "Yanqing Jiang";
  if (meMd) {
    const roleMatch = meMd.match(/(?:^|\n)(.+?(?:Senior|Director|Manager|Engineer|Lead).+?)(?:\n|$)/i);
    if (roleMatch) roleSnippet = roleMatch[1]!.trim();
  }

  // Extract key preferences
  const prefsMd = await readFileIfExists(PATHS.preferences);
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
 * Build goal scoreboard sections dynamically from current focus state.
 *
 * Reads structured focus via getCurrentFocus() (see ~/homer/src/memory/session-bootstrap.ts)
 * so the scoreboard reflects ACTIVE goals only — paused items (MAHORAGA, Career OS
 * automation) are excluded automatically. Falls back to a single HOMER section if
 * focus parsing fails so the weekly-consolidation job doesn't lose its anchor.
 *
 * Output format: one markdown section per active goal with momentum / next-lever
 * placeholders for the consolidation prompt to fill in.
 */
export async function buildGoalScoreboard(): Promise<string> {
  const goalSections: string[] = [];

  try {
    const focus = await getCurrentFocus();

    for (const item of focus.active) {
      // Strip trailing detail after em-dash so the scoreboard heading is short.
      const goalName = item.split("—")[0]!.trim().replace(/:$/, "");
      if (!goalName) continue;
      goalSections.push(
        `**${goalName}**\n` +
          `- What moved: [specific actions, artifacts, file paths]\n` +
          `- Momentum: [accelerating / steady / stalled / regressing]\n` +
          `- Next lever to pull: [most impactful next step]`
      );
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "buildGoalScoreboard: focus parse failed");
  }

  // Always include HOMER as a goal (it's implicit in the system).
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

