/**
 * Daily Delta Premium Select → Delta One upgrade offer watch.
 *
 * Scrapes logged-in My Trips (CDP Chrome :9222) for PNR GBEMBL (SEA→ICN),
 * appends history, writes latest.json + offers-by-date.json for morning-brief
 * (JSON-only; no brief-snippet.html),
 * and surfaces a Telegram decision_request when cash ≤ alert threshold or
 * drops ≥ dropPctVs7dMedian vs 7-day median.
 *
 * If the Delta session expired, re-logins via Chrome saved credentials
 * (autofill first; Keychain decrypt of primary Login Data as fallback).
 * Never persists credentials to Homer files. Never clicks UPGRADE / purchases.
 */

import { execFile } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "fs";
import { join } from "path";
import { PATHS } from "../../config/paths.js";
import { withScrapeLock, connectScrapeBackend, resetScrapeBackend } from "../../executors/agent-browser-scrape.js";
import { getChromeSavedLogin } from "../../scraping/chrome-login-data.js";
import { logger } from "../../utils/logger.js";
import type { NotificationIntent } from "../../notifications/types.js";

const AGENT_BROWSER = "agent-browser";
const WATCH_DIR = join(PATHS.homerData, "watches", "delta-upgrade");
const CONFIG_PATH = join(WATCH_DIR, "config.json");
const HISTORY_PATH = join(WATCH_DIR, "history.jsonl");
const LATEST_PATH = join(WATCH_DIR, "latest.json");
const OFFERS_BY_DATE_PATH = join(WATCH_DIR, "offers-by-date.json");
const FAIL_STREAK_PATH = join(WATCH_DIR, "fail-streak.json");
const OFFER_TZ = "America/Los_Angeles";

export interface DeltaUpgradeWatchResult {
  success: boolean;
  output: string;
  error?: string;
  notificationIntent?: NotificationIntent;
}

interface WatchConfig {
  pnr: string;
  route: string;
  flightDate: string;
  flight: string;
  passengers: number;
  alertCashUsd: number | null;
  alertMiles: number | null;
  dropPctVs7dMedian: number;
  upcomingTripsUrl: string;
}

interface OfferSnapshot {
  ts: string;
  source: string;
  pnr: string;
  route: string;
  flightDate: string;
  flight: string;
  cabin: string | null;
  cashUsdPerPax: number | null;
  milesPerPax: number | null;
  available: boolean;
  raw: string | null;
  loginOk: boolean;
  error?: string;
}

/** One scrape sample nested under YYYY-MM-DD (America/Los_Angeles). */
interface OfferByTimeEntry {
  time: string;
  ts: string;
  source: string;
  cabin: string | null;
  cashUsdPerPax: number | null;
  milesPerPax: number | null;
  available: boolean;
  raw: string | null;
  loginOk: boolean;
  error?: string;
}

interface OffersByDateFile {
  meta: {
    pnr: string;
    route: string;
    flightDate: string;
    flight: string;
    passengers: number;
    alertCashUsd: number | null;
    tz: string;
    updatedAt: string;
  };
  byDate: Record<string, OfferByTimeEntry[]>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Scheduler abort signal for the in-flight run. Module-scoped rather than threaded
 * through all 17 execAb() call sites: the DB is_running lock guarantees only one
 * delta-upgrade-watch executes per process, same reasoning as chrome-launcher's
 * lastCdpUseAt. Set at the top of runDeltaUpgradeWatch, cleared when it returns.
 */
let jobSignal: AbortSignal | undefined;

function execAb(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      AGENT_BROWSER,
      args,
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, signal: jobSignal },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { stderr?: string };
          e.stderr = stderr;
          reject(e);
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

function loadConfig(): WatchConfig {
  const defaults: WatchConfig = {
    pnr: "GBEMBL",
    route: "SEA-ICN",
    flightDate: "2026-11-15",
    flight: "DL0197",
    passengers: 2,
    alertCashUsd: 1600,
    alertMiles: null,
    dropPctVs7dMedian: 0.15,
    upcomingTripsUrl: "https://www.delta.com/my-trips/upcoming-trips",
  };
  if (!existsSync(CONFIG_PATH)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
  } catch {
    return defaults;
  }
}

function parseAgentJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  const start = trimmed.search(/[\[{]/);
  if (start === -1) return null;
  const candidate = trimmed.slice(start);
  try {
    return JSON.parse(candidate);
  } catch {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < candidate.length; i++) {
      const c = candidate[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === "\"") inString = false;
        continue;
      }
      if (c === "\"") inString = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(0, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }
}

function readHistory(): OfferSnapshot[] {
  if (!existsSync(HISTORY_PATH)) return [];
  return readFileSync(HISTORY_PATH, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as OfferSnapshot;
      } catch {
        return null;
      }
    })
    .filter((x): x is OfferSnapshot => !!x);
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function sevenDayMedianCash(history: OfferSnapshot[], now: Date): number | null {
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const vals = history
    .filter((h) => h.available && h.cashUsdPerPax != null && new Date(h.ts).getTime() >= cutoff)
    .map((h) => h.cashUsdPerPax as number);
  return median(vals);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function ptDateAndTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: OFFER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: OFFER_TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
  return { date, time };
}

function offerToByTimeEntry(offer: OfferSnapshot): OfferByTimeEntry {
  const { time } = ptDateAndTime(offer.ts);
  const entry: OfferByTimeEntry = {
    time,
    ts: offer.ts,
    source: offer.source,
    cabin: offer.cabin,
    cashUsdPerPax: offer.cashUsdPerPax,
    milesPerPax: offer.milesPerPax,
    available: offer.available,
    raw: offer.raw,
    loginOk: offer.loginOk,
  };
  if (offer.error) entry.error = offer.error;
  return entry;
}

function readOffersByDate(cfg: WatchConfig): OffersByDateFile {
  if (existsSync(OFFERS_BY_DATE_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(OFFERS_BY_DATE_PATH, "utf8")) as OffersByDateFile;
      if (parsed && typeof parsed === "object" && parsed.byDate) {
        return {
          meta: {
            pnr: cfg.pnr,
            route: cfg.route,
            flightDate: cfg.flightDate,
            flight: cfg.flight,
            passengers: cfg.passengers,
            alertCashUsd: cfg.alertCashUsd,
            tz: OFFER_TZ,
            updatedAt: parsed.meta?.updatedAt ?? new Date().toISOString(),
          },
          byDate: parsed.byDate ?? {},
        };
      }
    } catch {
      // fall through to empty
    }
  }
  return {
    meta: {
      pnr: cfg.pnr,
      route: cfg.route,
      flightDate: cfg.flightDate,
      flight: cfg.flight,
      passengers: cfg.passengers,
      alertCashUsd: cfg.alertCashUsd,
      tz: OFFER_TZ,
      updatedAt: new Date().toISOString(),
    },
    byDate: {},
  };
}

/** Upsert one scrape into byDate[YYYY-MM-DD] keyed by PT calendar date + time. */
function writeOffersByDate(offer: OfferSnapshot, cfg: WatchConfig): void {
  const store = readOffersByDate(cfg);
  const { date } = ptDateAndTime(offer.ts);
  const entry = offerToByTimeEntry(offer);
  const day = store.byDate[date] ?? [];
  const existingIdx = day.findIndex((e) => e.ts === entry.ts);
  if (existingIdx >= 0) day[existingIdx] = entry;
  else day.push(entry);
  day.sort((a, b) => a.ts.localeCompare(b.ts));
  store.byDate[date] = day;
  store.meta = {
    pnr: cfg.pnr,
    route: cfg.route,
    flightDate: cfg.flightDate,
    flight: cfg.flight,
    passengers: cfg.passengers,
    alertCashUsd: cfg.alertCashUsd,
    tz: OFFER_TZ,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(OFFERS_BY_DATE_PATH, JSON.stringify(store, null, 2) + "\n", "utf8");
}

/**
 * Rebuild offers-by-date.json from history.jsonl (idempotent). Used on first
 * introduce and safe to re-run after manual history edits.
 */
export function rebuildOffersByDateFromHistory(cfg?: WatchConfig): OffersByDateFile {
  const config = cfg ?? loadConfig();
  const history = readHistory();
  const store: OffersByDateFile = {
    meta: {
      pnr: config.pnr,
      route: config.route,
      flightDate: config.flightDate,
      flight: config.flight,
      passengers: config.passengers,
      alertCashUsd: config.alertCashUsd,
      tz: OFFER_TZ,
      updatedAt: new Date().toISOString(),
    },
    byDate: {},
  };
  for (const offer of history) {
    const { date } = ptDateAndTime(offer.ts);
    const entry = offerToByTimeEntry(offer);
    const day = store.byDate[date] ?? [];
    if (!day.some((e) => e.ts === entry.ts)) day.push(entry);
    day.sort((a, b) => a.ts.localeCompare(b.ts));
    store.byDate[date] = day;
  }
  mkdirSync(WATCH_DIR, { recursive: true });
  writeFileSync(OFFERS_BY_DATE_PATH, JSON.stringify(store, null, 2) + "\n", "utf8");
  return store;
}

function setFailStreak(n: number): void {
  writeFileSync(FAIL_STREAK_PATH, JSON.stringify({ n, ts: new Date().toISOString() }), "utf8");
}

function getFailStreak(): number {
  if (!existsSync(FAIL_STREAK_PATH)) return 0;
  try {
    return Number(JSON.parse(readFileSync(FAIL_STREAK_PATH, "utf8")).n) || 0;
  } catch {
    return 0;
  }
}

const EXTRACT_OFFER_JS = `(() => {
  const text = document.body ? document.body.innerText : "";
  const loginOk = /Yanqing|Log Out|Sign Out|MILES AVAILABLE|SkyMiles #/i.test(text)
    && !/Log In To Delta/i.test(text);
  const pnr = ${JSON.stringify("PNR_PLACEHOLDER")};
  const onDetails = /trip-details/i.test(location.href) || text.includes(pnr);
  let cash = null;
  let miles = null;
  let raw = null;
  const normalized = text.replace(/\\u00a0/g, " ").replace(/[\\u2000-\\u200b\\u202f\\ufeff]/g, " ");
  const m = normalized.match(/\\$([\\d,]+(?:\\.\\d{2})?)\\s*USD\\s*or\\s*([\\d,]+)\\s*Miles/i);
  if (m) {
    cash = parseFloat(m[1].replace(/,/g, ""));
    miles = parseInt(m[2].replace(/,/g, ""), 10);
    raw = m[0];
  }
  const hasBanner = /Upgrade to Delta One/i.test(normalized);
  const cabinMatch = text.match(/Delta Premium Select[^\\n]{0,40}/);
  const cabin = cabinMatch ? cabinMatch[0].trim() : null;
  return {
    url: location.href,
    loginOk,
    onDetails,
    hasBanner,
    cash,
    miles,
    raw,
    cabin,
    hasPnr: text.includes(pnr) || normalized.includes(pnr),
  };
})()`;

/**
 * Re-establish Delta session using Chrome saved credentials.
 * 1) Try profile autofill (click password field).
 * 2) If passLen stays 0, decrypt the www.delta.com row from primary Chrome
 *    Login Data via Keychain "Chrome Safe Storage" and fill via agent-browser.
 * Never persists the password to disk/logs.
 */
async function ensureDeltaLogin(returnUrl: string): Promise<boolean> {
  const loginUrl =
    `https://www.delta.com/login/loginPage?returnUrl=${encodeURIComponent(returnUrl)}`;
  logger.info("delta-upgrade-watch attempting saved-credential re-login");
  await execAb(["open", loginUrl], 60_000);

  let filled = false;
  let loginRef: string | undefined;
  let usedDecryptFill = false;

  // Wait for username prefill, then focus password to trigger Chrome autofill.
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(attempt === 0 ? 2500 : 1500);
    const snap = await execAb(["snapshot"], 30_000);
    if (!/Log In To Delta|SkyMiles Number or Username|password/i.test(snap) &&
        /Yanqing|Log Out|Sign Out|MILES AVAILABLE/i.test(snap)) {
      // Already redirected / logged in
      logger.info("delta-upgrade-watch already logged in after open");
      return true;
    }
    const passRef = snap.match(/textbox "Password" \[ref=(e\d+)\]/i)?.[1];
    loginRef = snap.match(/button "Log In" \[ref=(e\d+)\]/i)?.[1];
    if (passRef) {
      await execAb(["click", `@${passRef}`], 15_000);
      await sleep(800);
    }
    const probeRaw = await execAb(
      [
        "eval",
        `(() => {
          const user = document.querySelector('#userId-input, input:not([type=password]):not([type=hidden]):not([type=checkbox])');
          const pass = document.querySelector('#password-input, input[type=password]');
          return {
            userLen: (user && user.value || '').length,
            passLen: (pass && pass.value || '').length,
            url: location.href,
          };
        })()`,
      ],
      15_000,
    );
    const probe = parseAgentJson(probeRaw) as { userLen?: number; passLen?: number } | null;
    if ((probe?.userLen ?? 0) >= 4 && (probe?.passLen ?? 0) >= 4 && loginRef) {
      await execAb(["click", `@${loginRef}`], 30_000);
      filled = true;
      break;
    }

    // After a couple autofill misses, decrypt+fill from Chrome Login Data once.
    if (!usedDecryptFill && attempt >= 1 && (probe?.passLen ?? 0) < 4) {
      const saved = getChromeSavedLogin("www.delta.com");
      if (!saved) {
        logger.warn("delta-upgrade-watch saved-credential decrypt unavailable");
      } else {
        usedDecryptFill = true;
        logger.info(
          { userLen: saved.username.length, origin: saved.originUrl },
          "delta-upgrade-watch filling password from Chrome Login Data",
        );
        // Ensure username is present (remember-me usually is; fill if not).
        if ((probe?.userLen ?? 0) < 4) {
          await execAb(["fill", "#userId-input", saved.username], 15_000);
        }
        await execAb(["fill", "#password-input", saved.password], 15_000);
        // Drop plaintext from this closure ASAP (best-effort; GC).
        (saved as { password: string }).password = "";
        const verifyRaw = await execAb(
          [
            "eval",
            `(() => {
              const user = document.querySelector('#userId-input, input:not([type=password]):not([type=hidden]):not([type=checkbox])');
              const pass = document.querySelector('#password-input, input[type=password]');
              return {
                userLen: (user && user.value || '').length,
                passLen: (pass && pass.value || '').length,
              };
            })()`,
          ],
          15_000,
        );
        const verify = parseAgentJson(verifyRaw) as { userLen?: number; passLen?: number } | null;
        if ((verify?.userLen ?? 0) >= 4 && (verify?.passLen ?? 0) >= 4) {
          if (!loginRef) {
            const snap2 = await execAb(["snapshot"], 30_000);
            loginRef = snap2.match(/button "Log In" \[ref=(e\d+)\]/i)?.[1];
          }
          if (loginRef) {
            await execAb(["click", `@${loginRef}`], 30_000);
            filled = true;
            break;
          }
        } else {
          logger.warn(
            { userLen: verify?.userLen ?? 0, passLen: verify?.passLen ?? 0 },
            "delta-upgrade-watch decrypt-fill did not stick in DOM",
          );
        }
      }
    }
  }

  if (!filled) {
    logger.warn("delta-upgrade-watch saved-credential re-login: credentials not filled");
    return false;
  }

  // Poll for logged-in My Trips (or homepage redirect then navigate).
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(attempt === 0 ? 4000 : 2000);
    const hrefRaw = await execAb(
      ["eval", `(() => ({ href: location.href, text: (document.body&&document.body.innerText||'').slice(0,300) }))()`],
      15_000,
    );
    const page = parseAgentJson(hrefRaw) as { href?: string; text?: string } | null;
    const text = page?.text ?? "";
    const loggedIn =
      /Yanqing|Log Out|Sign Out|MILES AVAILABLE|SkyMiles #/i.test(text) &&
      !/Log In To Delta/i.test(text);
    if (loggedIn) {
      if (!/upcoming-trips/i.test(page?.href ?? "")) {
        await execAb(["open", returnUrl], 60_000);
        await sleep(3000);
      }
      logger.info(
        { via: usedDecryptFill ? "login-data-decrypt" : "autofill" },
        "delta-upgrade-watch saved-credential re-login ok",
      );
      return true;
    }
  }
  logger.warn("delta-upgrade-watch saved-credential re-login did not reach logged-in state");
  return false;
}

async function scrapeOffer(cfg: WatchConfig): Promise<OfferSnapshot> {
  const ts = new Date().toISOString();
  const base: OfferSnapshot = {
    ts,
    source: "delta-upgrade-watch",
    pnr: cfg.pnr,
    route: cfg.route,
    flightDate: cfg.flightDate,
    flight: cfg.flight,
    cabin: null,
    cashUsdPerPax: null,
    milesPerPax: null,
    available: false,
    raw: null,
    loginOk: false,
  };

  // The executor owns ensure + stale-socket clear + connect (with its own bounded
  // reconnect); this job no longer duplicates that sequence or probes targets.
  await connectScrapeBackend(jobSignal);
  // Warm a tab; retry once on stale session id.
  try {
    await execAb(["open", cfg.upcomingTripsUrl], 60_000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/Session with given id not found|CDP error/i.test(msg)) throw err;
    logger.warn({ err: msg.slice(0, 200) }, "delta-upgrade-watch CDP stale — reconnect");
    resetScrapeBackend();
    await connectScrapeBackend(jobSignal);
    await execAb(["open", cfg.upcomingTripsUrl], 60_000);
  }
  const listEval = EXTRACT_OFFER_JS.replace("PNR_PLACEHOLDER", cfg.pnr);
  type ListProbe = { loginOk?: boolean; hasPnr?: boolean };
  let list: ListProbe | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(attempt === 0 ? 4000 : 2000);
    const listRaw = await execAb(["eval", listEval], 30_000);
    list = parseAgentJson(listRaw) as ListProbe | null;
    if (list?.loginOk && list.hasPnr) break;
    if (list && !list.loginOk) break;
  }

  if (!list?.loginOk) {
    const relogged = await ensureDeltaLogin(cfg.upcomingTripsUrl);
    if (relogged) {
      list = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await sleep(attempt === 0 ? 3000 : 2000);
        const listRaw = await execAb(["eval", listEval], 30_000);
        list = parseAgentJson(listRaw) as ListProbe | null;
        if (list?.loginOk && list.hasPnr) break;
        if (list && !list.loginOk) break;
      }
    }
  }

  if (!list?.loginOk) {
    return { ...base, error: "not_logged_in", loginOk: false };
  }
  base.loginOk = true;

  if (!list.hasPnr) {
    return { ...base, error: "pnr_not_on_upcoming_trips", loginOk: true };
  }

  // Trip cards hydrate after login; poll for TRIP DETAILS after the PNR marker.
  let detailsRef: string | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) await sleep(2000);
    const snap = await execAb(["snapshot"], 30_000);
    for (const marker of [`#${cfg.pnr}`, cfg.pnr]) {
      const pnrIdx = snap.indexOf(marker);
      if (pnrIdx === -1) continue;
      const after = snap.slice(pnrIdx, pnrIdx + 4000);
      const refMatch = after.match(/button "TRIP DETAILS" \[ref=(e\d+)\]/i);
      if (refMatch) {
        detailsRef = refMatch[1]!;
        break;
      }
    }
    if (detailsRef) break;
  }
  if (!detailsRef) {
    return { ...base, error: "trip_details_button_missing", loginOk: true };
  }
  await execAb(["click", `@${detailsRef}`], 30_000);

  const detailEval = EXTRACT_OFFER_JS.replace("PNR_PLACEHOLDER", cfg.pnr);
  type DetailProbe = {
    loginOk?: boolean;
    hasBanner?: boolean;
    cash?: number | null;
    miles?: number | null;
    raw?: string | null;
    cabin?: string | null;
    hasPnr?: boolean;
  };
  let detail: DetailProbe | null = null;

  // Banner is JS-hydrated; poll up to ~20s.
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(attempt === 0 ? 4000 : 2500);
    const detailRaw = await execAb(["eval", detailEval], 30_000);
    detail = parseAgentJson(detailRaw) as DetailProbe | null;
    if (detail?.cash != null && detail.hasBanner) break;
    if (detail?.hasPnr && /trip-details/i.test(String((detail as { url?: string }).url ?? ""))) {
      // keep polling for banner
    }
  }

  if (!detail) {
    return { ...base, error: "detail_parse_failed", loginOk: true };
  }

  if (detail.cash != null && detail.hasBanner) {
    return {
      ...base,
      cabin: detail.cabin ?? null,
      cashUsdPerPax: detail.cash,
      milesPerPax: detail.miles ?? null,
      available: true,
      raw: detail.raw ?? null,
      loginOk: true,
    };
  }

  return {
    ...base,
    cabin: detail.cabin ?? null,
    available: false,
    loginOk: true,
    error: detail.hasPnr ? "upgrade_banner_missing" : "wrong_trip_details",
  };
}

function shouldAlert(
  offer: OfferSnapshot,
  cfg: WatchConfig,
  history: OfferSnapshot[],
): { alert: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!offer.available || offer.cashUsdPerPax == null) {
    return { alert: false, reasons };
  }
  if (cfg.alertCashUsd != null && offer.cashUsdPerPax <= cfg.alertCashUsd) {
    reasons.push(`cash $${offer.cashUsdPerPax} ≤ threshold $${cfg.alertCashUsd}`);
  }
  if (cfg.alertMiles != null && offer.milesPerPax != null && offer.milesPerPax <= cfg.alertMiles) {
    reasons.push(`miles ${offer.milesPerPax} ≤ threshold ${cfg.alertMiles}`);
  }
  const med = sevenDayMedianCash(history, new Date(offer.ts));
  if (
    med != null &&
    cfg.dropPctVs7dMedian > 0 &&
    offer.cashUsdPerPax <= med * (1 - cfg.dropPctVs7dMedian)
  ) {
    const pct = Math.round((1 - offer.cashUsdPerPax / med) * 100);
    reasons.push(`cash ${pct}% below 7d median $${Math.round(med)}`);
  }
  return { alert: reasons.length > 0, reasons };
}

export async function runDeltaUpgradeWatch(signal?: AbortSignal): Promise<DeltaUpgradeWatchResult> {
  jobSignal = signal;
  try {
    return await runDeltaUpgradeWatchInner();
  } finally {
    jobSignal = undefined;
  }
}

async function runDeltaUpgradeWatchInner(): Promise<DeltaUpgradeWatchResult> {
  mkdirSync(WATCH_DIR, { recursive: true });
  const cfg = loadConfig();
  const history = readHistory();

  let offer: OfferSnapshot;
  try {
    offer = await withScrapeLock(() => scrapeOffer(cfg));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "delta-upgrade-watch scrape threw");
    offer = {
      ts: new Date().toISOString(),
      source: "delta-upgrade-watch",
      pnr: cfg.pnr,
      route: cfg.route,
      flightDate: cfg.flightDate,
      flight: cfg.flight,
      cabin: null,
      cashUsdPerPax: null,
      milesPerPax: null,
      available: false,
      raw: null,
      loginOk: false,
      error: msg.slice(0, 300),
    };
  }

  appendFileSync(HISTORY_PATH, JSON.stringify(offer) + "\n", "utf8");
  writeFileSync(LATEST_PATH, JSON.stringify(offer, null, 2), "utf8");
  writeOffersByDate(offer, cfg);

  if (!offer.available || offer.cashUsdPerPax == null) {
    const streak = getFailStreak() + 1;
    setFailStreak(streak);
    const err = offer.error || "offer_unavailable";
    const output =
      `Delta D1 watch failed for ${cfg.pnr}: ${err}` +
      (streak >= 2 ? ` (${streak} consecutive failures)` : "");
    return {
      success: false,
      output,
      error: output,
      notificationIntent: streak >= 2 ? "failure_alert" : "operational_status",
    };
  }

  setFailStreak(0);
  const { alert, reasons } = shouldAlert(offer, cfg, history);
  const summary =
    `${cfg.pnr} ${cfg.route}: $${offer.cashUsdPerPax} / ` +
    `${(offer.milesPerPax ?? 0).toLocaleString("en-US")} miles per pax` +
    (alert ? ` — ALERT: ${reasons.join("; ")}` : " — logged");

  logger.info({ cash: offer.cashUsdPerPax, miles: offer.milesPerPax, alert }, "delta-upgrade-watch ok");

  if (alert) {
    return {
      success: true,
      output:
        `✈️ <b>Delta D1 升舱可买？</b>\n` +
        `${escapeHtml(cfg.pnr)} ${escapeHtml(cfg.route)} ${escapeHtml(cfg.flightDate)}\n` +
        `$${offer.cashUsdPerPax} USD 或 ${(offer.milesPerPax ?? 0).toLocaleString("en-US")} miles / 人\n` +
        `原因：${escapeHtml(reasons.join("；"))}\n` +
        `（未自动购买 — 打开 Delta My Trips 确认）`,
      notificationIntent: "decision_request",
    };
  }

  return {
    success: true,
    output: summary,
    notificationIntent: "operational_status",
  };
}
