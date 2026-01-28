import { appendFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { logger } from "../utils/logger.js";

/**
 * Daily log entry structure
 */
export interface DailyEntry {
  time: string; // HH:MM format
  context: "work" | "life" | "general";
  content: string;
  source: "conversation" | "flush" | "scheduled" | "organized";
}

/**
 * Parsed daily log with metadata
 */
export interface DailyLog {
  date: string; // YYYY-MM-DD
  entries: DailyEntry[];
  summary?: string; // Added by 3 AM organization job
}

// Base path for daily logs
const DAILY_LOG_BASE = "/Users/yj/memory";

/**
 * Get the file path for a daily log
 * @param date - Date to get path for (defaults to today)
 */
export function getDailyLogPath(date?: Date): string {
  const d = date || new Date();
  const dateStr = formatDate(d);
  return `${DAILY_LOG_BASE}/${dateStr}.md`;
}

/**
 * Format date as YYYY-MM-DD
 */
function formatDate(date: Date): string {
  const iso = date.toISOString().split("T")[0];
  return iso ?? "";
}

/**
 * Format time as HH:MM
 */
function formatTime(date: Date): string {
  return date.toTimeString().slice(0, 5);
}

/**
 * Ensure the memory directory exists
 */
async function ensureMemoryDir(): Promise<void> {
  if (!existsSync(DAILY_LOG_BASE)) {
    await mkdir(DAILY_LOG_BASE, { recursive: true });
  }
}

/**
 * Append an entry to the daily log
 */
export async function appendDailyLog(entry: DailyEntry, date?: Date): Promise<void> {
  const filePath = getDailyLogPath(date);
  const d = date || new Date();

  try {
    await ensureMemoryDir();

    // Check if file exists to determine if we need header
    const needsHeader = !existsSync(filePath);

    let content = "";

    if (needsHeader) {
      content += `# ${formatDate(d)}\n\n`;
    }

    // Format entry
    const contextTag = entry.source === "flush" ? "flush" : entry.context;
    content += `### ${entry.time} [${contextTag}]\n`;
    content += `${entry.content}\n\n`;

    await appendFile(filePath, content, "utf-8");

    logger.debug(
      {
        filePath,
        context: entry.context,
        source: entry.source,
        contentLength: entry.content.length,
      },
      "Appended to daily log"
    );
  } catch (error) {
    logger.error({ error, filePath }, "Failed to append to daily log");
    throw error;
  }
}

/**
 * Read and parse a daily log file
 */
export async function readDailyLog(date?: Date): Promise<DailyLog> {
  const filePath = getDailyLogPath(date);
  const d = date || new Date();
  const dateStr = formatDate(d);

  const emptyLog: DailyLog = {
    date: dateStr,
    entries: [],
  };

  if (!existsSync(filePath)) {
    return emptyLog;
  }

  try {
    const content = await readFile(filePath, "utf-8");
    return parseDailyLog(content, dateStr);
  } catch (error) {
    logger.error({ error, filePath }, "Failed to read daily log");
    return emptyLog;
  }
}

/**
 * Parse daily log markdown content into structured data
 */
function parseDailyLog(content: string, date: string): DailyLog {
  const entries: DailyEntry[] = [];
  let summary: string | undefined;

  // Match entry headers: ### HH:MM [context]
  const entryRegex = /### (\d{2}:\d{2}) \[(\w+)\]\n([\s\S]*?)(?=### \d{2}:\d{2}|## Summary|$)/g;
  let match;

  while ((match = entryRegex.exec(content)) !== null) {
    const time = match[1] ?? "00:00";
    const contextTag = (match[2] ?? "general").toLowerCase();
    const entryContent = (match[3] ?? "").trim();

    // Determine context and source from tag
    let context: "work" | "life" | "general";
    let source: DailyEntry["source"];

    if (contextTag === "flush") {
      context = "general";
      source = "flush";
    } else if (contextTag === "organized") {
      context = "general";
      source = "organized";
    } else if (contextTag === "scheduled") {
      context = "work"; // scheduled jobs are typically work
      source = "scheduled";
    } else {
      context = contextTag as "work" | "life" | "general";
      if (context !== "work" && context !== "life") {
        context = "general";
      }
      source = "conversation";
    }

    entries.push({
      time,
      context,
      content: entryContent,
      source,
    });
  }

  // Extract summary section if present
  const summaryMatch = content.match(/## Summary\n([\s\S]*?)$/);
  if (summaryMatch && summaryMatch[1]) {
    summary = summaryMatch[1].trim();
  }

  return {
    date,
    entries,
    summary,
  };
}

/**
 * Add a summary section to a daily log (used by organization job)
 */
export async function addDailyLogSummary(summary: string, date?: Date): Promise<void> {
  const filePath = getDailyLogPath(date);

  if (!existsSync(filePath)) {
    logger.warn({ filePath }, "Cannot add summary - daily log does not exist");
    return;
  }

  try {
    const content = `\n## Summary\n${summary}\n`;
    await appendFile(filePath, content, "utf-8");
    logger.info({ filePath }, "Added summary to daily log");
  } catch (error) {
    logger.error({ error, filePath }, "Failed to add summary to daily log");
    throw error;
  }
}

/**
 * Get yesterday's date
 */
export function getYesterday(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
}

/**
 * Create a daily log entry from a memory update
 */
export function createDailyEntry(
  content: string,
  context: "work" | "life" | "general",
  source: DailyEntry["source"] = "conversation"
): DailyEntry {
  const time = formatTime(new Date());
  return {
    time,
    context,
    content,
    source,
  };
}

/**
 * Group entries by context
 */
export function groupEntriesByContext(
  entries: DailyEntry[]
): Record<"work" | "life" | "general", DailyEntry[]> {
  const grouped: Record<"work" | "life" | "general", DailyEntry[]> = {
    work: [],
    life: [],
    general: [],
  };

  for (const entry of entries) {
    grouped[entry.context].push(entry);
  }

  return grouped;
}
