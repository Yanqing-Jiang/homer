/**
 * Role families for the job scanner, tuned to Yanqing's 2026 targets:
 * management/leadership only (DS/Analytics Mgr+, ML/AI Eng Mgr, analytics-
 * domain PM, Director-level). IC roles — including all software engineering
 * ICs — are out entirely (Yanqing, 2026-08-18). Pure PM and all TPM/program
 * roles are out (Yanqing, 2026-08-19).
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
      "manager, applied science", "manager of ai engineering",
      "manager, ai engineering", "ai engineering lead",
      "machine learning manager", "senior machine learning manager",
    ],
    pattern: /\b(ml|machine learning|ai|artificial intelligence)\b.*\b(engineering manager|eng manager)\b|\b(engineering manager|manager|head)\b.*\b(ml|machine learning|ai|applied science)\b/i,
    weight: 1.0,
  },
  // PM roles survive only with an analytics/data domain in the title — pure
  // product management (AI or otherwise) is excluded at the rules gate
  // (Yanqing, 2026-08-19).
  "analytics-product": {
    queries: ['"product manager" analytics', '"product manager, analytics"', '"product manager tech"'],
    titles: [
      "product manager, analytics", "product manager - analytics",
      "analytics product manager", "data product manager",
      "product manager, data", "product manager, insights",
      // Amazon's PM-T idiom ("Principal Product Manager Tech", "Principal PMT")
      // — normalizeTitle expands "pmt" to "product manager tech". The rules
      // gate still drops PM-Ts without an analytics/data domain in the title.
      "product manager tech", "product manager - tech", "product manager, tech",
    ],
    pattern: /\bproduct manager\b.*\b(analytics?|insights?|data|experimentation|measurement)\b|\b(analytics?|data)\b.*\bproduct manager\b/i,
    weight: 0.9,
  },
  "ai-agents": {
    queries: ['"agentic" manager', '"ai agents" product', '"generative ai" director'],
    titles: [
      "director of agents", "head of agents", "agent platform",
    ],
    pattern: /\b(agent(s|ic)?|gen(erative)?\s?ai|genai)\b.*\b(product manager|manager|director|lead|head)\b|\b(head|director)\b.*\bagents?\b/i,
    weight: 1.0,
  },
  // TPM family removed entirely — program-management roles are not a fit
  // (Yanqing, 2026-08-19); the rules gate also rejects any TPM title that
  // sneaks in through another family's pattern.
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
};

/** Expand employer title shorthand so substring/pattern matching sees the
 * canonical vocabulary: Sr→senior, Mgr→manager, Amazon's PMT/PM-T idiom. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\bsr\.?\b/g, "senior")
    .replace(/\bmgr\.?\b/g, "manager")
    .replace(/\bpm-?t\b/g, "product manager tech");
}

export function matchTitleToFamily(title: string): { category: string; weight: number } | null {
  const lower = normalizeTitle(title);
  for (const [key, fam] of Object.entries(ROLE_FAMILIES)) {
    for (const t of fam.titles) {
      if (lower.includes(t)) return { category: key, weight: fam.weight };
    }
  }
  for (const [key, fam] of Object.entries(ROLE_FAMILIES)) {
    if (fam.pattern?.test(lower)) return { category: key, weight: fam.weight * 0.9 };
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
