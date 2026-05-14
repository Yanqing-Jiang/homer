/**
 * Context Loader (Discovery-specific)
 *
 * Loads user context from memory files for relevance scoring.
 * Extracts interests, goals, projects, and blocklist from memory files.
 *
 * NOTE: For general context loading, see src/runtime/context.ts
 * This module extends the base with discovery-specific fields (blocklist, preferences).
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import type { UserContext, DiscoveryEngineConfig } from "./types.js";
import { getCurrentFocus } from "../memory/session-bootstrap.js";

// ============================================
// CONTEXT LOADER
// ============================================

export async function loadUserContext(config: DiscoveryEngineConfig): Promise<UserContext> {
  const [meContent, workContent] = await Promise.all([
    safeReadFile(`${config.memoryDir}/me.md`),
    safeReadFile(`${config.memoryDir}/work.md`),
  ]);

  // Goals come from getCurrentFocus() so the scorer in discovery/scorer.ts:180
  // ranks recommendations against ACTIVE focus only — paused items (MAHORAGA,
  // Career OS automation) must not boost recommendations. Falls back to the
  // legacy raw extractGoals if the focus parser fails (e.g. me.md missing).
  let goals: string[] = [];
  try {
    const focus = await getCurrentFocus();
    goals = focus.active.map((s) => s.split("—")[0]!.trim()).filter(Boolean);
  } catch {
    goals = extractGoals(meContent);
  }

  const context: UserContext = {
    interests: extractInterests(meContent),
    goals,
    techStack: extractTechStack(meContent),
    preferences: extractPreferences(),
    activeProjects: extractProjects(workContent),
    careerFocus: extractCareerFocus(workContent),
    currentFocus: extractCurrentFocus(workContent),
    blocklist: { repos: [], topics: [], languages: [] },
    seenItems: new Set(),
  };

  return context;
}

// ============================================
// FILE READING
// ============================================

async function safeReadFile(path: string): Promise<string> {
  if (!existsSync(path)) {
    return "";
  }
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

// ============================================
// EXTRACTION FUNCTIONS
// ============================================

function extractInterests(meContent: string): string[] {
  const interests: string[] = [];

  // Explicit interests from me.md
  const explicitPatterns = [
    /AI|artificial intelligence|machine learning|ML/gi,
    /analytics|data science|data engineering/gi,
    /automation|workflow|productivity/gi,
    /agent|agentic|orchestration/gi,
    /side income|monetization|revenue/gi,
    /CLI|command line|terminal/gi,
    /TypeScript|Python/gi,
  ];

  for (const pattern of explicitPatterns) {
    if (pattern.test(meContent)) {
      interests.push(pattern.source.replace(/\|/g, ", ").toLowerCase());
    }
  }

  // Extract from goals section
  const goalsMatch = meContent.match(/## Goals[\s\S]*?(?=##|$)/);
  if (goalsMatch) {
    const keywords = extractKeywords(goalsMatch[0]);
    interests.push(...keywords);
  }

  // Extract from ambition section
  const ambitionMatch = meContent.match(/## Ambition[\s\S]*?(?=##|$)/);
  if (ambitionMatch) {
    const keywords = extractKeywords(ambitionMatch[0]);
    interests.push(...keywords);
  }

  return [...new Set(interests)];
}

function extractGoals(meContent: string): string[] {
  const goals: string[] = [];

  // Short-term goals
  const shortTermMatch = meContent.match(/### Short-Term[\s\S]*?(?=###|##|$)/);
  if (shortTermMatch) {
    const lines = shortTermMatch[0].split("\n").filter(l => l.trim().startsWith("-") || /^\d+\./.test(l.trim()));
    goals.push(...lines.map(l => l.replace(/^[\d\-\.\s]+/, "").trim()).filter(Boolean));
  }

  // Long-term goals
  const longTermMatch = meContent.match(/### Long-Term[\s\S]*?(?=###|##|$)/);
  if (longTermMatch) {
    const lines = longTermMatch[0].split("\n").filter(l => l.trim().startsWith("-"));
    goals.push(...lines.map(l => l.replace(/^-\s*/, "").trim()).filter(Boolean));
  }

  return goals;
}

function extractTechStack(meContent: string): string[] {
  const stack: string[] = [];

  // Extract from Tech section
  const techMatch = meContent.match(/\*\*Tech:\*\*([^\n]+)/);
  if (techMatch?.[1]) {
    const techs = techMatch[1].split(/[,;]/).map(t => t.trim().toLowerCase());
    stack.push(...techs.filter(Boolean));
  }

  // Add known preferences
  const knownStack = ["typescript", "python", "sql", "claude", "databricks"];
  stack.push(...knownStack);

  return [...new Set(stack)];
}

function extractPreferences(): UserContext["preferences"] {
  // deny-history.md was the source for boost/deprioritize. With it removed,
  // we default to the preferred-language list only.
  return {
    boost: [],
    deprioritize: [],
    languages: ["python", "typescript", "rust"],
  };
}

function extractProjects(workContent: string): UserContext["activeProjects"] {
  const projects: UserContext["activeProjects"] = [];

  // Extract from Active Projects section. Skip any block whose body contains
  // `**Status:** paused` — those are context-only, not active. (See
  // ~/homer/src/memory/session-bootstrap.ts for the canonical projection.)
  const projectsMatch = workContent.match(/## Active Projects[\s\S]*?(?=##\s|$)/);
  if (projectsMatch) {
    const sections = projectsMatch[0].split(/###\s+/);
    for (const section of sections.slice(1)) {
      if (/\*\*Status:\*\*[^\n]*?\bpaused\b/i.test(section)) continue;
      const lines = section.split("\n");
      const name = lines[0]?.trim();
      if (name) {
        const keywords = extractKeywords(section);
        projects.push({ name, keywords });
      }
    }
  }

  // Add HOMER-specific keywords
  projects.push({
    name: "HOMER",
    keywords: ["agent", "automation", "scheduler", "claude", "memory", "discovery"],
  });

  return projects;
}

function extractCareerFocus(workContent: string): string[] {
  const focus: string[] = [];

  // Extract from Career Target section
  const careerMatch = workContent.match(/## Career Target[\s\S]*?(?=##|$)/);
  if (careerMatch) {
    const keywords = extractKeywords(careerMatch[0]);
    focus.push(...keywords);
  }

  // Extract from Positioning section
  const positioningMatch = workContent.match(/### Positioning[\s\S]*?(?=###|##|$)/);
  if (positioningMatch) {
    const lines = positioningMatch[0].split("\n").filter(l => l.trim().startsWith("-"));
    focus.push(...lines.map(l => l.replace(/^-\s*/, "").trim()).filter(Boolean));
  }

  return focus;
}

function extractCurrentFocus(workContent: string): string[] {
  const focus: string[] = [];

  // Extract from Upcoming section (e.g. in work.md)
  const upcomingMatch = workContent.match(/## Upcoming[\s\S]*?(?=##|$)/);
  if (upcomingMatch) {
    const keywords = extractKeywords(upcomingMatch[0]);
    focus.push(...keywords);
  }

  return focus;
}

// ============================================
// KEYWORD EXTRACTION
// ============================================

function extractKeywords(text: string): string[] {
  const keywords: string[] = [];

  // Remove markdown formatting
  const cleaned = text
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/#+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Extract capitalized phrases (likely proper nouns/tech terms)
  const capitalizedMatch = cleaned.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g);
  if (capitalizedMatch) {
    keywords.push(...capitalizedMatch.map(k => k.toLowerCase()));
  }

  // Extract tech terms
  const techTerms = [
    "AI", "ML", "LLM", "API", "CLI", "SQL", "AWS", "GCP", "Azure",
    "Python", "TypeScript", "Rust", "React", "Node",
    "agent", "automation", "analytics", "pipeline", "dashboard",
    "Databricks", "Power BI", "Claude", "GPT", "Gemini",
  ];

  for (const term of techTerms) {
    if (cleaned.toLowerCase().includes(term.toLowerCase())) {
      keywords.push(term.toLowerCase());
    }
  }

  return [...new Set(keywords)];
}
