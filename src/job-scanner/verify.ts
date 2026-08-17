/**
 * Tier-1 authenticity check: a posting only counts as verified when it is
 * live on the employer's own ATS feed. Aggregator "posted X ago" dates are
 * never trusted; this check plus our own first-seen timestamps are the only
 * freshness/authenticity signals in the rank.
 *
 * Feed verification covers Greenhouse / Lever / Ashby / SmartRecruiters
 * (public JSON, no auth). Everything else (Workday, Avature, ...) falls back
 * to a soft apply-URL probe, which earns a lower authenticity score.
 */

import { logger } from "../utils/logger.js";
import type { NormalizedJob, VerifyResult } from "./types.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";
const FEED_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 15_000;

const DEAD_PAGE_PATTERNS =
  /(no longer (?:available|accepting|active|open)|job (?:not found|has been filled|posting.{0,20}(?:closed|expired))|position (?:has been )?(?:filled|closed)|this (?:job|posting|position) (?:is closed|has expired)|requisition.{0,20}not found)/i;

type FeedIds = Set<string>;
const feedCache = new Map<string, FeedIds | null>();

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: signal ?? AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return res.json();
}

/** Fetch the employer's board feed once per run; returns null if unavailable. */
async function getFeedIds(atsSource: string, boardToken: string, signal?: AbortSignal): Promise<FeedIds | null> {
  const cacheKey = `${atsSource}:${boardToken}`;
  if (feedCache.has(cacheKey)) return feedCache.get(cacheKey)!;

  let ids: FeedIds | null = null;
  try {
    if (atsSource === "grnhse") {
      const data = (await fetchJson(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs?content=false`,
        signal,
      )) as { jobs?: { id?: number | string }[] };
      ids = new Set((data.jobs ?? []).map((j) => String(j.id)));
    } else if (atsSource === "lever") {
      const data = (await fetchJson(
        `https://api.lever.co/v0/postings/${encodeURIComponent(boardToken)}?mode=json`,
        signal,
      )) as { id?: string }[];
      ids = new Set((Array.isArray(data) ? data : []).map((j) => String(j.id)));
    } else if (atsSource === "ashby") {
      const data = (await fetchJson(
        `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(boardToken)}`,
        signal,
      )) as { jobs?: { id?: string }[] };
      ids = new Set((data.jobs ?? []).map((j) => String(j.id)));
    } else if (atsSource === "smartrecruiters") {
      const data = (await fetchJson(
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(boardToken)}/postings?limit=100`,
        signal,
      )) as { content?: { id?: string }[] };
      ids = new Set((data.content ?? []).map((j) => String(j.id)));
    }
  } catch (error) {
    logger.warn({ atsSource, boardToken, error: String(error) }, "job-scanner: ATS feed fetch failed");
    ids = null;
  }
  feedCache.set(cacheKey, ids);
  return ids;
}

/** Soft check: does the apply URL still serve a live-looking page? */
async function probeApplyUrl(url: string, signal?: AbortSignal): Promise<boolean | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,*/*" },
      signal: signal ?? AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: "follow",
    });
    if (res.status === 404 || res.status === 410) return false;
    if (!res.ok) return null; // 403/429/5xx: bot-walled or transient — unknown, not dead
    const text = (await res.text()).slice(0, 200_000);
    return DEAD_PAGE_PATTERNS.test(text) ? false : true;
  } catch {
    return null;
  }
}

export async function verifyJob(job: NormalizedJob, signal?: AbortSignal): Promise<VerifyResult> {
  if (job.atsSource && job.boardToken && job.externalId) {
    const ids = await getFeedIds(job.atsSource, job.boardToken, signal);
    if (ids) return { live: ids.has(job.externalId), method: "feed" };
  }
  if (job.applyUrl) {
    return { live: await probeApplyUrl(job.applyUrl, signal), method: "url_probe" };
  }
  return { live: null, method: "none" };
}

/** Reset the per-run feed cache (call at the start of each scheduler run). */
export function resetVerifyCache(): void {
  feedCache.clear();
}
