/**
 * hiringcafe.com discovery client (formerly hiring.cafe).
 *
 * The site is a Next.js pages-router app; search results are served by the
 * public data route /_next/data/{buildId}/index.json?searchState=<json>.
 * The buildId rotates on every deploy, so it is scraped from the homepage's
 * __NEXT_DATA__ blob and refreshed automatically on a 404/HTML response.
 *
 * DEBT: unofficial interface — if the data route closes, swap this module for
 * an Apify hiringcafe actor (~$1-2/1k jobs) behind the same NormalizedJob shape.
 */

import { logger } from "../utils/logger.js";
import type { NormalizedJob } from "./types.js";

const BASE = "https://hiringcafe.com";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 30_000;

let cachedBuildId: string | null = null;

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "*/*", Referer: `${BASE}/` },
    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`hiring.cafe ${res.status} for ${url}`);
  return res.text();
}

async function resolveBuildId(signal?: AbortSignal): Promise<string> {
  const html = await fetchText(`${BASE}/`, signal);
  const m = html.match(/"buildId":"([^"]+)"/);
  if (!m) throw new Error("hiring.cafe: buildId not found in homepage __NEXT_DATA__");
  cachedBuildId = m[1]!;
  logger.info({ buildId: cachedBuildId }, "hiring.cafe buildId resolved");
  return cachedBuildId;
}

interface SearchPage {
  hits: Record<string, unknown>[];
  totalCount: number;
  isLastPage: boolean;
}

async function fetchSearchPage(
  searchState: Record<string, unknown>,
  page: number,
  signal?: AbortSignal,
): Promise<SearchPage> {
  const buildId = cachedBuildId ?? (await resolveBuildId(signal));
  const state = { ...searchState, page };
  const url = `${BASE}/_next/data/${buildId}/index.json?searchState=${encodeURIComponent(JSON.stringify(state))}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json", "x-nextjs-data": "1", Referer: `${BASE}/` },
    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "manual",
  });
  // A stale buildId yields a 404 (or a redirect to the HTML page): refresh once.
  if (res.status === 404 || res.status >= 300) {
    await resolveBuildId(signal);
    return fetchSearchPage(searchState, page, signal);
  }
  const body = (await res.json()) as { pageProps?: Record<string, unknown> };
  const pp = body.pageProps ?? {};
  return {
    hits: (pp.ssrHits as Record<string, unknown>[] | undefined) ?? [],
    totalCount: (pp.ssrTotalCount as number | undefined) ?? 0,
    isLastPage: (pp.ssrIsLastPage as boolean | undefined) ?? true,
  };
}

/**
 * Run one discovery query. `dateWindowDays` bounds the source-side freshness
 * filter; our own first-seen timestamps remain the authoritative clock.
 */
export async function searchHiringCafe(
  query: string,
  opts: { dateWindowDays?: number; maxPages?: number; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>[]> {
  // NOTE: the source's dateFetchedPastNDays behaves like an enum — some values
  // (e.g. 2) silently return 0 results. 7 is verified-working; our own
  // first-seen dedup is the authoritative freshness clock regardless.
  const searchState: Record<string, unknown> = {
    searchQuery: query,
    dateFetchedPastNDays: opts.dateWindowDays ?? 7,
    sortBy: "date",
    workplaceTypes: ["Remote", "Hybrid", "Onsite"],
    commitmentTypes: ["Full Time"],
    locations: [
      {
        formatted_address: "United States",
        types: ["country"],
        geometry: { location: { lat: "39.8283", lon: "-98.5795" } },
        id: "user_country",
        address_components: [{ long_name: "United States", short_name: "US", types: ["country"] }],
        options: { flexible_regions: ["anywhere_in_continent", "anywhere_in_world"] },
      },
    ],
  };

  const all: Record<string, unknown>[] = [];
  const maxPages = opts.maxPages ?? 2;
  for (let page = 0; page < maxPages; page++) {
    const result = await fetchSearchPage(searchState, page, opts.signal);
    all.push(...result.hits);
    if (result.isLastPage || result.hits.length === 0) break;
    // Be a polite client on the unofficial route.
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return all;
}

/** Source payloads carry HTML entities in titles/companies; decode the common ones. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? decodeEntities(v) : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function normalizeHit(hit: Record<string, unknown>): NormalizedJob | null {
  const id = str(hit.objectID) ?? str(hit.id);
  const ji = (hit.job_information ?? {}) as Record<string, unknown>;
  const pd = (hit.v5_processed_job_data ?? {}) as Record<string, unknown>;
  const cd = (hit.enriched_company_data ?? {}) as Record<string, unknown>;
  const title = str(ji.title) ?? str(pd.core_job_title);
  const company = str(pd.company_name) ?? str(cd.name);
  if (!id || !title || !company) return null;

  // id format: "<source>___<board_token>___<external_id>"
  const idParts = id.split("___");
  return {
    id,
    discoverySource: "hiring_cafe",
    atsSource: str(hit.source),
    boardToken: str(hit.board_token),
    requisitionId: str(hit.requisition_id),
    externalId: idParts.length === 3 ? idParts[2]! : null,
    title,
    company,
    applyUrl: str(hit.apply_url),
    location: str(pd.formatted_workplace_location),
    workplaceType: str(pd.workplace_type),
    roleType: str(pd.role_type),
    seniority: str(pd.seniority_level),
    category: null,
    categoryWeight: null,
    yearlyMinComp: num(pd.yearly_min_compensation),
    yearlyMaxComp: num(pd.yearly_max_compensation),
    compTransparent: pd.is_compensation_transparent === true,
    publishDate: str(pd.estimated_publish_date),
    isExpired: hit.is_expired === true,
    commitment: strArr(pd.commitment),
    workplaceCities: strArr(pd.workplace_cities),
    workplaceStates: strArr(pd.workplace_states),
    workplaceCountries: strArr(pd.workplace_countries),
    technicalTools: strArr(pd.technical_tools),
    companyTagline: str(cd.tagline),
    companyIndustries: strArr(cd.industries),
    raw: hit,
  };
}
