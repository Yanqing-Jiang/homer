/**
 * LLM fit scoring (batched, one harness call per run) and the composite
 * rank formula: 40% fit, 25% authenticity, 15% seniority/family fit,
 * 15% comp evidence, 5% geography, minus repost penalties.
 */

import { z } from "zod";
import type { NormalizedJob, StoredPosting } from "./types.js";

export const FitScoreSchema = z.array(
  z.object({
    id: z.string(),
    fit: z.number().min(0).max(10),
    rationale: z.string(),
  }),
);
export type FitScores = z.infer<typeof FitScoreSchema>;

const PROFILE = `Candidate profile: Yanqing Jiang — senior analytics/AI leader in Seattle.
~10 years in ecommerce and Amazon-ads analytics leadership (CPG/P&G), leading
analyst teams and executive reporting; hands-on builder of LLM/agent systems
(Claude/GPT agents, MCP, scraping/data pipelines, TypeScript/Python/SQL).
Targets: $200K+ total comp. Role families, in preference order:
1) Data Science / Analytics Manager or Senior Manager
2) ML/AI Engineering Manager, Head of AI
3) Director of Data Science / Analytics / AI / Data Platform
4) AI Product Manager (Senior/Principal)
5) Principal/Senior Technical Program Manager (AI/data)
6) Staff/Principal Analytics or Data Engineer (IC, only if comp clearly $200K+)
Location: Seattle metro (onsite/hybrid fine) or Remote US.`;

export function buildScoringPrompt(jobs: NormalizedJob[]): string {
  const items = jobs.map((j) => ({
    id: j.id,
    title: j.title,
    company: j.company,
    company_blurb: j.companyTagline,
    industries: j.companyIndustries.slice(0, 4),
    comp: j.compTransparent ? `$${j.yearlyMinComp ?? "?"}-$${j.yearlyMaxComp ?? "?"}/yr listed` : "not listed",
    location: j.location,
    workplace: j.workplaceType,
    role_type: j.roleType,
    seniority: j.seniority,
    tools: j.technicalTools.slice(0, 10),
  }));

  return `You are scoring job postings for fit against one candidate. Return ONLY a JSON array, no prose.

${PROFILE}

Score each posting 0-10 for how strongly the candidate should prioritize applying:
- 9-10: near-perfect — right family, right seniority, credible $200K+, strong domain overlap (ads/ecommerce/retail/analytics/AI)
- 7-8: strong fit worth applying same-day
- 5-6: plausible but a stretch (seniority off by a level, domain distant, comp doubtful)
- 0-4: weak fit (wrong function, too junior/senior, likely under $200K, poor domain match)
Judge comp realistically when not listed (company size/stage/industry). Keep each rationale under 140 characters, concrete, no fluff.

Postings:
${JSON.stringify(items, null, 1)}

Output format (JSON array only): [{"id": "...", "fit": 8.5, "rationale": "..."}]`;
}

/** Composite 0-100 rank from stored posting state. */
export function computeRankScore(p: StoredPosting): number {
  const fit = ((p.fit_score ?? 0) / 10) * 40;

  let authenticity = 0;
  if (p.ats_live === 1 && p.verify_method === "feed") authenticity = 25;
  else if (p.ats_live === 1) authenticity = 15;
  else if (p.ats_live === null || p.ats_live === undefined) authenticity = 8;
  // ats_live === 0 postings are excluded upstream (status = expired)

  const repostPenalty = p.repost_count >= 3 ? 25 : p.repost_count === 2 ? 12 : p.repost_count === 1 ? 5 : 0;

  const seniority = (p.category_weight ?? 0.5) * 15;

  let comp = 6; // band not listed: neutral, LLM already judged plausibility
  if (p.comp_transparent === 1 && p.yearly_max_comp !== null) {
    comp = p.yearly_max_comp >= 200_000 ? 15 : p.yearly_max_comp >= 170_000 ? 8 : 0;
  }

  const geo = isSeattleLocation(p.location) ? 5 : p.workplace_type === "Remote" ? 4 : 2;

  const score = fit + authenticity + seniority + comp + geo - repostPenalty;
  return Math.max(0, Math.min(100, Math.round(score * 10) / 10));
}

function isSeattleLocation(location: string | null): boolean {
  if (!location) return false;
  const l = location.toLowerCase();
  return ["seattle", "bellevue", "redmond", "kirkland", "washington"].some((c) => l.includes(c));
}
