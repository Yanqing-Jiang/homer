/**
 * Simplified JD scoring engine — binary pass/fail + priority tiers.
 * No LLM calls. Quantity > precision: if it fits, apply.
 */

import { matchTitleToCategory } from "./taxonomy.js";

// ── Types ─────────────────────────────────────────────────────────

export interface ScoringResult {
  totalScore: number; // 0 (rejected) or 0.60-0.90 (priority tier)
  priority: "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "rejected";
  matchAnalysis: string;
  qualifiedReasons: string[];
  disqualifyReasons: string[];
  dealBreakers: string[];
  workArrangement: "remote" | "hybrid" | "onsite" | null;
}

export interface JobPosting {
  id: string;
  title: string;
  company: string;
  location?: string;
  description: string;
  salary_min?: number;
  salary_max?: number;
  url?: string;
}

// ── Company Tiers ────────────────────────────────────────────────

const TIER1 = new Set(["google", "microsoft", "meta", "amazon", "apple", "netflix"]);
const TIER2 = new Set([
  "stripe", "databricks", "snowflake", "airbnb", "uber", "doordash",
  "coinbase", "figma", "notion", "openai", "anthropic",
]);
const TIER3 = new Set([
  "salesforce", "adobe", "atlassian", "palantir", "confluent",
  "dbt labs", "fivetran", "monte carlo", "datadog", "elastic",
  "confluent", "hashicorp", "twilio", "square", "block",
]);

// ── Staffing Agency Detection (3-layer) ─────────────────────────

const STAFFING_NAME_KEYWORDS = [
  "staffing", "recruiting", "recruitment", "talent solutions", "talent acquisition",
  "consulting firm", "temp agency", "workforce solutions", "placement",
  "search firm", "headhunter", "executive search", "contract staffing",
];

const KNOWN_AGENCIES = new Set([
  "harnham", "robert half", "insight global", "teksystems", "kforce",
  "apex systems", "aerotek", "aston carter", "cybercoders", "jobot",
  "randstad", "manpower", "adecco", "kelly services", "hays",
  "michael page", "motion recruitment", "collabera", "revature", "actalent",
  "dexian", "smoothstack", "recruits lab", "7seventy recruiting", "toptal",
  "hired", "dice", "yoh", "experis", "spherion", "volt",
  "beacon hill", "mondo", "talentbridge", "synergis", "mastech",
  "cognizant", "infosys bpm", "wipro", "tata consultancy",
]);

const STAFFING_JD_PATTERNS = [
  /our client\s+(?:is\s+)?(?:seeking|looking|hiring)/i,
  /hiring\s+(?:for|on behalf of)/i,
  /on behalf of our client/i,
  /\b(?:w2|1099|c2c)\s*(?:contract|position|role)/i,
  /rate:\s*\$\d+\s*\/\s*hr/i,
  /this\s+position\s+is\s+with\s+our\s+client/i,
  /we\s+are\s+a\s+(?:staffing|recruiting|recruitment)/i,
  /contract\s+to\s+(?:hire|perm)/i,
  /our\s+(?:Fortune|F)\s*\d+\s*client/i,
  /client\s+(?:company|organization)\s+(?:is|has)/i,
];

export function isStaffingAgency(company: string, jdText: string): boolean {
  const lower = company.toLowerCase().trim();

  // Layer 1: company name keywords
  for (const kw of STAFFING_NAME_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }

  // Layer 2: known agency names
  for (const agency of KNOWN_AGENCIES) {
    if (lower.includes(agency)) return true;
  }

  // Layer 3: JD text patterns
  for (const pat of STAFFING_JD_PATTERNS) {
    if (pat.test(jdText)) return true;
  }

  return false;
}

// ── Work Arrangement Detection ──────────────────────────────────

export function detectWorkArrangement(
  text: string,
  location?: string
): "remote" | "hybrid" | "onsite" | null {
  // Check hybrid first (more specific)
  if (/\bhybrid\b/i.test(text) || /\d+\s*days?\s*(?:in[- ]?office|on[- ]?site)/i.test(text)) {
    return "hybrid";
  }

  // Remote signals
  if (
    /fully\s*remote/i.test(text) ||
    /100%\s*remote/i.test(text) ||
    /remote\s*(?:first|only|friendly)/i.test(text) ||
    /work\s*from\s*home/i.test(text) ||
    /\bremote\s*(?:position|role|opportunity)\b/i.test(text)
  ) {
    return "remote";
  }

  // On-site signals
  if (
    /on[- ]?site\s*(?:only|required)/i.test(text) ||
    /must\s+be\s+located/i.test(text) ||
    /no\s+remote/i.test(text) ||
    /in[- ]?office\s*(?:only|required)/i.test(text)
  ) {
    return "onsite";
  }

  // Location field fallback
  if (location) {
    const locLower = location.toLowerCase();
    if (locLower === "remote" || locLower.includes("remote")) return "remote";
    if (locLower.includes("hybrid")) return "hybrid";
  }

  return null;
}

export function isNearSeattle(location?: string): boolean {
  if (!location) return false;
  const lower = location.toLowerCase();
  const seattleArea = [
    "seattle", "bellevue", "redmond", "kirkland", "renton", "bothell",
    "woodinville", "issaquah", "sammamish", ", wa",
  ];
  return seattleArea.some((area) => lower.includes(area));
}

// ── Main Scorer ─────────────────────────────────────────────────

export function scoreJob(posting: JobPosting): ScoringResult {
  const text = `${posting.title} ${posting.description}`.toLowerCase();
  const arrangement = detectWorkArrangement(posting.description, posting.location);

  // Step 1: Deal-breaker check
  const dealBreakers = checkDealBreakers(posting, text);
  if (dealBreakers.length > 0) {
    return {
      totalScore: 0,
      priority: "rejected",
      matchAnalysis: `REJECTED: ${dealBreakers.join("; ")}`,
      qualifiedReasons: [],
      disqualifyReasons: dealBreakers,
      dealBreakers,
      workArrangement: arrangement,
    };
  }

  // Step 2: Title relevance check
  const titleMatch = matchTitleToCategory(posting.title);
  const hasRelevantKeywords = /\b(data|ml|machine learning|ai|analytics|scientist|artificial intelligence|engineering manager|staff engineer|principal engineer|genai|gen ai)\b/i.test(posting.title);
  if (!titleMatch && !hasRelevantKeywords) {
    return {
      totalScore: 0,
      priority: "rejected",
      matchAnalysis: `REJECTED: Unrelated title "${posting.title}"`,
      qualifiedReasons: [],
      disqualifyReasons: [`Title "${posting.title}" doesn't match any role category`],
      dealBreakers: [],
      workArrangement: arrangement,
    };
  }

  // Step 3: Assign priority tier
  const companyTier = getCompanyTier(posting.company);
  const nearSeattle = isNearSeattle(posting.location);
  const isLocalOrOnsite = nearSeattle && (arrangement === "hybrid" || arrangement === "onsite");

  let priority: ScoringResult["priority"];
  let score: number;

  if (companyTier <= 2 && isLocalOrOnsite) {
    priority = "P1"; score = 0.90;
  } else if (companyTier <= 2) {
    priority = "P2"; score = 0.80;
  } else if (companyTier <= 3 && isLocalOrOnsite) {
    priority = "P3"; score = 0.75;
  } else if (companyTier <= 3) {
    priority = "P4"; score = 0.70;
  } else if (isLocalOrOnsite) {
    priority = "P5"; score = 0.65;
  } else {
    priority = "P6"; score = 0.60;
  }

  // Step 4: Build match analysis
  const tierLabel = companyTier <= 2 ? `Tier ${companyTier}` : companyTier === 3 ? "Tier 3" : "Unknown";
  const arrLabel = arrangement ?? "unknown";
  const salaryLabel = formatSalaryLabel(posting);
  const categoryLabel = titleMatch?.category ?? "keyword-match";
  const matchAnalysis = `${priority} | ${posting.company} (${tierLabel}) | ${posting.title} [${categoryLabel}] | ${arrLabel} | ${salaryLabel}`;

  const qualifiedReasons: string[] = [];
  if (titleMatch) qualifiedReasons.push(`Title match: ${titleMatch.category} (weight ${titleMatch.weight})`);
  if (companyTier <= 2) qualifiedReasons.push(`Top-tier company (Tier ${companyTier})`);
  if (nearSeattle) qualifiedReasons.push("Seattle area");

  return {
    totalScore: score,
    priority,
    matchAnalysis,
    qualifiedReasons,
    disqualifyReasons: [],
    dealBreakers: [],
    workArrangement: arrangement,
  };
}

// ── Deal-Breaker Detection ──────────────────────────────────────

function checkDealBreakers(posting: JobPosting, text: string): string[] {
  const breaks: string[] = [];

  // Staffing agency (3-layer)
  if (isStaffingAgency(posting.company, posting.description)) {
    breaks.push(`Staffing/recruiting agency: ${posting.company}`);
  }

  // Security clearance
  if (/\b(security clearance|ts\/sci|secret clearance|top secret)\b/i.test(text)) {
    breaks.push("Requires security clearance");
  }

  // Contract/temp (without full-time signal)
  if (
    /\b(contract|contractor|temp(orary)?|freelance)\b/i.test(text) &&
    !/\b(full.time|permanent|fte|salary)\b/i.test(text)
  ) {
    breaks.push("Contract/temporary position");
  }

  // Salary below $250K total comp
  if (posting.salary_max && posting.salary_max < 250000) {
    breaks.push(`TC below $250K (max: $${(posting.salary_max / 1000).toFixed(0)}K)`);
  }

  // Relocation required outside Seattle
  if (/relocation\s+required/i.test(text)) {
    const loc = (posting.location ?? "").toLowerCase();
    if (!isNearSeattle(posting.location) && !loc.includes("remote")) {
      breaks.push("Relocation required outside Seattle area");
    }
  }

  // Pre-Series B startup
  if (/\b(seed|pre.seed|series\s*a\b)/i.test(text) && !/\bseries\s*[b-z]/i.test(text)) {
    breaks.push("Startup < Series B");
  }

  // Pure management (no IC) — exclude Engineering Manager and technical management
  const titleLower = posting.title.toLowerCase();
  if (
    /\b(director|vp|head of|chief)\b/.test(titleLower) &&
    !/\b(engineer|scientist|architect|technical|data)\b/.test(titleLower) &&
    !/\b(engineering manager|em|eng manager)\b/i.test(titleLower)
  ) {
    if (!/\b(ic|individual contributor|hands.on|coding)\b/i.test(text)) {
      breaks.push("Pure management role (no technical component)");
    }
  }

  return breaks;
}

// ── Helpers ─────────────────────────────────────────────────────

function getCompanyTier(company: string): number {
  const lower = company.toLowerCase().trim();

  if (TIER1.has(lower)) return 1;
  if (TIER2.has(lower)) return 2;
  if (TIER3.has(lower)) return 3;

  // Partial match (e.g., "Google LLC" → "google")
  for (const t of TIER1) { if (lower.includes(t)) return 1; }
  for (const t of TIER2) { if (lower.includes(t)) return 2; }
  for (const t of TIER3) { if (lower.includes(t)) return 3; }

  return 99; // unknown
}

function formatSalaryLabel(posting: JobPosting): string {
  if (posting.salary_min && posting.salary_max) {
    return `$${(posting.salary_min / 1000).toFixed(0)}K-$${(posting.salary_max / 1000).toFixed(0)}K`;
  }
  if (posting.salary_max) {
    return `up to $${(posting.salary_max / 1000).toFixed(0)}K`;
  }
  return "not listed";
}
