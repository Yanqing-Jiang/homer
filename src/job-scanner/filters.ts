/**
 * Deterministic rules gate: taxonomy, geography (Seattle metro + Remote US),
 * comp floor, seniority sanity, and staffing-agency exclusion.
 *
 * Staffing-agency lists salvaged from the retired src/job-hunt/scorer.ts —
 * that blocklist was the proven part of the old pipeline.
 */

import { matchTitleToFamily } from "./taxonomy.js";
import type { NormalizedJob } from "./types.js";

// $250-350K target: only a LISTED band whose max is below this is
// disqualifying. Missing bands pass to LLM judgment.
export const MIN_LISTED_YEARLY_MAX = 200_000;

// The source's 7-day window is on ITS fetch date, not the posting's publish
// date — 30% of the first week's emailed jobs were >30 days old (one was 60).
// Missing/unparseable publish dates pass; the estimate errs on inclusion.
export const MAX_POSTING_AGE_DAYS = 30;

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
  "dexian", "smoothstack", "toptal", "hired", "dice", "yoh", "experis",
  "spherion", "volt", "beacon hill", "mondo", "talentbridge", "synergis",
  "mastech", "infosys bpm", "wipro", "tata consultancy", "fuel talent",
  "remotehunter", "lumicity",
]);

export function isStaffingAgency(company: string): boolean {
  const lower = company.toLowerCase().trim();
  if (STAFFING_NAME_KEYWORDS.some((kw) => lower.includes(kw))) return true;
  for (const agency of KNOWN_AGENCIES) {
    if (lower.includes(agency)) return true;
  }
  return false;
}

const SEATTLE_METRO = [
  "seattle", "bellevue", "redmond", "kirkland", "renton", "bothell",
  "woodinville", "issaquah", "sammamish", "tacoma", "everett", "tukwila",
];

function isSeattleArea(job: NormalizedJob): boolean {
  const haystacks = [
    ...job.workplaceCities.map((c) => c.toLowerCase()),
    ...job.workplaceStates.map((s) => s.toLowerCase()),
    (job.location ?? "").toLowerCase(),
  ];
  return haystacks.some(
    (h) =>
      SEATTLE_METRO.some((city) => h.includes(city)) ||
      h.includes("washington, us") ||
      /(^|[^a-z])wa([^a-z]|$)/.test(h),
  );
}

function isRemoteUs(job: NormalizedJob): boolean {
  if (job.workplaceType !== "Remote") return false;
  if (job.workplaceCountries.length === 0) {
    return (job.location ?? "").toLowerCase().includes("united states");
  }
  return job.workplaceCountries.includes("US");
}

export interface RulesVerdict {
  pass: boolean;
  reason?: string;
  category?: string;
  categoryWeight?: number;
  geography: "seattle" | "remote-us" | null;
}

export function applyRules(job: NormalizedJob): RulesVerdict {
  const fail = (reason: string): RulesVerdict => ({ pass: false, reason, geography: null });

  if (job.isExpired) return fail("expired at source");
  if (isStaffingAgency(job.company)) return fail(`staffing agency: ${job.company}`);

  const match = matchTitleToFamily(job.title);
  if (!match) return fail("title outside role families");

  if (/\b(intern|junior|jr\.|entry.level|new grad)\b/i.test(job.title)) {
    return fail("junior/intern title");
  }
  if (job.seniority === "Entry Level" || job.seniority === "No Prior Experience Required") {
    return fail(`seniority too low: ${job.seniority}`);
  }
  if (job.commitment.length > 0 && !job.commitment.includes("Full Time")) {
    return fail(`not full-time: ${job.commitment.join(",")}`);
  }
  if (/\b(security clearance|ts\/sci|secret clearance|top secret)\b/i.test(job.title)) {
    return fail("requires security clearance");
  }

  const seattle = isSeattleArea(job);
  const remoteUs = isRemoteUs(job);
  if (!seattle && !remoteUs) return fail("outside Seattle metro and not Remote-US");
  if (!job.workplaceCountries.includes("US") && job.workplaceCountries.length > 0) {
    return fail(`not a US posting: ${job.workplaceCountries.join(",")}`);
  }

  if (job.compTransparent && job.yearlyMaxComp !== null && job.yearlyMaxComp < MIN_LISTED_YEARLY_MAX) {
    return fail(`listed band max $${Math.round(job.yearlyMaxComp / 1000)}K < $${MIN_LISTED_YEARLY_MAX / 1000}K floor`);
  }

  if (job.publishDate) {
    const ageDays = (Date.now() - Date.parse(job.publishDate)) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays > MAX_POSTING_AGE_DAYS) {
      return fail(`posting ~${Math.round(ageDays)}d old (> ${MAX_POSTING_AGE_DAYS}d)`);
    }
  }

  return {
    pass: true,
    category: match.category,
    categoryWeight: match.weight,
    geography: seattle ? "seattle" : "remote-us",
  };
}

/**
 * Digest dedupe key derived from a stored fingerprint: company minus legal
 * suffixes, plus title, minus the state bucket — so "Reddit" vs "Reddit, Inc."
 * and multi-state re-cuts of one role collapse into a single digest slot.
 */
export function digestKeyFromFingerprint(fp: string): string {
  const [company = "", title = ""] = fp.split("|");
  const c = company.replace(/\b(inc|llc|corp|co|ltd|plc)\b/g, "").replace(/\s+/g, " ").trim();
  return `${c}|${title}`;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const normFpTitle = (s: string) =>
  norm(s)
    .replace(/\b(i{1,3}|iv|v|vi|1|2|3|4|5)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Repost fingerprint: normalized company | title (level noise stripped) | state bucket. */
export function fingerprintJob(job: NormalizedJob): string {
  const state = job.workplaceStates[0] ? norm(job.workplaceStates[0]) : "any";
  return `${norm(job.company)}|${normFpTitle(job.title)}|${state}`;
}

/** Digest key built directly from a company + title pair (e.g. a dismissal
 * entered by hand), matching digestKeyFromFingerprint's output for the same role. */
export function digestKeyFor(company: string, title: string): string {
  return digestKeyFromFingerprint(`${norm(company)}|${normFpTitle(title)}|any`);
}
