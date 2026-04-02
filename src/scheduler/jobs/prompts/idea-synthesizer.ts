/**
 * Versioned prompt registry for idea-synthesizer pipeline.
 *
 * Loads skill files, computes content hashes, and provides
 * a manifest for harness version tracking.
 */

import { readFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";

const HOME = process.env.HOME ?? "/Users/yj";

export const SKILL_PATHS = {
  score: join(HOME, ".claude/skills/idea-score/SKILLS.md"),
  synthesize: join(HOME, ".claude/skills/idea-synthesize/SKILLS.md"),
  critique: join(HOME, ".claude/skills/idea-critique/SKILLS.md"),
  enrich: join(HOME, ".claude/skills/idea-enrich/SKILLS.md"),
} as const;

export type PromptSection = keyof typeof SKILL_PATHS;

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function loadSkill(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

/** Loaded prompt content, cached per process lifetime */
let _cache: Record<PromptSection, string> | null = null;

export function getPrompts(): Record<PromptSection, string> {
  if (!_cache) {
    _cache = {
      score: loadSkill(SKILL_PATHS.score),
      synthesize: loadSkill(SKILL_PATHS.synthesize),
      critique: loadSkill(SKILL_PATHS.critique),
      enrich: loadSkill(SKILL_PATHS.enrich),
    };
  }
  return _cache;
}

/** Force reload (useful after prompt file changes) */
export function reloadPrompts(): void {
  _cache = null;
}

/**
 * Build a prompt manifest: section name → content hash.
 * Used for harness version tracking.
 */
export function getPromptManifest(): Record<PromptSection, string> {
  const prompts = getPrompts();
  return {
    score: hashContent(prompts.score),
    synthesize: hashContent(prompts.synthesize),
    critique: hashContent(prompts.critique),
    enrich: hashContent(prompts.enrich),
  };
}

/**
 * Combined hash of all prompt sections — identifies the overall harness version.
 */
export function getManifestHash(): string {
  const manifest = getPromptManifest();
  const combined = Object.values(manifest).sort().join(":");
  return hashContent(combined);
}

/**
 * Get the source file hash for the idea-synthesizer handler itself.
 */
export function getSourceHash(): string {
  try {
    const srcPath = join(HOME, "homer/src/scheduler/jobs/idea-synthesizer.ts");
    if (existsSync(srcPath)) {
      return hashContent(readFileSync(srcPath, "utf-8"));
    }
  } catch { /* ignore */ }
  return "unknown";
}
