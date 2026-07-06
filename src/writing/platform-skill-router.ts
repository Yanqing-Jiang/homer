/**
 * Platform skill router — injects current virality patterns from patterns.md
 * into the relevant write-{platform}/SKILL.md at call time.
 *
 * Dynamic injection (no SKILL.md mutation): patterns are read from disk
 * and appended to the skill content in memory. SKILL.md stays clean.
 */

import { existsSync, readFileSync } from "fs";
import { PATHS } from "../config/paths.js";
import { getRuntimePaths } from "../utils/runtime-paths.js";

export type WritingPlatform = "medium" | "linkedin" | "x";

const PATTERNS_PATH = PATHS.patterns;
const HOME = getRuntimePaths().homeDir;

const SKILL_PATHS: Record<WritingPlatform, string> = {
  medium: `${HOME}/.claude/skills/write-medium/SKILL.md`,
  linkedin: `${HOME}/.claude/skills/write-linkedin/SKILL.md`,
  x: `${HOME}/.claude/skills/write-x/SKILL.md`,
};

function extractPlatformSection(markdown: string, platform: WritingPlatform): string | null {
  const re = new RegExp(`^##\\s+${platform}\\b([\\s\\S]*?)(?=^##\\s+|$)`, "im");
  const m = markdown.match(re);
  if (!m) return null;
  const body = (m[1] ?? "").trim();
  // Must have at least one table row (not just the header)
  const hasRows = body.split("\n").some(l => l.startsWith("|") && !l.includes("---") && !/hook_type/i.test(l));
  return hasRows ? `## ${platform}\n${body}\n` : null;
}

/**
 * Reads patterns.md and appends the platform-specific virality table to skillContent.
 * Does NOT mutate any file. Safe to call in any context.
 */
export function injectPlatformPatterns(
  platform: WritingPlatform,
  skillContent: string,
): string {
  if (!existsSync(PATTERNS_PATH)) return skillContent;

  const patternsMd = readFileSync(PATTERNS_PATH, "utf-8");
  const section = extractPlatformSection(patternsMd, platform);
  if (!section) return skillContent;

  return [
    skillContent.trimEnd(),
    "",
    "## Runtime Virality Patterns (Auto-Injected)",
    "The following patterns were extracted from recently scraped high-performing content.",
    "Use them to inform your hook choice and structure — do not copy lines verbatim.",
    "",
    section.trim(),
    "",
  ].join("\n");
}

/**
 * Detect writing platform from a user prompt string.
 */
export function detectPlatform(userPrompt: string): WritingPlatform {
  const lower = userPrompt.toLowerCase();
  if (lower.includes("linkedin") || lower.includes("post") || lower.includes("career")) return "linkedin";
  if (lower.includes("twitter") || lower.includes("x.com") || lower.includes("thread") || lower.includes("tweet")) return "x";
  // Default to medium for article-style tasks
  return "medium";
}

/**
 * Platform-aware skill router for the write-article skill.
 * Loads the correct SKILL.md and injects current platform virality patterns.
 */
export function routeToWritingSkill(
  platform: WritingPlatform,
): { skillPath: string; skillContent: string } {
  let skillPath = SKILL_PATHS[platform];

  // Graceful fallback: write-x/SKILL.md may not exist yet
  if (!existsSync(skillPath) && platform === "x") {
    skillPath = SKILL_PATHS.linkedin;
  }

  if (!existsSync(skillPath)) {
    throw new Error(`Missing SKILL.md for platform "${platform}" at ${skillPath}`);
  }

  const baseSkill = readFileSync(skillPath, "utf-8");
  const skillContent = injectPlatformPatterns(platform, baseSkill);

  return { skillPath, skillContent };
}
