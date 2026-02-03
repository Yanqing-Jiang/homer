/**
 * Unified Context Manager
 *
 * Consolidates context loading from memory files for all HOMER subsystems.
 * Provides both raw file contents and extracted structured data.
 *
 * Used by:
 * - Discovery engine (relevance scoring)
 * - Night supervisor (context pack)
 * - Any agent needing user context
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { logger } from "../utils/logger.js";

// Maximum characters to include in context (safe for 128k token models)
const MAX_CONTEXT_CHARS = 100000;

// ============================================
// TYPES
// ============================================

export interface RawContext {
  me: string;
  work: string;
  life: string;
  tools: string;
  recentLogs: string[];
}

export interface StructuredContext {
  interests: string[];
  goals: string[];
  techStack: string[];
  activeProjects: string[];
  careerFocus: string[];
  currentFocus: string[];
}

export interface UnifiedContext {
  raw: RawContext;
  structured: StructuredContext;
}

// ============================================
// MAIN LOADER
// ============================================

/**
 * Load complete context from memory files
 */
export async function loadContext(
  memoryDir: string = `${process.env.HOME}/memory`
): Promise<UnifiedContext> {
  const [me, work, life, tools] = await Promise.all([
    safeReadFile(join(memoryDir, "me.md")),
    safeReadFile(join(memoryDir, "work.md")),
    safeReadFile(join(memoryDir, "life.md")),
    safeReadFile(join(memoryDir, "tools.md")),
  ]);

  const recentLogs = await loadRecentDailyLogs(memoryDir, 3);

  return {
    raw: { me, work, life, tools, recentLogs },
    structured: extractStructuredData(me, work, life),
  };
}

/**
 * Load only raw context (faster, no extraction)
 */
export async function loadRawContext(
  memoryDir: string = `${process.env.HOME}/memory`
): Promise<RawContext> {
  const [me, work, life, tools] = await Promise.all([
    safeReadFile(join(memoryDir, "me.md")),
    safeReadFile(join(memoryDir, "work.md")),
    safeReadFile(join(memoryDir, "life.md")),
    safeReadFile(join(memoryDir, "tools.md")),
  ]);

  const recentLogs = await loadRecentDailyLogs(memoryDir, 3);

  return { me, work, life, tools, recentLogs };
}

// ============================================
// FILE HELPERS
// ============================================

async function safeReadFile(path: string): Promise<string> {
  try {
    if (!existsSync(path)) {
      return "";
    }
    return await readFile(path, "utf-8");
  } catch (error) {
    logger.warn({ path, error }, "Failed to read context file");
    return "";
  }
}

async function loadRecentDailyLogs(
  memoryDir: string,
  days: number
): Promise<string[]> {
  const logs: string[] = [];
  const dailyDir = join(memoryDir, "daily");

  for (let i = 0; i < days; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split("T")[0];
    const logPath = join(dailyDir, `${dateStr}.md`);

    const content = await safeReadFile(logPath);
    if (content) {
      logs.push(content);
    }
  }

  return logs;
}

// ============================================
// STRUCTURED EXTRACTION
// ============================================

function extractStructuredData(
  meContent: string,
  workContent: string,
  lifeContent: string
): StructuredContext {
  return {
    interests: extractInterests(meContent),
    goals: extractGoals(meContent),
    techStack: extractTechStack(meContent),
    activeProjects: extractActiveProjects(workContent),
    careerFocus: extractCareerFocus(workContent),
    currentFocus: extractCurrentFocus(lifeContent),
  };
}

function extractInterests(content: string): string[] {
  const interests: string[] = [];

  // Match against known interest patterns
  const patterns = [
    /AI|artificial intelligence|machine learning|ML/gi,
    /analytics|data science|data engineering/gi,
    /automation|workflow|productivity/gi,
    /agent|agentic|orchestration/gi,
    /trading|quant|investing/gi,
    /side income|monetization|revenue/gi,
    /CLI|command line|terminal/gi,
    /TypeScript|Python|Rust/gi,
  ];

  for (const pattern of patterns) {
    if (pattern.test(content)) {
      const match = pattern.source.split("|")[0]?.toLowerCase();
      if (match) interests.push(match);
    }
  }

  // Extract from Goals section
  const goalsMatch = content.match(/## Goals[\s\S]*?(?=##|$)/);
  if (goalsMatch) {
    interests.push(...extractKeywords(goalsMatch[0]));
  }

  return [...new Set(interests)];
}

function extractGoals(content: string): string[] {
  const goals: string[] = [];

  // Short-term goals
  const shortTermMatch = content.match(/### Short-Term[\s\S]*?(?=###|##|$)/);
  if (shortTermMatch) {
    const lines = shortTermMatch[0]
      .split("\n")
      .filter((l) => l.trim().startsWith("-") || /^\d+\./.test(l.trim()));
    goals.push(
      ...lines.map((l) => l.replace(/^[\d\-.\s]+/, "").trim()).filter(Boolean)
    );
  }

  // Long-term goals
  const longTermMatch = content.match(/### Long-Term[\s\S]*?(?=###|##|$)/);
  if (longTermMatch) {
    const lines = longTermMatch[0]
      .split("\n")
      .filter((l) => l.trim().startsWith("-"));
    goals.push(
      ...lines.map((l) => l.replace(/^-\s*/, "").trim()).filter(Boolean)
    );
  }

  return goals;
}

function extractTechStack(content: string): string[] {
  const stack: string[] = [];

  // Extract from Tech section
  const techMatch = content.match(/\*\*Tech:\*\*([^\n]+)/);
  if (techMatch?.[1]) {
    const techs = techMatch[1].split(/[,;]/).map((t) => t.trim().toLowerCase());
    stack.push(...techs.filter(Boolean));
  }

  // Add defaults
  const defaults = ["typescript", "python", "sql"];
  for (const d of defaults) {
    if (!stack.includes(d)) stack.push(d);
  }

  return [...new Set(stack)];
}

function extractActiveProjects(content: string): string[] {
  const projects: string[] = [];

  // Look for ## Projects or ## Active Projects section
  const projectsMatch = content.match(/## (?:Active )?Projects[\s\S]*?(?=##\s|$)/i);
  if (projectsMatch) {
    // Extract ### headers as project names
    const headers = projectsMatch[0].match(/### ([^\n]+)/g);
    if (headers) {
      projects.push(...headers.map((h) => h.replace(/^### /, "").trim()));
    }

    // Also extract bullet points
    const bullets = projectsMatch[0].match(/^[-*]\s+([^\n]+)/gm);
    if (bullets) {
      projects.push(...bullets.map((b) => b.replace(/^[-*]\s+/, "").trim()));
    }
  }

  return [...new Set(projects)].slice(0, 10);
}

function extractCareerFocus(content: string): string[] {
  const focus: string[] = [];

  // Extract from Career Target section
  const careerMatch = content.match(/## Career Target[\s\S]*?(?=##|$)/);
  if (careerMatch) {
    focus.push(...extractKeywords(careerMatch[0]));
  }

  // Extract from Positioning section
  const positioningMatch = content.match(/### Positioning[\s\S]*?(?=###|##|$)/);
  if (positioningMatch) {
    const lines = positioningMatch[0]
      .split("\n")
      .filter((l) => l.trim().startsWith("-"));
    focus.push(
      ...lines.map((l) => l.replace(/^-\s*/, "").trim()).filter(Boolean)
    );
  }

  return focus;
}

function extractCurrentFocus(content: string): string[] {
  const focus: string[] = [];

  // Extract from Upcoming section
  const upcomingMatch = content.match(/## Upcoming[\s\S]*?(?=##|$)/);
  if (upcomingMatch) {
    focus.push(...extractKeywords(upcomingMatch[0]));
  }

  return focus;
}

function extractKeywords(text: string): string[] {
  const keywords: string[] = [];

  // Remove markdown formatting
  const cleaned = text
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/#+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Extract tech terms
  const techTerms = [
    "AI", "ML", "LLM", "API", "CLI", "SQL",
    "Python", "TypeScript", "Rust", "React", "Node",
    "agent", "automation", "analytics", "pipeline", "dashboard",
  ];

  for (const term of techTerms) {
    if (cleaned.toLowerCase().includes(term.toLowerCase())) {
      keywords.push(term.toLowerCase());
    }
  }

  return [...new Set(keywords)];
}

// ============================================
// CONTEXT TRUNCATION
// ============================================

/**
 * Truncate context to fit within token limits
 */
export function truncateForContext(
  text: string,
  maxChars: number = MAX_CONTEXT_CHARS
): string {
  if (text.length <= maxChars) return text;
  return "...[truncated]...\n" + text.slice(-maxChars);
}

/**
 * Build a context string suitable for LLM prompts
 */
export function buildContextPrompt(context: UnifiedContext): string {
  const sections: string[] = [];

  if (context.raw.me) {
    sections.push(`## Identity (me.md)\n${truncateForContext(context.raw.me, 3000)}`);
  }

  if (context.raw.work) {
    sections.push(`## Work Context (work.md)\n${truncateForContext(context.raw.work, 5000)}`);
  }

  if (context.structured.interests.length > 0) {
    sections.push(`## Interests\n${context.structured.interests.join(", ")}`);
  }

  if (context.structured.activeProjects.length > 0) {
    sections.push(`## Active Projects\n${context.structured.activeProjects.map((p) => `- ${p}`).join("\n")}`);
  }

  if (context.raw.recentLogs.length > 0) {
    const recentActivity = context.raw.recentLogs
      .slice(0, 2)
      .map((log) => truncateForContext(log, 2000))
      .join("\n\n---\n\n");
    sections.push(`## Recent Activity\n${recentActivity}`);
  }

  return sections.join("\n\n---\n\n");
}
