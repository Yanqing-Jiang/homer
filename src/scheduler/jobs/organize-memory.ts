import { appendFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { logger } from "../../utils/logger.js";
import {
  readDailyLog,
  addDailyLogSummary,
  getYesterday,
  groupEntriesByContext,
  type DailyEntry,
} from "../../memory/daily.js";
import { getMemoryIndexer } from "../../memory/indexer.js";
import { executeClaudeCommand } from "../../executors/claude.js";

/**
 * Memory file paths by context
 */
const MEMORY_PATHS: Record<string, string> = {
  work: "/Users/yj/work/memory.md",
  life: "/Users/yj/life/memory.md",
  general: "/Users/yj/memory/facts.md",
};

/**
 * Result of memory organization
 */
export interface OrganizationResult {
  date: string;
  entriesProcessed: number;
  updatesWritten: {
    work: number;
    life: number;
    general: number;
  };
  summaryAdded: boolean;
  reindexed: boolean;
  error?: string;
}

/**
 * Organization prompt template
 */
const ORGANIZATION_PROMPT = `You are organizing daily memory log entries into permanent memory files.

Review these daily log entries and organize them into structured updates:

<entries>
{ENTRIES}
</entries>

<existing_memory>
{EXISTING_MEMORY}
</existing_memory>

Your task:
1. Identify NEW facts, decisions, and preferences that should be remembered
2. Skip anything already captured in existing_memory (avoid duplicates)
3. Summarize related items concisely
4. Focus on actionable information that will be useful in future conversations

Output format - respond with ONLY this structure, no other text:

<organized>
## New Facts
- [list any new factual information learned]

## Decisions Made
- [list any decisions or choices made]

## Preferences Learned
- [list any user preferences discovered]

## Open Items
- [list any pending tasks or follow-ups mentioned]
</organized>

<summary>
[Write a 1-2 sentence summary of the day's activities for the daily log]
</summary>

If there's nothing meaningful to add (entries are trivial or already captured), respond with:
<organized>
(No new items to add)
</organized>

<summary>
[Brief summary of the day]
</summary>`;

/**
 * Format entries for the organization prompt
 */
function formatEntriesForPrompt(entries: DailyEntry[]): string {
  return entries
    .map((e) => `[${e.time}] ${e.content}`)
    .join("\n\n");
}

/**
 * Load existing memory file content
 */
async function loadExistingMemory(context: "work" | "life" | "general"): Promise<string> {
  const path = MEMORY_PATHS[context];
  if (!path || !existsSync(path)) {
    return "(No existing memory file)";
  }

  try {
    const content = await readFile(path, "utf-8");
    // Truncate if too long to fit in prompt
    if (content.length > 4000) {
      return content.slice(-4000) + "\n...(truncated)";
    }
    return content || "(Empty file)";
  } catch {
    return "(Failed to read)";
  }
}

/**
 * Parse organized content from Claude's response
 */
function parseOrganizedContent(response: string): {
  organized: string | null;
  summary: string | null;
} {
  const organizedMatch = response.match(/<organized>([\s\S]*?)<\/organized>/);
  const summaryMatch = response.match(/<summary>([\s\S]*?)<\/summary>/);

  return {
    organized: organizedMatch?.[1]?.trim() || null,
    summary: summaryMatch?.[1]?.trim() || null,
  };
}

/**
 * Check if organized content has meaningful updates
 */
function hasContent(organized: string): boolean {
  if (!organized) return false;
  if (organized.includes("(No new items to add)")) return false;
  if (organized.includes("No new items")) return false;

  // Check if any sections have content
  const sections = organized.split(/##\s+/);
  for (const section of sections) {
    const lines = section.split("\n").filter((l) => l.trim().startsWith("-"));
    if (lines.length > 0) return true;
  }

  return false;
}

/**
 * Append organized content to memory file
 */
async function appendToMemoryFile(
  context: "work" | "life" | "general",
  content: string,
  date: string
): Promise<boolean> {
  const path = MEMORY_PATHS[context];
  if (!path) return false;

  try {
    const formatted = `\n\n<!-- Organized from ${date} -->\n${content}`;
    await appendFile(path, formatted, "utf-8");
    logger.info({ context, path, contentLength: content.length }, "Appended to memory file");
    return true;
  } catch (error) {
    logger.error({ error, context, path }, "Failed to append to memory file");
    return false;
  }
}

/**
 * Organize entries for a single context
 */
async function organizeContextEntries(
  entries: DailyEntry[],
  context: "work" | "life" | "general",
  date: string
): Promise<{ updated: boolean; summary: string | null }> {
  if (entries.length === 0) {
    return { updated: false, summary: null };
  }

  try {
    // Build the prompt
    const entriesText = formatEntriesForPrompt(entries);
    const existingMemory = await loadExistingMemory(context);

    const prompt = ORGANIZATION_PROMPT
      .replace("{ENTRIES}", entriesText)
      .replace("{EXISTING_MEMORY}", existingMemory);

    // Call Claude to organize
    logger.info({ context, entryCount: entries.length }, "Organizing entries with Claude");

    const result = await executeClaudeCommand(prompt, {
      cwd: "/Users/yj",
      // Don't use session resume for organization - fresh each time
    });

    const { organized, summary } = parseOrganizedContent(result.output);

    if (organized && hasContent(organized)) {
      await appendToMemoryFile(context, organized, date);
      return { updated: true, summary };
    }

    return { updated: false, summary };
  } catch (error) {
    logger.error({ error, context }, "Failed to organize context entries");
    return { updated: false, summary: null };
  }
}

/**
 * Main memory organization job
 * Runs at 3 AM to organize yesterday's daily log
 */
export async function organizeMemory(date?: Date): Promise<OrganizationResult> {
  const targetDate = date || getYesterday();
  const dateStr = targetDate.toISOString().split("T")[0] ?? "";

  logger.info({ date: dateStr }, "Starting memory organization job");

  const result: OrganizationResult = {
    date: dateStr,
    entriesProcessed: 0,
    updatesWritten: { work: 0, life: 0, general: 0 },
    summaryAdded: false,
    reindexed: false,
  };

  try {
    // Read yesterday's daily log
    const dailyLog = await readDailyLog(targetDate);

    if (dailyLog.entries.length === 0) {
      logger.info({ date: dateStr }, "No entries to organize");
      return result;
    }

    // Skip if already has a summary (already organized)
    if (dailyLog.summary) {
      logger.info({ date: dateStr }, "Daily log already organized, skipping");
      return result;
    }

    result.entriesProcessed = dailyLog.entries.length;

    // Group entries by context
    const grouped = groupEntriesByContext(dailyLog.entries);

    // Organize each context
    const summaries: string[] = [];

    for (const [context, entries] of Object.entries(grouped)) {
      if (entries.length === 0) continue;

      const contextKey = context as "work" | "life" | "general";
      const { updated, summary } = await organizeContextEntries(entries, contextKey, dateStr || "");

      if (updated) {
        result.updatesWritten[contextKey]++;
      }
      if (summary) {
        summaries.push(`${context}: ${summary}`);
      }
    }

    // Add summary to daily log
    if (summaries.length > 0) {
      const combinedSummary = summaries.join("\n");
      await addDailyLogSummary(combinedSummary, targetDate);
      result.summaryAdded = true;
    }

    // Re-index memory files
    try {
      const indexer = getMemoryIndexer();
      await indexer.indexAllMemoryFiles();
      result.reindexed = true;
    } catch (indexError) {
      logger.warn({ error: indexError }, "Failed to reindex after organization");
    }

    logger.info(result, "Memory organization completed");
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ error, date: dateStr }, "Memory organization failed");
    return { ...result, error: errorMessage };
  }
}

/**
 * System job configuration for the scheduler
 */
export const MEMORY_ORGANIZATION_JOB = {
  id: "memory-organization",
  name: "Memory Organization",
  cron: "0 3 * * *", // 3 AM daily
  internal: true,
  handler: organizeMemory,
};
