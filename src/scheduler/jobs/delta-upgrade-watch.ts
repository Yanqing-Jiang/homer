/**
 * Daily Delta Premium Select → Delta One upgrade offer watch.
 *
 * Scrapes logged-in My Trips (CDP Chrome :9222) for PNR GBEMBL (SEA→ICN),
 * appends history, writes latest.json + brief-snippet.html for morning-brief,
 * and surfaces a Telegram decision_request when cash ≤ alert threshold or
 * drops ≥ dropPctVs7dMedian vs 7-day median.
 *
 * If the Delta session expired, re-logins via Chrome autofill (username +
 * password already saved in the CDP profile) — never stores credentials in code.
 * Never clicks UPGRADE / purchases.
 */

import { execFile } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { PATHS } from "../../config/paths.js";
import { withScrapeLock } from "../../executors/agent-browser-scrape.js";
import { ensureCDP } from "../../scraping/chrome-launcher.js";
import { logger } from "../../utils/logger.js";
import type { NotificationIntent } from "../../notifications/types.js";

const AGENT_BROWSER_SOCKET = join(homedir(), ".agent-browser", "default.sock");

const AGENT_BROWSER = "agent-browser";
const CDP_PORT = 9222;
const WATCH_DIR = join(PATHS.homerData, "watches", "delta-upgrade");
const CONFIG_PATH = join(WATCH_DIR, "config.json");
const HISTORY_PATH = join(WATCH_DIR, "history.jsonl");
const LATEST_PATH = join(WATCH_DIR, "latest.json");
const BRIEF_SNIPPET_PATH = join(WATCH_DIR, "brief-snippet.html");
const FAIL_STREAK_PATH = join(WATCH_DIR, "fail-streak.json");

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function execAb(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      AGENT_BROWSER,
      args,
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
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

function writeBriefSnippet(offer: OfferSnapshot, cfg: WatchConfig, prev: OfferSnapshot | null): void {
  // On scrape failure, keep the last good snippet so morning-brief still has a price
  // (skill only includes the section when mtime < 24h).
  if (!offer.available || offer.cashUsdPerPax == null) {
    if (existsSync(BRIEF_SNIPPET_PATH) && prev?.available && prev.cashUsdPerPax != null) {
      logger.warn(
        { err: offer.error ?? "offer_unavailable" },
        "delta-upgrade-watch scrape failed — preserving prior brief-snippet",
      );
      return;
    }
    writeFileSync(
      BRIEF_SNIPPET_PATH,
      `<b>✈️ Delta D1 升舱</b>\n━━━━━━━━━━━━\n${escapeHtml(cfg.pnr)} ${escapeHtml(cfg.route)}：今日无升舱报价或抓取失败\n`,
      "utf8",
    );
    return;
  }
  const deltaCash =
    prev?.cashUsdPerPax != null ? offer.cashUsdPerPax - prev.cashUsdPerPax : null;
  const deltaMiles =
    prev?.milesPerPax != null && offer.milesPerPax != null
      ? offer.milesPerPax - prev.milesPerPax
      : null;
  const cashNote =
    deltaCash == null ? "" : deltaCash === 0 ? "（较昨日持平）" : `（较昨日 ${deltaCash > 0 ? "+" : ""}$${deltaCash}）`;
  const milesNote =
    deltaMiles == null || deltaMiles === 0
      ? ""
      : ` / miles ${deltaMiles > 0 ? "+" : ""}${deltaMiles.toLocaleString("en-US")}`;
  const body =
    `${escapeHtml(cfg.pnr)} ${escapeHtml(cfg.route)} ${escapeHtml(cfg.flightDate)} ${escapeHtml(cfg.flight)}\n` +
    `Premium Select → Delta One：<b>$${offer.cashUsdPerPax.toLocaleString("en-US")}</b> 或 ` +
    `${(offer.milesPerPax ?? 0).toLocaleString("en-US")} miles / 人` +
    `${cashNote}${milesNote}\n` +
    `（${cfg.passengers} 人；阈值 $${cfg.alertCashUsd ?? "—"}）\n`;
  writeFileSync(
    BRIEF_SNIPPET_PATH,
    `<b>✈️ Delta D1 升舱</b>\n━━━━━━━━━━━━\n${body}`,
    "utf8",
  );
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
 * Re-establish Delta session using Chrome saved credentials (username + password
 * autofill in the CDP profile). Never reads/stores the password in code — focuses
 * the password field to trigger autofill, then clicks Log In.
 */
async function ensureDeltaLogin(returnUrl: string): Promise<boolean> {
  const loginUrl =
    `https://www.delta.com/login/loginPage?returnUrl=${encodeURIComponent(returnUrl)}`;
  logger.info("delta-upgrade-watch attempting autofill re-login");
  await execAb(["open", loginUrl], 60_000);

  // Wait for username prefill, then focus password to trigger Chrome autofill.
  let filled = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(attempt === 0 ? 2500 : 1500);
    const snap = await execAb(["snapshot"], 30_000);
    if (!/Log In To Delta|SkyMiles Number or Username/i.test(snap)) {
      // Already redirected / logged in
      break;
    }
    const passRef = snap.match(/textbox "Password" \[ref=(e\d+)\]/i)?.[1];
    const loginRef = snap.match(/button "Log In" \[ref=(e\d+)\]/i)?.[1];
    if (passRef) {
      await execAb(["click", `@${passRef}`], 15_000);
      await sleep(800);
    }
    const probeRaw = await execAb(
      [
        "eval",
        `(() => {
          const user = document.querySelector('input:not([type=password]):not([type=hidden]):not([type=checkbox])');
          const pass = document.querySelector('input[type=password]');
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
  }

  if (!filled) {
    logger.warn("delta-upgrade-watch autofill re-login: credentials not prefilled");
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
      logger.info("delta-upgrade-watch autofill re-login ok");
      return true;
    }
  }
  logger.warn("delta-upgrade-watch autofill re-login did not reach logged-in state");
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

  await ensureCDP({ headed: true });
  // Drop stale agent-browser socket so connect re-handshakes against live CDP.
  try {
    rmSync(AGENT_BROWSER_SOCKET, { force: true });
  } catch {
    /* best effort */
  }
  await execAb(["connect", String(CDP_PORT)], 15_000);
  // Warm a tab; retry once on stale session id.
  try {
    await execAb(["open", cfg.upcomingTripsUrl], 60_000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/Session with given id not found|CDP error/i.test(msg)) throw err;
    logger.warn({ err: msg.slice(0, 200) }, "delta-upgrade-watch CDP stale — reconnect");
    try {
      rmSync(AGENT_BROWSER_SOCKET, { force: true });
    } catch {
      /* best effort */
    }
    await execAb(["connect", String(CDP_PORT)], 15_000);
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

export async function runDeltaUpgradeWatch(): Promise<DeltaUpgradeWatchResult> {
  mkdirSync(WATCH_DIR, { recursive: true });
  const cfg = loadConfig();
  const history = readHistory();
  const prev = [...history].reverse().find((h) => h.available && h.cashUsdPerPax != null) ?? null;

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
  writeBriefSnippet(offer, cfg, prev);

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
