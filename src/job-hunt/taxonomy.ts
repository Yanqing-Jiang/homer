/**
 * Job title taxonomy and search URL generation for multi-category discovery.
 */

export interface RoleCategory {
  titles: string[];
  searchTerms: string[];
  weight: number; // 0-1, how well this category fits Yanqing's profile
}

export const ROLE_CATEGORIES: Record<string, RoleCategory> = {
  "ml-engineer": {
    titles: [
      "ML Engineer", "Machine Learning Engineer", "AI Engineer", "AI/ML Engineer",
      "Applied ML Engineer", "Senior ML Engineer", "Staff ML Engineer",
    ],
    searchTerms: ["ML Engineer", "Machine Learning Engineer", "AI Engineer"],
    weight: 1.0,
  },
  "data-platform": {
    titles: [
      "Data Platform Engineer", "Data Infrastructure Engineer", "Analytics Engineer",
      "Senior Data Engineer", "Staff Data Engineer", "Data Engineering Lead",
    ],
    searchTerms: ["Data Platform Engineer", "Analytics Engineer", "Senior Data Engineer"],
    weight: 0.95,
  },
  "data-science": {
    titles: [
      "Staff Data Scientist", "Senior Data Scientist", "Principal Data Scientist",
      "Data Science Lead", "Data Scientist - ML",
    ],
    searchTerms: ["Staff Data Scientist", "Senior Data Scientist"],
    weight: 0.90,
  },
  "applied-science": {
    titles: [
      "Applied Scientist", "Research Scientist - Applied", "ML Research Scientist",
    ],
    searchTerms: ["Applied Scientist", "Research Scientist ML"],
    weight: 0.80,
  },
  "engineering-management": {
    titles: [
      "Engineering Manager - Data/ML", "Director of Data Science",
      "Head of Analytics", "VP Data", "Data Science Manager",
    ],
    searchTerms: ["Engineering Manager ML", "Director Data Science"],
    weight: 0.70,
  },
  "product-technical": {
    titles: [
      "Technical Product Manager - Data/ML", "Product Manager - AI Platform",
    ],
    searchTerms: ["Technical Product Manager ML"],
    weight: 0.60,
  },
  "solutions-architecture": {
    titles: [
      "Solutions Architect - Data/ML", "Technical Architect - Analytics",
      "Principal Architect - Data Platform",
    ],
    searchTerms: ["Solutions Architect Data", "Technical Architect Analytics"],
    weight: 0.75,
  },
};

/**
 * Check if a job title matches any category; returns category key + weight.
 */
export function matchTitleToCategory(title: string): { category: string; weight: number } | null {
  const lower = title.toLowerCase();
  for (const [key, cat] of Object.entries(ROLE_CATEGORIES)) {
    for (const t of cat.titles) {
      if (lower.includes(t.toLowerCase())) {
        return { category: key, weight: cat.weight };
      }
    }
  }
  // Fuzzy: check for common keywords
  if (/\b(ml|machine learning|ai)\b/i.test(title) && /\bengineer/i.test(title)) {
    return { category: "ml-engineer", weight: 0.85 };
  }
  if (/\bdata\s+(platform|infrastructure)\b/i.test(title)) {
    return { category: "data-platform", weight: 0.80 };
  }
  if (/\bdata\s+scien/i.test(title) && /\b(senior|staff|principal|lead)\b/i.test(title)) {
    return { category: "data-science", weight: 0.80 };
  }
  return null;
}

/**
 * Generate LinkedIn search URLs for a given location + timeframe.
 */
export function generateSearchUrls(
  categories: string[] = Object.keys(ROLE_CATEGORIES),
  location = "Seattle, WA",
  timeframe: "past_week" | "past_24h" | "past_month" = "past_week"
): { category: string; url: string }[] {
  const timeMap = { past_24h: "r86400", past_week: "r604800", past_month: "r2592000" };
  const tpr = timeMap[timeframe];
  const loc = encodeURIComponent(location);

  const urls: { category: string; url: string }[] = [];
  for (const catKey of categories) {
    const cat = ROLE_CATEGORIES[catKey];
    if (!cat) continue;
    for (const term of cat.searchTerms) {
      const kw = encodeURIComponent(term);
      urls.push({
        category: catKey,
        url: `https://www.linkedin.com/jobs/search/?keywords=${kw}&location=${loc}&f_SB2=5&f_E=4&f_TPR=${tpr}`,
      });
    }
  }
  return urls;
}

/**
 * Known title-level seniority mapping (used by scorer for YoE estimation).
 */
export function inferSeniorityYears(title: string): { min: number; max: number } | null {
  const lower = title.toLowerCase();
  if (/\b(principal|distinguished|fellow)\b/.test(lower)) return { min: 12, max: 20 };
  if (/\bstaff\b/.test(lower)) return { min: 8, max: 15 };
  if (/\b(senior|sr\.?)\b/.test(lower)) return { min: 5, max: 12 };
  if (/\b(mid|mid-level)\b/.test(lower)) return { min: 3, max: 7 };
  if (/\b(junior|jr\.?|entry|associate)\b/.test(lower)) return { min: 0, max: 3 };
  if (/\b(lead|head|director|vp)\b/.test(lower)) return { min: 8, max: 20 };
  return null;
}
