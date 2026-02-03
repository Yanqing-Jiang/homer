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

// ============================================
// CONTEXT LOADER
// ============================================

export async function loadUserContext(config: DiscoveryEngineConfig): Promise<UserContext> {
  const [meContent, workContent, lifeContent, denyContent] = await Promise.all([
    safeReadFile(`${config.memoryDir}/me.md`),
    safeReadFile(`${config.memoryDir}/work.md`),
    safeReadFile(`${config.memoryDir}/life.md`),
    safeReadFile(config.denyHistoryFile),
  ]);

  const context: UserContext = {
    interests: extractInterests(meContent),
    goals: extractGoals(meContent),
    techStack: extractTechStack(meContent),
    preferences: extractPreferences(meContent, denyContent),
    activeProjects: extractProjects(workContent),
    careerFocus: extractCareerFocus(workContent),
    currentFocus: extractCurrentFocus(lifeContent),
    blocklist: extractBlocklist(denyContent),
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
    /trading|quant|investing|polymarket/gi,
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

function extractPreferences(_meContent: string, denyContent: string): UserContext["preferences"] {
  const boost: string[] = [];
  const deprioritize: string[] = [];
  const languages: string[] = [];

  // Extract boost patterns from deny-history.md
  const boostMatch = denyContent.match(/### Positive Signals[\s\S]*?(?=##|$)/);
  if (boostMatch?.[0]) {
    const lines = boostMatch[0].split("\n").filter(l => l.trim().startsWith("-"));
    boost.push(...lines.map(l => l.replace(/^-\s*/, "").trim().toLowerCase()).filter(Boolean));
  }

  // Extract deprioritize patterns
  const deprioritizeMatch = denyContent.match(/### Topics to Deprioritize[\s\S]*?(?=##|$)/);
  if (deprioritizeMatch?.[0]) {
    const lines = deprioritizeMatch[0].split("\n").filter(l => l.trim().startsWith("-"));
    deprioritize.push(...lines.map(l => l.replace(/^-\s*/, "").split("(")[0]?.trim().toLowerCase() ?? "").filter(Boolean));
  }

  // Extract language preferences
  const langMatch = denyContent.match(/### Languages to Deprioritize[\s\S]*?(?=##|$)/);
  if (langMatch?.[0]) {
    const lines = langMatch[0].split("\n").filter(l => l.trim().startsWith("-"));
    // Extract languages to skip (unused for now but could filter later)
    lines.map(l => l.replace(/^-\s*/, "").split("(")[0]?.trim().toLowerCase() ?? "");
    // These are languages to skip, preferred languages are the inverse
    languages.push("python", "typescript", "rust");
  } else {
    languages.push("python", "typescript", "rust");
  }

  return { boost, deprioritize, languages };
}

function extractProjects(workContent: string): UserContext["activeProjects"] {
  const projects: UserContext["activeProjects"] = [];

  // Extract from Active Projects section
  const projectsMatch = workContent.match(/## Active Projects[\s\S]*?(?=##\s|$)/);
  if (projectsMatch) {
    const sections = projectsMatch[0].split(/###\s+/);
    for (const section of sections.slice(1)) {
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

function extractCurrentFocus(lifeContent: string): string[] {
  const focus: string[] = [];

  // Extract from Upcoming section
  const upcomingMatch = lifeContent.match(/## Upcoming[\s\S]*?(?=##|$)/);
  if (upcomingMatch) {
    const keywords = extractKeywords(upcomingMatch[0]);
    focus.push(...keywords);
  }

  return focus;
}

function extractBlocklist(denyContent: string): UserContext["blocklist"] {
  const repos: string[] = [];
  const topics: string[] = [];
  const languages: string[] = [];

  // Extract blocked repos
  const reposMatch = denyContent.match(/### Already Tracking[\s\S]*?(?=###|##|$)/);
  if (reposMatch?.[0]) {
    const lines = reposMatch[0].split("\n").filter(l => l.trim().startsWith("-"));
    for (const line of lines) {
      // Extract repo name from format: "- Name (org/repo)"
      const repoMatch = line.match(/\(([^)]+)\)/);
      if (repoMatch?.[1]) {
        repos.push(repoMatch[1].toLowerCase());
      }
      // Also extract the display name
      const nameMatch = line.match(/-\s*([^(]+)/);
      if (nameMatch?.[1]) {
        repos.push(nameMatch[1].trim().toLowerCase());
      }
    }
  }

  // Extract blocked topics
  const topicsMatch = denyContent.match(/### Topics to Deprioritize[\s\S]*?(?=###|##|$)/);
  if (topicsMatch?.[0]) {
    const lines = topicsMatch[0].split("\n").filter(l => l.trim().startsWith("-"));
    topics.push(...lines.map(l => l.replace(/^-\s*/, "").split("(")[0]?.trim().toLowerCase() ?? "").filter(Boolean));
  }

  // Extract blocked languages
  const langsMatch = denyContent.match(/### Languages to Deprioritize[\s\S]*?(?=###|##|$)/);
  if (langsMatch?.[0]) {
    const lines = langsMatch[0].split("\n").filter(l => l.trim().startsWith("-"));
    languages.push(...lines.map(l => l.replace(/^-\s*/, "").split("(")[0]?.trim().toLowerCase() ?? "").filter(Boolean));
  }

  return { repos, topics, languages };
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
