/**
 * Night Mode Context Loader
 *
 * Builds the context pack for the night supervisor by loading
 * memory files, daily logs, and system state.
 *
 * NOTE: For general context loading, see src/runtime/context.ts
 * This module builds a specialized context pack with night supervisor instructions.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import type { ContextPack, NightModeConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { logger } from "../utils/logger.js";

// ============================================
// FILE LOADING HELPERS
// ============================================

async function safeReadFile(path: string): Promise<string> {
  try {
    if (!existsSync(path)) {
      return "";
    }
    return await readFile(path, "utf-8");
  } catch (error) {
    logger.warn({ path, error }, "Failed to read file for context");
    return "";
  }
}

function getTodayDate(): string {
  return new Date().toISOString().split("T")[0] ?? "";
}

function getRecentDates(days: number): string[] {
  const dates: string[] = [];
  for (let i = 0; i < days; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    dates.push(date.toISOString().split("T")[0] ?? "");
  }
  return dates.filter(Boolean);
}

// ============================================
// MAIN CONTEXT BUILDER
// ============================================

export async function buildContextPack(
  config: NightModeConfig = DEFAULT_CONFIG
): Promise<ContextPack> {
  const { memoryDir, outputDir } = config;
  const dailyDir = join(memoryDir, "daily");

  logger.info("Building context pack for night supervisor");

  // Load today's daily log
  const today = getTodayDate();
  const dailyLogPath = join(dailyDir, `${today}.md`);
  const dailyLog = await safeReadFile(dailyLogPath);

  // Load recent logs (last 3 days)
  const recentDates = getRecentDates(3);
  const recentLogs: string[] = [];
  for (const date of recentDates) {
    if (date === today) continue; // Skip today, already loaded
    const log = await safeReadFile(join(dailyDir, `${date}.md`));
    if (log) {
      recentLogs.push(`## ${date}\n\n${log}`);
    }
  }

  // Load permanent memory files
  const permanentMemory = {
    me: await safeReadFile(join(memoryDir, "me.md")),
    work: await safeReadFile(join(memoryDir, "work.md")),
    life: await safeReadFile(join(memoryDir, "life.md")),
    tools: await safeReadFile(join(memoryDir, "tools.md")),
  };

  // Load ideas.md for pending ideas
  const ideasContent = await safeReadFile(join(memoryDir, "ideas.md"));
  const pendingIdeas = extractPendingIdeas(ideasContent);

  // Extract active projects from work.md
  const activeProjects = extractActiveProjects(permanentMemory.work);

  // Build system info
  const systemInfo = buildSystemInfo();

  // Load last morning briefing if exists
  const lastBriefingPath = join(outputDir, "handoffs", "morning_briefing.md");
  const lastBriefing = await safeReadFile(lastBriefingPath);

  // Compile everything into the context prompt
  const compiled = compileContextPrompt({
    dailyLog,
    recentLogs,
    permanentMemory,
    pendingIdeas,
    activeProjects,
    systemInfo,
    lastBriefing,
  });

  logger.debug(
    {
      dailyLogLength: dailyLog.length,
      recentLogsCount: recentLogs.length,
      pendingIdeasCount: pendingIdeas.length,
      activeProjectsCount: activeProjects.length,
      compiledLength: compiled.length,
    },
    "Context pack built"
  );

  return {
    dailyLog,
    recentLogs,
    permanentMemory,
    pendingIdeas,
    activeProjects,
    systemInfo,
    lastBriefing: lastBriefing || undefined,
    compiled,
  };
}

// ============================================
// EXTRACTION HELPERS
// ============================================

function extractPendingIdeas(ideasContent: string): string[] {
  if (!ideasContent) return [];

  const ideas: string[] = [];
  const lines = ideasContent.split("\n");

  let currentIdea = "";
  let inIdea = false;

  for (const line of lines) {
    // Look for idea headers (## or ### with status indicators)
    if (line.match(/^#{2,3}\s+.+/)) {
      if (currentIdea && inIdea) {
        ideas.push(currentIdea.trim());
      }
      // Check if it's not archived/completed
      if (!line.toLowerCase().includes("[archived]") &&
          !line.toLowerCase().includes("[done]") &&
          !line.toLowerCase().includes("[completed]")) {
        currentIdea = line;
        inIdea = true;
      } else {
        inIdea = false;
      }
    } else if (inIdea) {
      currentIdea += "\n" + line;
    }
  }

  if (currentIdea && inIdea) {
    ideas.push(currentIdea.trim());
  }

  return ideas.slice(0, 10); // Limit to 10 most recent
}

function extractActiveProjects(workContent: string): string[] {
  if (!workContent) return [];

  const projects: string[] = [];

  // Look for ## Projects section
  const projectsMatch = workContent.match(/## Projects[\s\S]*?(?=##|$)/i);
  if (projectsMatch) {
    const projectsSection = projectsMatch[0];
    // Extract bullet points
    const bullets = projectsSection.match(/^[-*]\s+.+$/gm);
    if (bullets) {
      projects.push(...bullets.map(b => b.replace(/^[-*]\s+/, "")));
    }
  }

  return projects.slice(0, 10); // Limit to 10
}

function buildSystemInfo(): string {
  const now = new Date();
  return `
System Time: ${now.toISOString()}
Local Time: ${now.toLocaleString()}
Day of Week: ${now.toLocaleDateString("en-US", { weekday: "long" })}
Platform: ${process.platform}
Node Version: ${process.version}
`.trim();
}

// ============================================
// CONTEXT PROMPT COMPILATION
// ============================================

interface ContextComponents {
  dailyLog: string;
  recentLogs: string[];
  permanentMemory: {
    me: string;
    work: string;
    life: string;
    tools: string;
  };
  pendingIdeas: string[];
  activeProjects: string[];
  systemInfo: string;
  lastBriefing?: string;
}

function compileContextPrompt(components: ContextComponents): string {
  const {
    dailyLog,
    recentLogs,
    permanentMemory,
    pendingIdeas,
    activeProjects,
    systemInfo,
    lastBriefing,
  } = components;

  // Build the context in sections
  const sections: string[] = [];

  // System info
  sections.push(`# Night Mode Context Pack

## System Information
${systemInfo}`);

  // Today's context
  if (dailyLog) {
    sections.push(`## Today's Daily Log
${truncateIfNeeded(dailyLog, 10000)}`);
  }

  // Recent context (summarized)
  if (recentLogs.length > 0) {
    sections.push(`## Recent Activity (Last 3 Days)
${truncateIfNeeded(recentLogs.join("\n\n---\n\n"), 8000)}`);
  }

  // Identity and work context
  if (permanentMemory.me) {
    sections.push(`## Identity (me.md)
${truncateIfNeeded(permanentMemory.me, 3000)}`);
  }

  if (permanentMemory.work) {
    sections.push(`## Work Context (work.md)
${truncateIfNeeded(permanentMemory.work, 5000)}`);
  }

  // Active projects
  if (activeProjects.length > 0) {
    sections.push(`## Active Projects
${activeProjects.map(p => `- ${p}`).join("\n")}`);
  }

  // Pending ideas
  if (pendingIdeas.length > 0) {
    sections.push(`## Pending Ideas
${pendingIdeas.slice(0, 5).join("\n\n---\n\n")}`);
  }

  // Tools configuration (for context on what's available)
  if (permanentMemory.tools) {
    sections.push(`## Available Tools (tools.md)
${truncateIfNeeded(permanentMemory.tools, 2000)}`);
  }

  // Last briefing for continuity
  if (lastBriefing) {
    sections.push(`## Previous Morning Briefing
${truncateIfNeeded(lastBriefing, 2000)}`);
  }

  // Instructions
  sections.push(`## Night Supervisor Instructions

You are the Night Supervisor for HOMER. Your role is to:
1. Analyze the context above
2. Plan research and exploration tasks
3. Identify opportunities for project enhancements
4. Draft proposals for changes (never execute directly)
5. Generate a morning briefing

Return your plan as JSON:
{
  "summary": "Brief overview of tonight's plan",
  "research_tasks": [
    {"id": "r1", "query": "what to research", "priority": "high|medium|low"}
  ],
  "ideas_to_explore": [
    {"id": "i1", "topic": "idea topic", "connection_to_projects": "optional"}
  ],
  "code_proposals": [
    {"id": "c1", "description": "what to change", "target_project": "project name", "risk": "low|medium|high"}
  ],
  "priority_actions": ["action 1", "action 2"]
}

Constraints:
- Maximum 10 research tasks
- Maximum 3 code proposals
- Focus on HIGH-value, actionable items
- Consider risk levels carefully
- Code changes require verification before execution`);

  return sections.join("\n\n---\n\n");
}

function truncateIfNeeded(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength) + "\n\n[... truncated for context limit ...]";
}

// ============================================
// CONTEXT REFRESH (for ongoing sessions)
// ============================================

export async function refreshDailyLog(
  config: NightModeConfig = DEFAULT_CONFIG
): Promise<string> {
  const dailyLogPath = join(config.memoryDir, "daily", `${getTodayDate()}.md`);
  return await safeReadFile(dailyLogPath);
}

export async function getLatestIdeas(
  config: NightModeConfig = DEFAULT_CONFIG,
  limit: number = 5
): Promise<string[]> {
  const ideasContent = await safeReadFile(join(config.memoryDir, "ideas.md"));
  return extractPendingIdeas(ideasContent).slice(0, limit);
}
