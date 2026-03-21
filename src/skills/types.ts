/**
 * Procedural Skill System — Type Definitions
 */

export type SkillStatus = "draft" | "observation" | "active" | "archived";

export interface SkillFrontmatter {
  id: string;
  title: string;
  status: SkillStatus;
  trigger: string;          // When to activate (natural language pattern)
  category: string;         // deploy, debug, research, code-gen, etc.
  source: "auto" | "manual" | "synthesized";
  tags?: string[];
  requires_approval?: boolean;  // For deploy/migration skills
  created: string;              // ISO date
  last_used?: string;
}

export interface Skill extends SkillFrontmatter {
  filePath: string;
  content: string;        // Full markdown content (body after frontmatter)
  contentHash: string;
  successCount: number;
  failureCount: number;
}

export interface SkillCatalogRow {
  id: string;
  title: string;
  status: SkillStatus;
  trigger_pattern: string | null;
  category: string | null;
  source: string;
  content_hash: string | null;
  file_path: string | null;
  success_count: number;
  failure_count: number;
  last_used_at: string | null;
  last_promoted_at: string | null;
  created_at: string;
  archived_at: string | null;
}

/** Compact skill metadata for session start injection (~100 tokens per skill) */
export interface SkillSummary {
  id: string;
  title: string;
  trigger: string;
  category: string;
  successRate: number;
}

/** Promotion thresholds */
export const SKILL_PROMOTION = {
  minSuccesses: 3,
  minSuccessRate: 0.60,
  maxActive: 50,
  emergencySlots: 5,
  archiveAfterDays: 30,
  purgeAfterDays: 90,
  maxPerTurn: 3,
} as const;
