/**
 * Job scanner core types. Discover → verify → filter → rank → email digest.
 * No auto-apply, no resume tailoring — notify-only by design.
 */

export interface NormalizedJob {
  id: string;                 // stable source id (hiring.cafe objectID)
  discoverySource: string;    // "hiring_cafe"
  atsSource: string | null;   // grnhse | lever | ashby | smartrecruiters | workday | ...
  boardToken: string | null;
  requisitionId: string | null;
  externalId: string | null;  // ATS-side job id (last segment of the source id)
  title: string;
  company: string;
  applyUrl: string | null;
  location: string | null;
  workplaceType: string | null;
  roleType: string | null;
  seniority: string | null;
  category: string | null;
  categoryWeight: number | null;
  yearlyMinComp: number | null;
  yearlyMaxComp: number | null;
  compTransparent: boolean;
  publishDate: string | null;
  isExpired: boolean;
  commitment: string[];
  workplaceCities: string[];
  workplaceStates: string[];
  workplaceCountries: string[];
  technicalTools: string[];
  companyTagline: string | null;
  companyIndustries: string[];
  raw: unknown;
}

export interface VerifyResult {
  live: boolean | null;       // null = could not determine
  method: "feed" | "url_probe" | "none";
}

export interface FitScore {
  id: string;
  fit: number;                // 0-10
  rationale: string;
}

export interface RankedJob {
  job: StoredPosting;
  rankScore: number;          // 0-100 composite
}

/** Row shape read back from job_scan_postings for ranking/digest. */
export interface StoredPosting {
  id: string;
  title: string;
  company: string;
  apply_url: string | null;
  location: string | null;
  workplace_type: string | null;
  role_type: string | null;
  seniority: string | null;
  category: string | null;
  category_weight: number | null;
  yearly_min_comp: number | null;
  yearly_max_comp: number | null;
  comp_transparent: number;
  publish_date: string | null;
  first_seen_at: string;
  fingerprint: string;
  repost_count: number;
  status: string;
  ats_source: string | null;
  ats_live: number | null;
  verify_method: string | null;
  fit_score: number | null;
  fit_rationale: string | null;
  rank_score: number | null;
}

/**
 * Per-run stats. Two populations by design: discovered/newJobs/rulesPassed/
 * verifiedLive count only postings first seen THIS run; scored and emailed
 * count the 72-hour backlog batch (self-healing: a scoring or email outage in
 * one run is repaired by the next), so e.g. emailed > 0 with rulesPassed = 0
 * is normal after a prior failed send.
 */
export interface RunStats {
  discovered: number;
  newJobs: number;
  rulesPassed: number;
  verifiedLive: number;
  /** Backlog-scoped: fresh-window postings LLM-scored this run, regardless of which run discovered them. */
  scored: number;
  /** Backlog-scoped: fresh-window postings included in this run's digest. */
  emailed: number;
  emailStatus: string;
  errors: string[];
}
