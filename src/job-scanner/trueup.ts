/**
 * Lenny's Jobs discovery client (lennysjobs.com), served by the TrueUp job
 * platform at arc.trueup.io. The site is a Next.js app whose jobs page runs an
 * Algolia InstantSearch UI, but queries are proxied through TrueUp's own
 * endpoint (POST https://arc.trueup.io/jobs/search) rather than Algolia
 * directly. The request body is a bare array of Algolia-style
 * `{indexName,params}` objects carrying `trueupRequestVersion:2` and
 * `trueupPartnerId:"lenny"`.
 *
 * Anonymous requests are signed with an `x-rc` header:
 *   x-rc = HMAC-SHA256(key = TOTP(SIGNING_SECRET), msg = "/jobs/search")[:16]
 * TOTP is otplib defaults (SHA1, 6 digits, 30s step, ascii-keyed). The secret
 * is hardcoded in the site's JS bundle.
 *
 * DEBT: unofficial interface. Both the signing secret and the endpoint contract
 * are lifted from the client bundle (chunk pages/_app + jobs). If discovery
 * starts returning 401/"Unauthorized", the secret rotated — re-extract it from
 * https://www.lennysjobs.com/_next/static/chunks/pages/_app-*.js (search for
 * `createHmac("sha256"` and the adjacent `o.generate("...")` literal). If the
 * body shape 400s, re-check the `j(e,s)` transform in the jobs page chunk.
 */

import { createHmac } from "crypto";
import { logger } from "../utils/logger.js";
import type { NormalizedJob } from "./types.js";

const SEARCH_URL = "https://arc.trueup.io/jobs/search";
const SIGN_PATH = "/jobs/search";
const PARTNER_ID = "lenny";
const ORIGIN = "https://www.lennysjobs.com";
// Lifted from the site JS bundle — see DEBT above.
const SIGNING_SECRET = "aA>nDcM@KMQV4Fb#:0xpR%}k}#6fPTqo";
const FETCH_TIMEOUT_MS = 30_000;

// Seattle is a single city-level facet on TrueUp (no separate Bellevue/Redmond
// values); it excludes their distinct "Remote" and "United States (remote)"
// facets, so faceting to it enforces the Seattle-metro + no-fully-remote rule
// at the source before the local gate runs.
const SEATTLE_FACET = "job_locations_combined:\u{1F1FA}\u{1F1F8} Seattle";

// otplib-compatible HOTP (SHA1, 6 digits, ascii-keyed → hex, 8-byte BE counter).
function hotp(secretAscii: string, counter: number): string {
  const key = Buffer.from(secretAscii, "ascii");
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(msg).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(bin % 1_000_000).padStart(6, "0");
}

/** x-rc request signature keyed on the current 30s TOTP window. */
function signRequest(): string {
  const token = hotp(SIGNING_SECRET, Math.floor(Date.now() / 1000 / 30));
  return createHmac("sha256", token).update(SIGN_PATH).digest("hex").slice(0, 16);
}

interface TrueUpResult {
  hits: Record<string, unknown>[];
  nbHits: number;
}

async function postSearch(params: Record<string, unknown>, signal?: AbortSignal): Promise<TrueUpResult> {
  const res = await fetch(SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
      "x-rc": signRequest(),
    },
    body: JSON.stringify([
      { indexName: "job", params: { trueupRequestVersion: 2, trueupPartnerId: PARTNER_ID, ...params } },
    ]),
    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`trueup ${res.status} for ${SEARCH_URL}`);
  const body = (await res.json()) as { results?: { hits?: Record<string, unknown>[]; nbHits?: number }[] };
  const first = body.results?.[0];
  if (!first) throw new Error("trueup: empty results array");
  return { hits: first.hits ?? [], nbHits: first.nbHits ?? 0 };
}

/**
 * Run one Seattle-scoped discovery query against Lenny's Jobs. `dateWindowDays`
 * bounds the source-side freshness filter on `updated_at_timestamp`; our own
 * first-seen timestamps remain the authoritative clock.
 */
export async function searchTrueUp(
  query: string,
  opts: { dateWindowDays?: number; hitsPerPage?: number; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>[]> {
  const windowDays = opts.dateWindowDays ?? 7;
  const cutoff = Math.floor(Date.now() / 1000) - windowDays * 86_400;
  const result = await postSearch(
    {
      query,
      hitsPerPage: opts.hitsPerPage ?? 50,
      page: 0,
      facetFilters: [[SEATTLE_FACET]],
      numericFilters: [`updated_at_timestamp >= ${cutoff}`],
    },
    opts.signal,
  );
  logger.info({ query, returned: result.hits.length, nbHits: result.nbHits }, "lennys jobs discovery");
  return result.hits;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// TrueUp ats_job_ref prefixes → the atsSource values verify.ts feed-checks.
// Unmapped prefixes (xx/wd/cm/ri/...) fall back to the apply-URL probe.
const ATS_PREFIX: Record<string, string> = { gh: "grnhse", lv: "lever", as: "ashby", sr: "smartrecruiters" };

export function normalizeTrueUpHit(hit: Record<string, unknown>): NormalizedJob | null {
  const objectID = str(hit.objectID) ?? str(hit.job_id);
  const title = str(hit.title);
  const company = str(hit.company_name);
  if (!objectID || !title || !company) return null;

  // ats_job_ref: "<prefix>-<board_token>-<external_id>" (external id may itself
  // contain dashes, so split only the leading two segments).
  let atsSource: string | null = null;
  let boardToken: string | null = null;
  let externalId: string | null = null;
  const ref = str(hit.ats_job_ref);
  if (ref) {
    const dash1 = ref.indexOf("-");
    const dash2 = dash1 >= 0 ? ref.indexOf("-", dash1 + 1) : -1;
    if (dash1 > 0 && dash2 > dash1) {
      atsSource = ATS_PREFIX[ref.slice(0, dash1)] ?? null;
      boardToken = ref.slice(dash1 + 1, dash2);
      externalId = ref.slice(dash2 + 1);
    }
  }

  const location = str(hit.location);
  const ts = num(hit.updated_at_timestamp);
  const min = num(hit.salary_range_min);
  const max = num(hit.salary_range_max);

  return {
    id: `trueup___${objectID}`,
    discoverySource: "lennys_jobs",
    // Only set atsSource when the board token is also known, so verify.ts's
    // feed path (which needs all three) is never half-armed.
    atsSource: boardToken ? atsSource : null,
    boardToken,
    requisitionId: null,
    externalId,
    title,
    company,
    applyUrl: str(hit.url),
    location,
    // Seattle-faceted hits are location-bound, never fully remote (that is a
    // separate TrueUp facet); leaving this null keeps them past the rules gate.
    workplaceType: null,
    roleType: null,
    seniority: null,
    category: null,
    categoryWeight: null,
    yearlyMinComp: min,
    yearlyMaxComp: max,
    compTransparent: min !== null || max !== null,
    // TrueUp exposes updated_at, not a distinct publish date. It errs toward
    // freshness (a re-index bumps it), consistent with the gate's inclusion
    // bias; the ATS verify step is the real liveness check.
    publishDate: ts !== null ? new Date(ts * 1000).toISOString() : str(hit.updated_at),
    isExpired: false,
    commitment: [],
    workplaceCities: location ? [location] : [],
    workplaceStates: ["WA"],
    workplaceCountries: ["US"],
    technicalTools: Array.isArray(hit.description_tags)
      ? (hit.description_tags as unknown[]).filter((x): x is string => typeof x === "string")
      : [],
    companyTagline: str(hit.business_description_short),
    companyIndustries: [],
    raw: hit,
  };
}
