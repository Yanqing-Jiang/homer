/**
 * Role families for the job scanner, tuned to Yanqing's 2026 targets:
 * management-first (DS/Analytics Mgr+, ML/AI Eng Mgr, AI PM, Principal/Sr TPM,
 * Director-level) plus comp-gated Staff Analytics/Data IC roles.
 *
 * Matching approach salvaged from the retired src/job-hunt/taxonomy.ts
 * (curated title substrings first, regex fallback second — no LLM here).
 */

export interface RoleFamily {
  /** Quoted-phrase queries issued against discovery sources. */
  queries: string[];
  /** Lowercased substrings that positively match a title to this family. */
  titles: string[];
  /** Regex fallback when no substring hits. */
  pattern: RegExp | null;
  /** 0-1 profile fit used in the composite rank. */
  weight: number;
}

export const ROLE_FAMILIES: Record<string, RoleFamily> = {
  "ds-analytics-mgmt": {
    queries: ['"data science manager"', '"analytics manager"', '"manager, data science"', '"senior manager analytics"'],
    titles: [
      "data science manager", "manager, data science", "manager of data science",
      "senior data science manager", "analytics manager", "manager, analytics",
      "manager of analytics", "senior analytics manager", "head of data science",
      "head of analytics", "insights manager", "senior manager, analytics",
      "senior manager, data",
    ],
    pattern: /\b(analytics?|data\s+scien\w*|insights)\b.*\b(manager|lead|head)\b|\b(manager|head)\b.*\b(analytics?|data scien)/i,
    weight: 1.0,
  },
  "ml-ai-eng-mgmt": {
    queries: ['"machine learning engineering manager"', '"engineering manager machine learning"', '"ai engineering manager"', '"head of ai"'],
    titles: [
      "machine learning engineering manager", "ml engineering manager",
      "engineering manager, machine learning", "engineering manager, ml",
      "engineering manager, ai", "ai engineering manager", "head of ai",
      "head of machine learning", "head of ml", "manager, machine learning",
      "manager, applied science",
    ],
    pattern: /\b(ml|machine learning|ai|artificial intelligence)\b.*\b(engineering manager|eng manager)\b|\b(engineering manager|head)\b.*\b(ml|machine learning|ai)\b/i,
    weight: 1.0,
  },
  "ai-product": {
    queries: ['"ai product manager"', '"product manager, ai"', '"principal product manager" ai'],
    titles: [
      "ai product manager", "product manager, ai", "product manager - ai",
      "product manager, machine learning", "product manager, ml",
      "senior product manager, ai", "principal product manager, ai",
      "product lead, ai", "group product manager, ai",
    ],
    pattern: /\bproduct manager\b.*\b(ai|ml|machine learning|artificial intelligence|genai|gen ai|llm)\b|\b(ai|genai)\b.*\bproduct manager\b/i,
    weight: 0.9,
  },
  "tpm": {
    queries: ['"principal technical program manager"', '"senior technical program manager"'],
    titles: [
      "principal technical program manager", "senior technical program manager",
      "principal tpm", "senior tpm", "technical program manager, ai",
      "technical program manager, machine learning", "technical program manager, data",
    ],
    pattern: /\b(principal|senior|sr\.?)\b.*\btechnical program manager\b/i,
    weight: 0.9,
  },
  "director": {
    queries: ['"director of data science"', '"director of analytics"', '"director, data"', '"director of machine learning"'],
    titles: [
      "director of data science", "director, data science", "director of analytics",
      "director, analytics", "director of machine learning", "director, machine learning",
      "director of ai", "director, ai", "director, data platform",
      "director of data platform", "director, data engineering",
      "director of data", "senior director, data", "director, insights",
      "director, business intelligence",
    ],
    pattern: /\bdirector\b.*\b(data|analytics?|machine learning|ml|ai|insights|business intelligence)\b/i,
    weight: 1.0,
  },
  "staff-analytics-ic": {
    queries: ['"staff analytics engineer"', '"principal analytics engineer"', '"staff data engineer"'],
    titles: [
      "staff analytics engineer", "principal analytics engineer",
      "lead analytics engineer", "staff data engineer", "principal data engineer",
      "principal product analytics", "staff data scientist", "principal data scientist",
    ],
    pattern: /\b(staff|principal|lead)\b.*\b(analytics? engineer|data engineer|data scientist)\b/i,
    weight: 0.8,
  },
};

export function matchTitleToFamily(title: string): { category: string; weight: number } | null {
  const lower = title.toLowerCase();
  for (const [key, fam] of Object.entries(ROLE_FAMILIES)) {
    for (const t of fam.titles) {
      if (lower.includes(t)) return { category: key, weight: fam.weight };
    }
  }
  for (const [key, fam] of Object.entries(ROLE_FAMILIES)) {
    if (fam.pattern?.test(title)) return { category: key, weight: fam.weight * 0.9 };
  }
  return null;
}

/** All discovery queries with their family key, deduplicated. */
export function discoveryQueries(): { category: string; query: string }[] {
  const out: { category: string; query: string }[] = [];
  const seen = new Set<string>();
  for (const [key, fam] of Object.entries(ROLE_FAMILIES)) {
    for (const q of fam.queries) {
      if (!seen.has(q)) {
        seen.add(q);
        out.push({ category: key, query: q });
      }
    }
  }
  return out;
}
