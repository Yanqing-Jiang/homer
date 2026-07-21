/**
 * ABVP fortnightly refresh — deterministic internal handler.
 *
 * Contract: ~/memory/ABVP raw/skills.md
 * Stages: cadence → lock → inventory (28d) → sequential DL → place → ingest → verify → notify
 *
 * Post Codex sol-xhigh NO-GO (2026-07-20): stable portal keys (no EXCEL), nonempty
 * window proof, immutable resume run identity, auth remapping, causal download
 * attribution, awaited process-group reap, browser mutex, full disk floor, WAL proof.
 */

import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import { openSync, closeSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { promisify } from "node:util";
import { flockSync, fcntlSync, constants as fsExtConstants } from "fs-ext";
import type { Bot } from "grammy";
// @ts-ignore better-sqlite3 default export typing
import type Database from "better-sqlite3";
import { ensureCDP } from "../../scraping/chrome-launcher.js";
import { withScrapeLock } from "../../executors/agent-browser-scrape.js";
import {
  formatScheduledTelegramHtml,
  routeTelegramNotification,
  sendChunkedTelegramMessage,
} from "../../notifications/telegram-router.js";
import type { NotificationIntent } from "../../notifications/types.js";
import type { RegisteredJob } from "../types.js";
import { logger } from "../../utils/logger.js";

const execFileAsync = promisify(execFile);

const ABVP_ROOT = join(homedir(), "memory", "ABVP raw");
const RUNS_DIR = join(ABVP_ROOT, ".abvp-runs");
const CADENCE_PATH = join(RUNS_DIR, "cadence.json");
const ACTIVE_PATH = join(RUNS_DIR, "active.json");
const LOCK_PATH = join(ABVP_ROOT, ".abvp.lock");
const DOWNLOADS_DIR = join(ABVP_ROOT, "downloads");
const DOWNLOADS_SR_DIR = join(ABVP_ROOT, "downloads_sr");
const QUARANTINE_DIR = join(ABVP_ROOT, "quarantine");
const INGEST_LOGS_DIR = join(ABVP_ROOT, "ingest_logs");
const LANDING_ROOTS = [
  join(homedir(), "Downloads", "amazon-advertising-reports"),
  join(homedir(), "Downloads"),
];

const PORTAL_URL = "https://advertising.amazon.com/bv#/ABVP/PNG_US/reports";
const AGENT_BROWSER = "agent-browser";
const SESSION = "abvp";
const CDP_PORT = "9222";
const LOOKBACK_DAYS = 28;
const AUTH_WAIT_MS = 45 * 60 * 1000;
const AUTH_POLL_MS = 20_000;
const TELEGRAM_RETRY = 3;
const INGEST_START_CUTOFF_MS = 90 * 60 * 1000;
const TZ = "America/Los_Angeles";
const TERMINAL_STATUSES = new Set(["completed", "failed", "auth_timeout", "auth_unnotified"]);

type ReportType = "Brand" | "ASIN" | "SR";
type AuthKind =
  | "auth_required"
  | "mfa_required"
  | "registration_required"
  | "bot_challenge"
  | "bot_blocked"
  | "portal_contract_failure";

interface CadenceState {
  next_due_at: string;
  last_success_at?: string | null;
  last_run_id?: string | null;
}

interface PortalRow {
  key: string;
  type: ReportType;
  label: string;
  date: string;
  status: string;
  advertiser: string;
  fingerprint: string;
}

interface RunItem {
  id: string;
  type: ReportType;
  portal_date: string;
  portal_label: string;
  portal_key: string;
  portal_fingerprint: string;
  canonical_path: string;
  ledger_file_path: string;
  required_sources: string[];
  stage: string;
  staging_path: string | null;
  landing_path: string | null;
  size_bytes: number;
  sha256: string | null;
  zip_valid: boolean;
  place_action: string;
  ingest: Record<string, { status: string; row_count: number | null }>;
  attempts: { download: number; ingest: number };
  error: string | null;
}

interface RunState {
  schema_version: 2;
  run_id: string;
  attempt: number;
  status: string;
  stage: string;
  created_at: string;
  updated_at: string;
  today_local: string;
  lookback_start: string;
  lookback_end: string;
  next_due_at_before: string;
  inventory: {
    portal_url: string;
    marketplace: string;
    contract_verified: boolean;
    coverage_complete: boolean;
    row_count: number;
    sealed_at: string | null;
    window: Record<ReportType, { in_window: number; outside_window: number; status: string }>;
  };
  items: RunItem[];
  child: { pid: number | null; pgid: number | null; type: string | null; started_at: string | null };
  auth: { kind: AuthKind | null; detected_at: string | null; deadline: string | null; current_url: string | null };
  notification: {
    intent: string | null;
    status: "none" | "pending" | "sent" | "failed";
    telegram_message_id: number | null;
  };
  wal_checkpoint: { busy: number; log: number; checkpointed: number; at: string } | null;
  cadence_advanced_at: string | null;
  last_error: string | null;
}

export interface AbvpRefreshContext {
  db: Database.Database;
  bot: Bot | null;
  chatId: number;
  jobRunId?: number;
  signal?: AbortSignal;
  job: RegisteredJob;
  startedAt: Date;
}

export interface AbvpRefreshResult {
  success: boolean;
  output: string;
  error?: string;
  notificationIntent?: NotificationIntent;
  sideEffectDelivered?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function localToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDaysLocal(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function parseLocalDate(isoDate: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

function normalizePortalDate(raw: string): string | null {
  const m = raw.trim().match(/(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1]!;
  const m2 = raw.trim().match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m2) {
    const mm = m2[1]!.padStart(2, "0");
    const dd = m2[2]!.padStart(2, "0");
    return `${m2[3]}-${mm}-${dd}`;
  }
  return null;
}

function labelToType(label: string): ReportType | null {
  const t = label.trim();
  if (/^Zip\s*\(\s*Brand Metrics\s*\)$/i.test(t)) return "Brand";
  if (/^Zip\s*\(\s*ASIN Metrics\s*\)$/i.test(t)) return "ASIN";
  if (/^Search Report$/i.test(t)) return "SR";
  return null;
}

function isExcelLabel(label: string): boolean {
  return /excel|\.xlsx?|\.xls\b/i.test(label.trim());
}

function canonicalFor(type: ReportType, portalDate: string): { abs: string; ledger: string; sources: string[] } {
  if (type === "Brand") {
    const name = `Brand_${portalDate}.zip`;
    return { abs: join(DOWNLOADS_DIR, name), ledger: `downloads/${name}`, sources: ["brand_metrics"] };
  }
  if (type === "ASIN") {
    const name = `ASIN_${portalDate}.zip`;
    return { abs: join(DOWNLOADS_DIR, name), ledger: `downloads/${name}`, sources: ["asin_grain"] };
  }
  const name = `SR_${portalDate}.zip`;
  return {
    abs: join(DOWNLOADS_SR_DIR, name),
    ledger: `downloads_sr/${name}`,
    sources: ["sr_asin_rank", "sr_keyword_share"],
  };
}

function contractId(type: ReportType, portalDate: string): string {
  return `${type}:${portalDate}`;
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  const body = JSON.stringify(data, null, 2) + "\n";
  await fs.writeFile(tmp, body, "utf8");
  const fh = await fs.open(tmp, "r+");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, path);
  try {
    const dh = await fs.open(dir, "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    /* best-effort dir fsync */
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function ensureDirs(): Promise<void> {
  for (const d of [RUNS_DIR, DOWNLOADS_DIR, DOWNLOADS_SR_DIR, QUARANTINE_DIR, INGEST_LOGS_DIR, ...LANDING_ROOTS]) {
    await fs.mkdir(d, { recursive: true });
  }
}

async function loadCadence(): Promise<CadenceState> {
  const existing = await readJson<CadenceState>(CADENCE_PATH);
  if (existing?.next_due_at) return existing;
  const seeded: CadenceState = {
    next_due_at: "2026-08-04T07:00:00-07:00",
    last_success_at: null,
    last_run_id: null,
  };
  await atomicWriteJson(CADENCE_PATH, seeded);
  return seeded;
}

function isDue(nextDueAt: string, now = new Date()): boolean {
  const due = Date.parse(nextDueAt);
  return Number.isFinite(due) && now.getTime() >= due;
}

function advanceDue(fromIso: string): string {
  const base = Date.parse(fromIso);
  const start = Number.isFinite(base) ? new Date(base) : new Date();
  const next = new Date(start.getTime() + 14 * 24 * 60 * 60 * 1000);
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(next);
  const probe = new Date(`${local}T14:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    timeZoneName: "shortOffset",
  }).formatToParts(probe);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-7";
  const m = tzName.match(/GMT([+-]\d+)(?::(\d+))?/);
  const hourOff = m ? Number(m[1]) : -7;
  const minOff = m && m[2] ? Number(m[2]) : 0;
  const sign = hourOff <= 0 ? "-" : "+";
  const absH = String(Math.abs(hourOff)).padStart(2, "0");
  const absM = String(minOff).padStart(2, "0");
  return `${local}T07:00:00${sign}${absH}:${absM}`;
}

class PipelineLock {
  private fd: number | null = null;

  acquire(): boolean {
    mkdirSync(ABVP_ROOT, { recursive: true });
    this.fd = openSync(LOCK_PATH, "a");
    try {
      fcntlSync(this.fd, "setfd", fsExtConstants.FD_CLOEXEC);
    } catch {
      /* ignore */
    }
    try {
      flockSync(this.fd, "exnb");
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EWOULDBLOCK" || code === "EAGAIN") {
        closeSync(this.fd);
        this.fd = null;
        return false;
      }
      closeSync(this.fd);
      this.fd = null;
      throw err;
    }
  }

  release(): void {
    if (this.fd == null) return;
    try {
      flockSync(this.fd, "un");
    } catch {
      /* ignore */
    }
    try {
      closeSync(this.fd);
    } catch {
      /* ignore */
    }
    this.fd = null;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const fh = await fs.open(path, "r");
  try {
    const stream = fh.createReadStream();
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
  } finally {
    await fh.close();
  }
  return hash.digest("hex");
}

async function validateZip(path: string, type: ReportType): Promise<{ ok: boolean; members: string[]; error?: string }> {
  try {
    const { stdout } = await execFileAsync(
      "python3",
      [
        "-c",
        `
import json, zipfile, sys, re
p = sys.argv[1]; t = sys.argv[2]
with zipfile.ZipFile(p) as zf:
    bad = zf.testzip()
    names = zf.namelist()
    if bad:
        print(json.dumps({"ok": False, "members": names, "error": f"bad member {bad}"})); raise SystemExit(0)
    norms = [n.replace('\\\\','/').split('/')[-1].lower() for n in names]
    ok = False
    if t == "Brand":
        ok = any(n == "metrics.csv" or n.endswith("_metrics.csv") or n.endswith("/metrics.csv") or n == "metrics.csv"
                 for n in (x.lower().replace('\\\\','/') for x in names))
        ok = any(re.search(r'(^|/)metrics\\.csv$', n.replace('\\\\','/'), re.I) for n in names)
    elif t == "ASIN":
        # Require an ASIN-grain-ish csv, not a random helper csv
        ok = any(re.search(r'(asin|grain).*\.csv$', n.replace('\\\\','/').split('/')[-1], re.I) or
                 re.search(r'asin grain report.*\\.csv$', n.replace('\\\\','/').split('/')[-1], re.I)
                 for n in names)
        if not ok:
            csvs = [n for n in names if n.lower().endswith('.csv') and not n.lower().endswith('/')]
            ok = len(csvs) >= 1 and any('asin' in n.lower() or 'grain' in n.lower() or 'metric' in n.lower() for n in csvs)
    else:
        a = any(re.search(r'dataset_a', n, re.I) and n.lower().endswith('.csv.gz') for n in names)
        b = any(re.search(r'dataset_b', n, re.I) and n.lower().endswith('.csv.gz') for n in names)
        ok = a and b
    print(json.dumps({"ok": ok, "members": names, "error": None if ok else "missing expected members"}))
`,
        path,
        type,
      ],
      { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return JSON.parse(stdout.trim()) as { ok: boolean; members: string[]; error?: string };
  } catch (err) {
    return { ok: false, members: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function diskFreeBytes(path: string): Promise<number> {
  const { stdout } = await execFileAsync("df", ["-k", path]);
  const lines = stdout.trim().split("\n");
  const cols = lines[lines.length - 1]!.split(/\s+/);
  return Number(cols[3]) * 1024;
}

async function abvpBrowser(
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string> } = {},
): Promise<string> {
  const full = ["--session", SESSION, ...args];
  const { stdout, stderr } = await execFileAsync(AGENT_BROWSER, full, {
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 32 * 1024 * 1024,
    signal: opts.signal,
    env: { ...process.env, AGENT_BROWSER_HEADED: "1", ...opts.env },
  });
  if (stderr?.trim()) {
    logger.debug({ stderr: stderr.slice(0, 500) }, "agent-browser stderr");
  }
  return (stdout || "").trim();
}

function parseEvalJson<T>(stdout: string): T {
  let out = stdout.trim();
  if (out.startsWith('"') && out.endsWith('"')) {
    try {
      out = JSON.parse(out) as string;
    } catch {
      /* keep */
    }
  }
  const start = out.search(/[\[{]/);
  if (start === -1) throw new Error(`no JSON in agent-browser output: ${out.slice(0, 200)}`);
  return JSON.parse(out.slice(start)) as T;
}

async function ensureBrowserReady(signal?: AbortSignal): Promise<void> {
  await ensureCDP({ headed: true });
  try {
    await abvpBrowser(["connect", CDP_PORT], { timeoutMs: 30_000, signal });
  } catch (err) {
    logger.warn({ err }, "abvp connect failed; retrying once");
    await abvpBrowser(["connect", CDP_PORT], { timeoutMs: 30_000, signal });
  }
}

function classifyAuth(url: string, bodyText: string): AuthKind | null {
  const u = url.toLowerCase();
  const body = bodyText.toLowerCase();
  if (/\/register|\/registration|\/onboarding/.test(u) || /create your amazon account|advertiser.?setup/.test(body)) {
    return "registration_required";
  }
  if (/\/ap\/signin|\/signin|\/login|\/challenge/.test(u) || /sign in|password|authenticate/.test(body)) {
    if (/one time password|otp|two-step|mfa|enter.?code|approval/.test(body) || /\/challenge/.test(u)) {
      return "mfa_required";
    }
    return "auth_required";
  }
  if (/captcha|verify you are human|robot check/.test(body)) return "bot_challenge";
  if (/access denied|403|rate.?limit/.test(body) && !/png_us|brand view|reports/.test(body)) return "bot_blocked";
  return null;
}

/** Shared DOM enumeration: buttons+anchors, EXCEL excluded, stable key per row. */
const ENUMERATE_JS = `(() => {
  const url = location.href;
  const body = ((document.body && document.body.innerText) || "").slice(0, 5000);
  const title = document.title || "";
  const marketplaceHint = /PNG_US|P&G US|Procter/i.test(body + " " + title + " " + url);
  const authish = /\\/ap\\/signin|\\/signin|\\/login|\\/challenge|\\/register/.test(url)
    || /sign in|password|one time password|captcha|verify you are human/i.test(body);
  const labelOf = (el) => ((el.innerText || el.textContent || "") + "").trim().replace(/\\s+/g, " ");
  const typeOf = (label) => {
    if (/^Zip\\s*\\(\\s*Brand Metrics\\s*\\)$/i.test(label)) return "Brand";
    if (/^Zip\\s*\\(\\s*ASIN Metrics\\s*\\)$/i.test(label)) return "ASIN";
    if (/^Search Report$/i.test(label)) return "SR";
    return null;
  };
  const isExcel = (label) => /excel|\\.xlsx?|\\.xls\\b/i.test(label);
  const controls = Array.from(document.querySelectorAll("button, a")).filter((el) => {
    const t = labelOf(el);
    if (!t || isExcel(t)) return false;
    return !!typeOf(t);
  });
  const rows = controls.map((el) => {
    const label = labelOf(el);
    const type = typeOf(label);
    const row = el.closest("tr") || el.closest("[role=row]");
    let date = "", status = "", advertiser = "";
    if (row) {
      const cells = Array.from(row.querySelectorAll("td, [role=cell]")).map((c) => ((c.innerText || "") + "").trim());
      advertiser = cells[0] || "";
      status = cells[2] || "";
      date = cells[3] || "";
      if (!date) {
        for (const c of cells) {
          if (/\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\/\\d{1,2}\\/\\d{4}/.test(c)) { date = c; break; }
        }
      }
    }
    const fingerprint = [type, date, label, advertiser, status].join("|");
    const key = type + "::" + date + "::" + label + "::" + advertiser;
    return { key, type, label, date, status, advertiser, fingerprint };
  });
  const scrollers = Array.from(document.querySelectorAll("[role=rowgroup], table, [class*=scroll], [class*=virtual]"));
  let maxScroll = document.documentElement.scrollHeight || 0;
  for (const s of scrollers) maxScroll = Math.max(maxScroll, s.scrollHeight || 0);
  return JSON.stringify({
    url, title, authish, marketplaceHint, bodySample: body.slice(0, 800),
    hasTable: !!(document.querySelector("table") || document.querySelector("[role=table]")),
    count: rows.length, rows, maxScroll
  });
})()`;

const CLICK_BY_KEY_JS = (key: string) => `(() => {
  const want = ${JSON.stringify(key)};
  const labelOf = (el) => ((el.innerText || el.textContent || "") + "").trim().replace(/\\s+/g, " ");
  const typeOf = (label) => {
    if (/^Zip\\s*\\(\\s*Brand Metrics\\s*\\)$/i.test(label)) return "Brand";
    if (/^Zip\\s*\\(\\s*ASIN Metrics\\s*\\)$/i.test(label)) return "ASIN";
    if (/^Search Report$/i.test(label)) return "SR";
    return null;
  };
  const isExcel = (label) => /excel|\\.xlsx?|\\.xls\\b/i.test(label);
  const controls = Array.from(document.querySelectorAll("button, a")).filter((el) => {
    const t = labelOf(el);
    if (!t || isExcel(t)) return false;
    return !!typeOf(t);
  });
  for (const el of controls) {
    const label = labelOf(el);
    const type = typeOf(label);
    const row = el.closest("tr") || el.closest("[role=row]");
    let date = "", advertiser = "", status = "";
    if (row) {
      const cells = Array.from(row.querySelectorAll("td, [role=cell]")).map((c) => ((c.innerText || "") + "").trim());
      advertiser = cells[0] || "";
      status = cells[2] || "";
      date = cells[3] || "";
      if (!date) {
        for (const c of cells) {
          if (/\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\/\\d{1,2}\\/\\d{4}/.test(c)) { date = c; break; }
        }
      }
    }
    const key = type + "::" + date + "::" + label + "::" + advertiser;
    if (key !== want) continue;
    el.scrollIntoView({ block: "center" });
    el.click();
    return JSON.stringify({
      ok: true, key, type, label, date, advertiser, status,
      excel: false, url: location.href, count: controls.length
    });
  }
  return JSON.stringify({ ok: false, error: "key_not_found", want, count: controls.length, url: location.href });
})()`;

async function openReportsPage(signal?: AbortSignal): Promise<{ url: string; auth: AuthKind | null; body: string }> {
  await abvpBrowser(["open", PORTAL_URL], { timeoutMs: 90_000, signal });
  await abvpBrowser(["wait", "4000"], { timeoutMs: 15_000, signal }).catch(() => undefined);
  const url = await abvpBrowser(["get", "url"], { timeoutMs: 15_000, signal });
  let body = "";
  try {
    const raw = await abvpBrowser(
      ["eval", "((document.body&&document.body.innerText)||\"\").slice(0,2000)"],
      { timeoutMs: 20_000, signal },
    );
    body = raw.replace(/^"|"$/g, "");
  } catch {
    body = "";
  }
  return { url, auth: classifyAuth(url, body), body };
}

async function readPortalSnapshot(signal?: AbortSignal) {
  const raw = await abvpBrowser(["eval", ENUMERATE_JS], { timeoutMs: 60_000, signal });
  return parseEvalJson<{
    url: string;
    title: string;
    authish: boolean;
    marketplaceHint: boolean;
    bodySample: string;
    hasTable: boolean;
    count: number;
    rows: Array<{
      key: string;
      type: ReportType;
      label: string;
      date: string;
      status: string;
      advertiser: string;
      fingerprint: string;
    }>;
    maxScroll: number;
  }>(raw);
}

async function inventoryPortal(signal?: AbortSignal): Promise<{
  auth: AuthKind | null;
  url: string;
  rows: PortalRow[];
  contractOk: boolean;
  reason?: string;
}> {
  let lastCount = -1;
  let stable = 0;
  for (let i = 0; i < 40; i++) {
    await abvpBrowser(
      [
        "eval",
        `(() => {
          const nodes = Array.from(document.querySelectorAll('[role=rowgroup], [class*=scroll], [class*=virtual], table, main, body'));
          for (const n of nodes) { try { n.scrollTop = n.scrollHeight; } catch (e) {} }
          window.scrollTo(0, document.body.scrollHeight);
          return 'ok';
        })()`,
      ],
      { timeoutMs: 15_000, signal },
    ).catch(() => undefined);
    await abvpBrowser(["wait", "700"], { timeoutMs: 5_000, signal }).catch(() => undefined);
    const snap = await readPortalSnapshot(signal);
    const auth = classifyAuth(snap.url, snap.bodySample || "");
    if (auth) return { auth, url: snap.url, rows: [], contractOk: false, reason: auth };
    if (snap.count === lastCount) stable += 1;
    else {
      stable = 0;
      lastCount = snap.count;
    }
    if (stable >= 3 && snap.count > 0) break;
    if (stable >= 5 && snap.count === 0) break;
  }

  const data = await readPortalSnapshot(signal);
  const auth = classifyAuth(data.url, data.bodySample || "");
  if (auth) return { auth, url: data.url, rows: [], contractOk: false, reason: auth };

  // Accept PNG_US reports route strictly (hash or path form).
  const routeOk = data.url.includes("ABVP/PNG_US/reports");
  const contractOk = routeOk && data.marketplaceHint && (data.hasTable || data.count > 0);
  if (!contractOk) {
    return {
      auth: "portal_contract_failure",
      url: data.url,
      rows: [],
      contractOk: false,
      reason: `route/marketplace/table failed url=${data.url} market=${data.marketplaceHint} table=${data.hasTable} count=${data.count}`,
    };
  }
  if (data.count === 0) {
    return {
      auth: "portal_contract_failure",
      url: data.url,
      rows: [],
      contractOk: false,
      reason: "empty inventory after scroll-to-stable",
    };
  }

  const rows: PortalRow[] = [];
  for (const r of data.rows || []) {
    if (!r.type || isExcelLabel(r.label)) continue;
    const portalDate = normalizePortalDate(r.date);
    if (!portalDate) continue;
    rows.push({
      key: `${r.type}::${portalDate}::${r.label}::${r.advertiser}`,
      type: r.type,
      label: r.label,
      date: portalDate,
      status: r.status,
      advertiser: r.advertiser,
      fingerprint: `${r.type}|${portalDate}|${r.label}|${r.advertiser}|${r.status}`,
    });
  }
  return { auth: null, url: data.url, rows, contractOk: true };
}

interface LandingMeta {
  path: string;
  root: string;
  size: number;
  mtimeMs: number;
  ino: number | null;
  partial: boolean;
}

async function snapshotLanding(): Promise<{ files: Map<string, LandingMeta>; partials: string[] }> {
  const files = new Map<string, LandingMeta>();
  const partials: string[] = [];
  for (const root of LANDING_ROOTS) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === "amazon-advertising-reports") continue;
      const abs = join(root, name);
      const partial =
        name.endsWith(".crdownload") ||
        name.endsWith(".tmp") ||
        name.endsWith(".download") ||
        name.startsWith(".com.google.Chrome.") ||
        name.startsWith(".");
      if (partial) {
        // Ignore our own hidden files except chrome temps
        if (name.startsWith(".") && !name.startsWith(".com.google.Chrome.") && !name.endsWith(".crdownload")) {
          /* skip ordinary dotfiles */
        } else {
          partials.push(abs);
        }
        continue;
      }
      try {
        const st = await fs.stat(abs);
        if (!st.isFile()) continue;
        files.set(abs, {
          path: abs,
          root,
          size: st.size,
          mtimeMs: st.mtimeMs,
          ino: typeof st.ino === "number" ? st.ino : null,
          partial: false,
        });
      } catch {
        /* race */
      }
    }
  }
  return { files, partials };
}

async function waitForCausalDownload(opts: {
  before: Map<string, LandingMeta>;
  clickAtMs: number;
  expectedType: ReportType;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<string | null> {
  const deadline = Date.now() + opts.timeoutMs;
  const skew = 5_000;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const snap = await snapshotLanding();
    // Ignore pre-existing unrelated partials; only care about new/changed partials after click
    const newPartials = snap.partials.filter((p) => {
      const base = p.replace(/\\.crdownload$|\\.tmp$|\\.download$/i, "");
      return !opts.before.has(base) && !opts.before.has(p);
    });
    const candidates: LandingMeta[] = [];
    for (const [path, meta] of snap.files) {
      if (!path.toLowerCase().endsWith(".zip")) continue;
      const prev = opts.before.get(path);
      const bornAfterClick = meta.mtimeMs + skew >= opts.clickAtMs;
      const isNew = !prev;
      const replaced =
        !!prev &&
        ((prev.ino != null && meta.ino != null && prev.ino !== meta.ino) ||
          meta.size !== prev.size ||
          meta.mtimeMs > prev.mtimeMs + 500);
      if ((isNew || replaced) && bornAfterClick) candidates.push(meta);
    }
    if (candidates.length && newPartials.length === 0) {
      // stability: size unchanged across 1.5s
      const sizes1 = candidates.map((c) => c.size);
      await new Promise((r) => setTimeout(r, 1500));
      const snap2 = await snapshotLanding();
      const stable = candidates.filter((c) => {
        const cur = snap2.files.get(c.path);
        return cur && cur.size === c.size && cur.size > 0 && sizes1.includes(cur.size);
      });
      if (stable.length === 1) return stable[0]!.path;
      if (stable.length > 1) {
        // Prefer most recently modified
        stable.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return stable[0]!.path;
      }
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return null;
}

type LedgerQuery =
  | { kind: "ok"; rows: Record<string, { status: string; row_count: number }> }
  | { kind: "query_error"; error: string };

async function queryLedger(
  dbPath: string,
  ledgerPath: string,
  sources: string[],
): Promise<LedgerQuery> {
  const srcList = sources.map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
  const sql = `
SELECT source_file, status, COALESCE(row_count,0) AS row_count
FROM ingestion_drop
WHERE file_path = '${ledgerPath.replace(/'/g, "''")}'
  AND source_file IN (${srcList});
`;
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const rows = stdout.trim()
      ? (JSON.parse(stdout) as Array<{ source_file: string; status: string; row_count: number }>)
      : [];
    const out: Record<string, { status: string; row_count: number }> = {};
    for (const r of rows) out[r.source_file] = { status: r.status, row_count: r.row_count };
    return { kind: "ok", rows: out };
  } catch (err) {
    return { kind: "query_error", error: err instanceof Error ? err.message : String(err) };
  }
}

function sourcesComplete(
  ledger: Record<string, { status: string; row_count: number }>,
  required: string[],
): boolean {
  return required.every((s) => ledger[s]?.status === "completed" && (ledger[s]?.row_count ?? 0) > 0);
}

async function placeCanonical(
  stagingPath: string,
  canonicalPath: string,
  runId: string,
): Promise<{ action: "placed" | "same_hash_skip" | "quarantined"; sha256: string; quarantinePath?: string }> {
  const sha = await sha256File(stagingPath);
  if (existsSync(canonicalPath)) {
    const existing = await sha256File(canonicalPath);
    if (existing === sha) {
      await fs.unlink(stagingPath).catch(() => undefined);
      return { action: "same_hash_skip", sha256: sha };
    }
    const qName = `${basename(canonicalPath, ".zip")}__conflict__${sha.slice(0, 12)}__${runId}__${randomBytes(3).toString("hex")}.zip`;
    const qPath = join(QUARANTINE_DIR, qName);
    await fs.rename(stagingPath, qPath);
    return { action: "quarantined", sha256: sha, quarantinePath: qPath };
  }

  const dir = dirname(canonicalPath);
  await fs.mkdir(dir, { recursive: true });
  const partial = join(dir, `.${basename(canonicalPath)}.partial.${runId}.${randomBytes(3).toString("hex")}`);
  await fs.copyFile(stagingPath, partial);
  const fh = await fs.open(partial, "r+");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }

  // No-replace publish: exclusive link into place, else compare raced destination.
  try {
    await fs.link(partial, canonicalPath);
    await fs.unlink(partial).catch(() => undefined);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      const existing = await sha256File(canonicalPath);
      await fs.unlink(partial).catch(() => undefined);
      if (existing === sha) {
        await fs.unlink(stagingPath).catch(() => undefined);
        return { action: "same_hash_skip", sha256: sha };
      }
      const qName = `${basename(canonicalPath, ".zip")}__conflict__${sha.slice(0, 12)}__${runId}__${randomBytes(3).toString("hex")}.zip`;
      const qPath = join(QUARANTINE_DIR, qName);
      await fs.rename(stagingPath, qPath).catch(async () => {
        await fs.copyFile(stagingPath, qPath);
        await fs.unlink(stagingPath).catch(() => undefined);
      });
      return { action: "quarantined", sha256: sha, quarantinePath: qPath };
    }
    await fs.unlink(partial).catch(() => undefined);
    throw err;
  }

  try {
    const dh = await fs.open(dir, "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    /* best-effort */
  }
  await fs.unlink(stagingPath).catch(() => undefined);
  return { action: "placed", sha256: sha };
}

async function sendTelegramDecision(
  ctx: AbvpRefreshContext,
  state: RunState,
  kind: AuthKind,
  url: string,
): Promise<{ sent: boolean; messageId?: number }> {
  if (!ctx.bot) return { sent: false };
  const deadline = new Date(Date.now() + AUTH_WAIT_MS).toLocaleString("en-US", { timeZone: TZ });
  const message =
    `ABVP refresh needs Amazon Ads login action. Run ${state.run_id} hit ${kind} at ${url} ` +
    `before canonical placement or ingest. Open the already-headed Chrome window, complete login/MFA, ` +
    `and return to PNG_US Reports by ${deadline} PT. Homer will poll for 45 minutes; otherwise this run exits ` +
    `and the next due tick retries. next_due_at remains ${state.next_due_at_before}. No canonical or DB writes were made.`;
  const formatted = formatScheduledTelegramHtml(message);

  for (let attempt = 1; attempt <= TELEGRAM_RETRY; attempt++) {
    try {
      const result = await routeTelegramNotification({
        db: ctx.db,
        sourceType: "scheduler_job",
        sourceId: "abvp-refresh",
        jobRunId: ctx.jobRunId,
        intent: "decision_request",
        title: "ABVP refresh — Amazon Ads login",
        messageText: formatted,
        deliver: async () =>
          sendChunkedTelegramMessage({
            bot: ctx.bot!,
            chatId: ctx.chatId,
            message: formatted,
            parseMode: "HTML",
            enableLinkPreview: false,
          }),
      });
      if (result.decision === "sent" && result.telegramMessageId != null) {
        return { sent: true, messageId: result.telegramMessageId };
      }
    } catch (err) {
      logger.warn({ err, attempt }, "ABVP auth Telegram send failed");
    }
    await new Promise((r) => setTimeout(r, attempt * 1500));
  }
  return { sent: false };
}

async function sendSummary(
  ctx: AbvpRefreshContext,
  text: string,
  intent: NotificationIntent,
): Promise<boolean> {
  if (!ctx.bot) return false;
  const formatted = formatScheduledTelegramHtml(text);
  try {
    const result = await routeTelegramNotification({
      db: ctx.db,
      sourceType: "scheduler_job",
      sourceId: "abvp-refresh",
      jobRunId: ctx.jobRunId,
      intent,
      title: "ABVP refresh",
      messageText: formatted,
      deliver: async () =>
        sendChunkedTelegramMessage({
          bot: ctx.bot!,
          chatId: ctx.chatId,
          message: formatted,
          parseMode: "HTML",
          enableLinkPreview: false,
        }),
    });
    return result.decision === "sent";
  } catch (err) {
    logger.warn({ err }, "ABVP summary Telegram failed");
    return false;
  }
}

async function terminateProcessGroup(pgid: number, timeoutMs = 30_000): Promise<void> {
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    try {
      process.kill(pgid, "SIGTERM");
    } catch {
      return;
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pgid, 0);
      await new Promise((r) => setTimeout(r, 200));
    } catch {
      return; // gone
    }
  }
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    try {
      process.kill(pgid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  await new Promise((r) => setTimeout(r, 200));
}

async function runPythonIngest(
  state: RunState,
  statePath: string,
  args: string[],
  logName: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; output: string }> {
  const logPath = join(INGEST_LOGS_DIR, `${logName}_${state.run_id}.log`);
  await fs.mkdir(INGEST_LOGS_DIR, { recursive: true });
  const outStream = createWriteStream(logPath, { flags: "a" });

  return new Promise((resolve) => {
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;
    const child = spawn("python3", ["-u", ...args], {
      cwd: ABVP_ROOT,
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcess;

    const pgid = child.pid ?? null;
    state.child = {
      pid: child.pid ?? null,
      pgid,
      type: args[0] || null,
      started_at: nowIso(),
    };

    const finish = async (ok: boolean, output: string) => {
      if (settled) return;
      settled = true;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      signal?.removeEventListener("abort", onAbort);
      outStream.end();
      state.child = { pid: null, pgid: null, type: null, started_at: null };
      await atomicWriteJson(statePath, state).catch(() => undefined);
      resolve({ ok, output: output.slice(-8000) });
    };

    void atomicWriteJson(statePath, state);

    let output = "";
    child.stdout?.on("data", (buf: Buffer) => {
      const s = buf.toString();
      output += s;
      outStream.write(s);
    });
    child.stderr?.on("data", (buf: Buffer) => {
      const s = buf.toString();
      output += s;
      outStream.write(s);
    });
    child.on("error", (err) => {
      void finish(false, output + `\nspawn error: ${err.message}`);
    });

    const onAbort = () => {
      if (pgid == null) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        process.kill(-pgid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
      killTimer = setTimeout(() => {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }, 30_000);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.on("close", (code) => {
      void finish(code === 0, output);
    });
  });
}

function newRunState(cadence: CadenceState): RunState {
  const today = localToday();
  const runId = `abvp-${today.replace(/-/g, "")}T${new Date()
    .toISOString()
    .slice(11, 19)
    .replace(/:/g, "")}-${randomBytes(3).toString("hex")}`;
  return {
    schema_version: 2,
    run_id: runId,
    attempt: 1,
    status: "inventory",
    stage: "cadence",
    created_at: nowIso(),
    updated_at: nowIso(),
    today_local: today,
    lookback_start: addDaysLocal(today, -(LOOKBACK_DAYS - 1)),
    lookback_end: today,
    next_due_at_before: cadence.next_due_at,
    inventory: {
      portal_url: PORTAL_URL,
      marketplace: "PNG_US",
      contract_verified: false,
      coverage_complete: false,
      row_count: 0,
      sealed_at: null,
      window: {
        Brand: { in_window: 0, outside_window: 0, status: "unknown" },
        ASIN: { in_window: 0, outside_window: 0, status: "unknown" },
        SR: { in_window: 0, outside_window: 0, status: "unknown" },
      },
    },
    items: [],
    child: { pid: null, pgid: null, type: null, started_at: null },
    auth: { kind: null, detected_at: null, deadline: null, current_url: null },
    notification: { intent: null, status: "none", telegram_message_id: null },
    wal_checkpoint: null,
    cadence_advanced_at: null,
    last_error: null,
  };
}

function buildWindowAndItems(
  rows: PortalRow[],
  lookbackStart: string,
  lookbackEnd: string,
): {
  items: RunItem[];
  window: RunState["inventory"]["window"];
  ok: boolean;
  reason?: string;
} {
  const window: RunState["inventory"]["window"] = {
    Brand: { in_window: 0, outside_window: 0, status: "unknown" },
    ASIN: { in_window: 0, outside_window: 0, status: "unknown" },
    SR: { in_window: 0, outside_window: 0, status: "unknown" },
  };
  const selected: RunItem[] = [];
  const seenIds = new Set<string>();

  for (const row of rows) {
    const type = row.type;
    const portalDate = row.date;
    const start = parseLocalDate(lookbackStart);
    const end = parseLocalDate(lookbackEnd);
    const d = parseLocalDate(portalDate);
    const inWindow = d >= start && d <= end;
    if (inWindow) window[type].in_window += 1;
    else window[type].outside_window += 1;

    if (!inWindow) continue;
    const id = contractId(type, portalDate);
    if (seenIds.has(id)) {
      return {
        items: [],
        window,
        ok: false,
        reason: `ambiguous duplicate portal identity ${id}`,
      };
    }
    seenIds.add(id);
    const canon = canonicalFor(type, portalDate);
    selected.push({
      id,
      type,
      portal_date: portalDate,
      portal_label: row.label,
      portal_key: row.key,
      portal_fingerprint: row.fingerprint,
      canonical_path: canon.abs,
      ledger_file_path: canon.ledger,
      required_sources: canon.sources,
      stage: "selected",
      staging_path: null,
      landing_path: null,
      size_bytes: 0,
      sha256: null,
      zip_valid: false,
      place_action: "pending",
      ingest: Object.fromEntries(canon.sources.map((s) => [s, { status: "pending", row_count: null }])),
      attempts: { download: 0, ingest: 0 },
      error: null,
    });
  }

  for (const t of ["Brand", "ASIN", "SR"] as ReportType[]) {
    if (window[t].in_window > 0) window[t].status = "present_in_window";
    else if (window[t].outside_window > 0) window[t].status = "absent_confirmed";
    else window[t].status = "missing_from_inventory";
  }

  const incomplete = (["Brand", "ASIN", "SR"] as ReportType[]).filter(
    (t) => window[t].status === "missing_from_inventory",
  );
  if (incomplete.length) {
    return {
      items: selected,
      window,
      ok: false,
      reason: `inventory missing report classes: ${incomplete.join(",")}`,
    };
  }
  if (selected.length === 0) {
    return {
      items: selected,
      window,
      ok: false,
      reason: "zero Brand/ASIN/SR rows in 28-day window — refusing empty success",
    };
  }

  selected.sort((a, b) => {
    if (a.portal_date !== b.portal_date) return a.portal_date < b.portal_date ? -1 : 1;
    const order = { Brand: 0, ASIN: 1, SR: 2 } as const;
    return order[a.type] - order[b.type];
  });
  return { items: selected, window, ok: true };
}

async function resolveRun(cadence: CadenceState): Promise<{
  state: RunState;
  runDir: string;
  stagingDir: string;
  statePath: string;
}> {
  const active = await readJson<{ run_id: string; state_path: string }>(ACTIVE_PATH);
  if (active?.state_path && active.run_id) {
    const prior = await readJson<RunState>(active.state_path);
    if (prior && !TERMINAL_STATUSES.has(prior.status)) {
      const runDir = join(RUNS_DIR, prior.run_id);
      const stagingDir = join(runDir, "staging");
      const statePath = join(runDir, "state.json");
      if (active.run_id !== prior.run_id || active.state_path !== statePath) {
        throw new Error(
          `active pointer / state identity mismatch active=${active.run_id} state=${prior.run_id}`,
        );
      }
      await fs.mkdir(stagingDir, { recursive: true });
      prior.attempt += 1;
      prior.updated_at = nowIso();
      // Normalize schema upgrades
      if (!(prior as { lookback_end?: string }).lookback_end) {
        (prior as RunState).lookback_end = prior.today_local;
      }
      if (!(prior as { wal_checkpoint?: null }).wal_checkpoint) {
        (prior as RunState).wal_checkpoint = null;
      }
      (prior as RunState).schema_version = 2;
      logger.info({ runId: prior.run_id, attempt: prior.attempt }, "Resuming ABVP run");
      return { state: prior as RunState, runDir, stagingDir, statePath };
    }
  }

  const state = newRunState(cadence);
  const runDir = join(RUNS_DIR, state.run_id);
  const stagingDir = join(runDir, "staging");
  const statePath = join(runDir, "state.json");
  await fs.mkdir(stagingDir, { recursive: true });
  return { state, runDir, stagingDir, statePath };
}

async function revalidateItemBytes(item: RunItem): Promise<boolean> {
  const path = item.staging_path && existsSync(item.staging_path) ? item.staging_path : item.canonical_path;
  if (!existsSync(path)) return false;
  const v = await validateZip(path, item.type);
  if (!v.ok) return false;
  const sha = await sha256File(path);
  if (item.sha256 && item.sha256 !== sha) return false;
  item.sha256 = sha;
  item.size_bytes = (await fs.stat(path)).size;
  item.zip_valid = true;
  return true;
}

export async function runAbvpRefresh(ctx: AbvpRefreshContext): Promise<AbvpRefreshResult> {
  await ensureDirs();
  const cadence = await loadCadence();

  if (!isDue(cadence.next_due_at)) {
    return {
      success: true,
      output: `ABVP refresh off-cycle (next_due_at=${cadence.next_due_at})`,
      notificationIntent: "operational_status",
    };
  }

  const lock = new PipelineLock();
  if (!lock.acquire()) {
    return {
      success: false,
      output: "",
      error: "ABVP pipeline lock busy (.abvp.lock)",
      notificationIntent: "failure_alert",
    };
  }

  // All post-lock work stays inside try/finally so the flock cannot leak.
  let state: RunState | null = null;
  let statePath = "";
  let stagingDir = "";
  const dbPath = join(ABVP_ROOT, "abvp.db");
  const started = ctx.startedAt.getTime();

  try {
    const resolved = await resolveRun(cadence);
    state = resolved.state;
    statePath = resolved.statePath;
    stagingDir = resolved.stagingDir;
    await atomicWriteJson(statePath, state);
    await atomicWriteJson(ACTIVE_PATH, { run_id: state.run_id, state_path: statePath });

    const persist = async () => {
      state!.updated_at = nowIso();
      await atomicWriteJson(statePath, state);
    };

    const fail = async (
      error: string,
      intent: NotificationIntent = "failure_alert",
    ): Promise<AbvpRefreshResult> => {
      state!.status = state!.status === "interrupted" ? "interrupted" : "failed";
      state!.last_error = error;
      await persist();
      const sent = await sendSummary(ctx, `ABVP refresh failed — ${error}`, intent);
      return {
        success: false,
        output: error,
        error,
        notificationIntent: intent,
        sideEffectDelivered: sent,
      };
    };

    // Disk floor (full three-term formula; remaining estimate uses conservative 400MB/item fallback)
    const free = await diskFreeBytes(ABVP_ROOT);
    const dbSize = existsSync(dbPath) ? (await fs.stat(dbPath)).size : 0;
    const pendingEstimate = Math.max(state.items.length, 6) * 400 * 1024 * 1024;
    const floor = Math.max(25 * 1024 ** 3, Math.floor(dbSize * 0.5), 2 * pendingEstimate + 5 * 1024 ** 3);
    if (free < floor) {
      return fail(`low disk: free=${free} floor=${floor}`);
    }

    // Portal phase under shared browser mutex
    const portalResult = await withScrapeLock(async () => {
      state!.stage = "preflight";
      await persist();
      await ensureBrowserReady(ctx.signal);

      const obtainInventory = async (): Promise<
        | { ok: true; inv: Awaited<ReturnType<typeof inventoryPortal>> }
        | { ok: false; result: AbvpRefreshResult }
      > => {
        for (let authRound = 0; authRound < 2; authRound++) {
          const opened = await openReportsPage(ctx.signal);
          if (opened.auth) {
            const wait = await handleAuthWait(ctx, state!, statePath, opened.auth, opened.url);
            if (!wait.restored) return { ok: false, result: wait.result! };
            // restoration succeeded — loop to inventory again
            continue;
          }
          const inv = await inventoryPortal(ctx.signal);
          if (inv.auth && inv.auth !== "portal_contract_failure") {
            const wait = await handleAuthWait(ctx, state!, statePath, inv.auth, inv.url);
            if (!wait.restored) return { ok: false, result: wait.result! };
            continue;
          }
          return { ok: true, inv };
        }
        state!.status = "failed";
        state!.last_error = "portal inventory unavailable after auth wait";
        await persist();
        return {
          ok: false,
          result: {
            success: false,
            output: state!.last_error,
            error: state!.last_error,
            notificationIntent: "failure_alert",
            sideEffectDelivered: false,
          },
        };
      };

      const got = await obtainInventory();
      if (!got.ok) return got.result;
      let inv = got.inv;

      if (inv.auth === "portal_contract_failure" || !inv.contractOk) {
        return fail(inv.reason || `portal_contract_failure at ${inv.url}`);
      }

      const built = buildWindowAndItems(inv.rows, state!.lookback_start, state!.lookback_end);
      if (!built.ok) {
        state!.inventory = {
          portal_url: inv.url,
          marketplace: "PNG_US",
          contract_verified: true,
          coverage_complete: false,
          row_count: inv.rows.length,
          sealed_at: nowIso(),
          window: built.window,
        };
        await persist();
        return fail(built.reason || "incomplete 28-day inventory");
      }

      // Reconcile prior progress by contract identity + revalidate bytes
      const priorById = new Map(state!.items.map((i) => [i.id, i]));
      const fresh: RunItem[] = [];
      for (const item of built.items) {
        const prev = priorById.get(item.id);
        if (!prev) {
          fresh.push(item);
          continue;
        }
        const merged: RunItem = {
          ...item,
          stage: prev.stage,
          staging_path: prev.staging_path,
          landing_path: prev.landing_path ?? null,
          size_bytes: prev.size_bytes,
          sha256: prev.sha256,
          zip_valid: false,
          place_action: prev.place_action,
          ingest: prev.ingest,
          attempts: prev.attempts,
          error: prev.error,
        };
        if (["validated", "placed", "same_hash_skip", "click_skipped", "verified"].includes(merged.stage)) {
          const ok = await revalidateItemBytes(merged);
          if (!ok) {
            merged.stage = "selected";
            merged.staging_path = null;
            merged.landing_path = null;
            merged.sha256 = null;
            merged.zip_valid = false;
            merged.place_action = "pending";
            merged.error = "resume revalidation failed; will reacquire";
          }
        }
        fresh.push(merged);
      }
      state!.items = fresh;
      state!.inventory = {
        portal_url: inv.url,
        marketplace: "PNG_US",
        contract_verified: true,
        coverage_complete: true,
        row_count: inv.rows.length,
        sealed_at: nowIso(),
        window: built.window,
      };
      state!.status = "downloading";
      state!.stage = "download";
      await persist();

      // Re-estimate disk with actual item count
      const free2 = await diskFreeBytes(ABVP_ROOT);
      const remaining = state!.items.filter((i) => !["click_skipped", "validated", "placed", "verified", "same_hash_skip"].includes(i.stage)).length;
      const est2 = Math.max(remaining, 1) * 400 * 1024 * 1024;
      const floor2 = Math.max(25 * 1024 ** 3, Math.floor(dbSize * 0.5), 2 * est2 + 5 * 1024 ** 3);
      if (free2 < floor2) return fail(`low disk before acquisition: free=${free2} floor=${floor2}`);

      for (let di = 0; di < state!.items.length; di++) {
        const item = state!.items[di]!;
        if (ctx.signal?.aborted) throw new Error("aborted");

        if (existsSync(item.canonical_path)) {
          const v = await validateZip(item.canonical_path, item.type);
          if (v.ok) {
            const sha = await sha256File(item.canonical_path);
            item.sha256 = sha;
            item.size_bytes = (await fs.stat(item.canonical_path)).size;
            item.zip_valid = true;
            item.stage = "click_skipped";
            item.place_action = "same_hash_skip";
            await persist();
            continue;
          }
        }

        if (item.staging_path && existsSync(item.staging_path) && item.zip_valid) {
          const ok = await revalidateItemBytes(item);
          if (ok) {
            item.stage = "validated";
            await persist();
            continue;
          }
        }

        const maxAttempts = 2; // one clean retry for invalid download
        let acquired = false;
        while (item.attempts.download < maxAttempts && !acquired) {
          item.attempts.download += 1;
          item.stage = "downloading";
          await persist();

          const beforeSnap = await snapshotLanding();
          const clickAtMs = Date.now();
          const clickRaw = await abvpBrowser(["eval", CLICK_BY_KEY_JS(item.portal_key)], {
            timeoutMs: 30_000,
            signal: ctx.signal,
          });
          const click = parseEvalJson<{
            ok: boolean;
            error?: string;
            url?: string;
            type?: string;
            label?: string;
            date?: string;
            excel?: boolean;
          }>(clickRaw);

          const bodySample = await abvpBrowser(
            ["eval", "((document.body&&document.body.innerText)||\"\").slice(0,1500)"],
            { timeoutMs: 15_000, signal: ctx.signal },
          ).catch(() => "");
          const urlNow = click.url || (await abvpBrowser(["get", "url"], { timeoutMs: 10_000, signal: ctx.signal }));
          const authNow = classifyAuth(urlNow, bodySample.replace(/^"|"$/g, ""));

          if (!click.ok || authNow) {
            if (authNow) {
              const wait = await handleAuthWait(ctx, state!, statePath, authNow, urlNow);
              if (!wait.restored) return wait.result!;
              // Fresh inventory + remap after auth
              const again = await obtainInventory();
              if (!again.ok) return again.result;
              inv = again.inv;
              if (!inv.contractOk || inv.auth) return fail(inv.reason || "post-auth inventory failed");
              const rebuilt = buildWindowAndItems(inv.rows, state!.lookback_start, state!.lookback_end);
              if (!rebuilt.ok) return fail(rebuilt.reason || "post-auth window incomplete");
              const byId = new Map(rebuilt.items.map((i) => [i.id, i]));
              const match = byId.get(item.id);
              if (!match) return fail(`post-auth remap missed ${item.id}`);
              item.portal_key = match.portal_key;
              item.portal_fingerprint = match.portal_fingerprint;
              item.portal_label = match.portal_label;
              item.attempts.download -= 1; // auth doesn't consume retry budget
              continue;
            }
            return fail(`download click failed for ${item.id}: ${click.error || "click failed"}`);
          }

          if (click.excel || isExcelLabel(click.label || "")) {
            return fail(`refusing EXCEL click for ${item.id}`);
          }
          const clickedType = labelToType(click.label || "");
          const clickedDate = normalizePortalDate(click.date || "");
          if (clickedType !== item.type || clickedDate !== item.portal_date) {
            return fail(
              `click assert failed for ${item.id}: got type=${clickedType} date=${clickedDate} label=${click.label}`,
            );
          }

          const landed = await waitForCausalDownload({
            before: beforeSnap.files,
            clickAtMs,
            expectedType: item.type,
            timeoutMs: 360_000,
            signal: ctx.signal,
          });
          if (!landed) {
            const url2 = await abvpBrowser(["get", "url"], { timeoutMs: 10_000, signal: ctx.signal });
            const body2 = await abvpBrowser(
              ["eval", "((document.body&&document.body.innerText)||\"\").slice(0,1500)"],
              { timeoutMs: 15_000, signal: ctx.signal },
            ).catch(() => "");
            const auth2 = classifyAuth(url2, body2.replace(/^"|"$/g, ""));
            if (auth2) {
              const wait = await handleAuthWait(ctx, state!, statePath, auth2, url2);
              if (!wait.restored) return wait.result!;
              const again = await obtainInventory();
              if (!again.ok) return again.result;
              inv = again.inv;
              if (!inv.contractOk || inv.auth) return fail(inv.reason || "post-auth inventory failed");
              const rebuilt = buildWindowAndItems(inv.rows, state!.lookback_start, state!.lookback_end);
              if (!rebuilt.ok) return fail(rebuilt.reason || "post-auth window incomplete");
              const match = rebuilt.items.find((i) => i.id === item.id);
              if (!match) return fail(`post-auth remap missed ${item.id}`);
              item.portal_key = match.portal_key;
              item.portal_fingerprint = match.portal_fingerprint;
              item.attempts.download -= 1;
              continue;
            }
            if (item.attempts.download < maxAttempts) continue;
            return fail(`download timeout for ${item.id}`);
          }

          item.landing_path = landed;
          await persist();

          const stagingPath = join(
            stagingDir,
            `${item.type}_${item.portal_date}__${basename(landed)}__${randomBytes(2).toString("hex")}.zip`,
          );
          await fs.copyFile(landed, stagingPath);
          // Keep landing until validated; then delete owned landing copy
          const v = await validateZip(stagingPath, item.type);
          if (!v.ok) {
            const q = join(
              QUARANTINE_DIR,
              `${item.type}_${item.portal_date}__bad__${randomBytes(4).toString("hex")}.zip`,
            );
            await fs.rename(stagingPath, q).catch(() => undefined);
            await fs.unlink(landed).catch(() => undefined);
            item.landing_path = null;
            item.error = v.error || "invalid zip";
            await persist();
            if (item.attempts.download < maxAttempts) continue;
            item.stage = "quarantined";
            return fail(`invalid zip for ${item.id} after retry: ${item.error}`);
          }

          await fs.unlink(landed).catch(() => undefined);
          item.landing_path = null;
          item.staging_path = stagingPath;
          item.sha256 = await sha256File(stagingPath);
          item.size_bytes = (await fs.stat(stagingPath)).size;
          item.zip_valid = true;
          item.stage = "validated";
          await persist();
          acquired = true;
        }
        if (!acquired) return fail(`could not acquire ${item.id}`);
      }

      return null; // portal phase OK
    });

    if (portalResult) return portalResult;

    // Place phase (browser mutex released)
    state.status = "placing";
    state.stage = "place";
    await persist();
    for (const item of state.items) {
      if (item.place_action === "same_hash_skip" && existsSync(item.canonical_path)) {
        const ok = await revalidateItemBytes(item);
        if (!ok) return fail(`canonical revalidation failed for ${item.id}`);
        item.stage = "placed";
        await persist();
        continue;
      }
      if (!item.staging_path || !existsSync(item.staging_path)) {
        if (existsSync(item.canonical_path)) {
          const ok = await revalidateItemBytes(item);
          if (ok) {
            item.place_action = "same_hash_skip";
            item.stage = "placed";
            await persist();
            continue;
          }
        }
        return fail(`missing staging for place: ${item.id}`);
      }
      // Always revalidate staged bytes before publish
      const ok = await revalidateItemBytes(item);
      if (!ok) return fail(`staged zip revalidation failed for ${item.id}`);
      const placed = await placeCanonical(item.staging_path, item.canonical_path, state.run_id);
      item.sha256 = placed.sha256;
      item.place_action = placed.action;
      if (placed.action === "quarantined") {
        item.stage = "quarantined";
        item.error = `hash conflict → ${placed.quarantinePath}`;
        return fail(item.error);
      }
      item.staging_path = null;
      item.stage = "placed";
      await persist();
    }

    // Ingest
    state.status = "ingesting";
    const needBrand: string[] = [];
    const needAsin: string[] = [];
    const needSr: string[] = [];
    for (const item of state.items) {
      const ledger = await queryLedger(dbPath, item.ledger_file_path, item.required_sources);
      if (ledger.kind === "query_error") return fail(`ledger query_error: ${ledger.error}`);
      if (sourcesComplete(ledger.rows, item.required_sources)) {
        for (const s of item.required_sources) {
          item.ingest[s] = { status: "verified", row_count: ledger.rows[s]!.row_count };
        }
        item.stage = "verified";
        continue;
      }
      if (item.type === "Brand") needBrand.push(item.canonical_path);
      else if (item.type === "ASIN") needAsin.push(item.canonical_path);
      else needSr.push(item.canonical_path);
    }
    await persist();

    const free3 = await diskFreeBytes(ABVP_ROOT);
    const floor3 = Math.max(25 * 1024 ** 3, Math.floor(dbSize * 0.5), 5 * 1024 ** 3);
    if (free3 < floor3) return fail(`low disk before ingest: free=${free3} floor=${floor3}`);

    const maybeIngest = async (files: string[], mode: "brand" | "asin" | "sr", script: string[]) => {
      if (!files.length) return { ok: true, output: "nothing to ingest" };
      if (Date.now() - started > INGEST_START_CUTOFF_MS) {
        state!.status = "interrupted";
        state!.last_error = "90-minute ingest start cutoff reached; cadence left due";
        await persist();
        return { ok: false, output: state!.last_error };
      }
      state!.stage = mode === "brand" ? "ingest_brand" : mode === "asin" ? "ingest_asin" : "ingest_sr";
      await persist();
      return runPythonIngest(state!, statePath, [...script, "--files", ...files], `ingest_${mode}`, ctx.signal);
    };

    if (needBrand.length) {
      const r = await maybeIngest(needBrand, "brand", ["batch_ingest.py", "brand"]);
      if (!r.ok) {
        const sent = await sendSummary(ctx, `ABVP refresh incomplete — brand ingest: ${r.output.slice(-400)}`, "failure_alert");
        return {
          success: false,
          output: state.last_error || r.output,
          error: state.last_error || "brand ingest failed",
          notificationIntent: "failure_alert",
          sideEffectDelivered: sent,
        };
      }
    }
    if (needAsin.length) {
      const r = await maybeIngest(needAsin, "asin", ["batch_ingest.py", "asin"]);
      if (!r.ok) {
        const sent = await sendSummary(ctx, `ABVP refresh incomplete — asin ingest: ${r.output.slice(-400)}`, "failure_alert");
        return {
          success: false,
          output: state.last_error || r.output,
          error: state.last_error || "asin ingest failed",
          notificationIntent: "failure_alert",
          sideEffectDelivered: sent,
        };
      }
    }
    if (needSr.length) {
      const r = await maybeIngest(needSr, "sr", ["ingest_sr.py"]);
      if (!r.ok) {
        const sent = await sendSummary(ctx, `ABVP refresh incomplete — sr ingest: ${r.output.slice(-400)}`, "failure_alert");
        return {
          success: false,
          output: state.last_error || r.output,
          error: state.last_error || "sr ingest failed",
          notificationIntent: "failure_alert",
          sideEffectDelivered: sent,
        };
      }
    }

    // Verify
    state.status = "verifying";
    state.stage = "verify";
    await persist();
    if (!state.items.length || !state.inventory.coverage_complete) {
      return fail("refusing cadence advance on empty/incomplete inventory");
    }
    const missing: string[] = [];
    for (const item of state.items) {
      const ledger = await queryLedger(dbPath, item.ledger_file_path, item.required_sources);
      if (ledger.kind === "query_error") return fail(`ledger query_error at verify: ${ledger.error}`);
      if (!sourcesComplete(ledger.rows, item.required_sources)) {
        missing.push(item.id);
        item.stage = "failed";
        item.error = "ledger incomplete after ingest";
      } else {
        for (const s of item.required_sources) {
          item.ingest[s] = { status: "verified", row_count: ledger.rows[s]!.row_count };
        }
        item.stage = "verified";
      }
    }
    await persist();
    if (missing.length) return fail(`verify failed for: ${missing.join(", ")}`);

    // WAL checkpoint must succeed and be recorded before cadence advance
    try {
      const { stdout } = await execFileAsync(
        "sqlite3",
        ["-json", dbPath, "PRAGMA wal_checkpoint(TRUNCATE);"],
        { timeout: 180_000 },
      );
      const parsed = stdout.trim()
        ? (JSON.parse(stdout) as Array<{ busy: number; log: number; checkpointed: number }>)
        : [];
      const row = parsed[0];
      if (!row || row.busy !== 0) {
        return fail(`wal_checkpoint busy/error: ${stdout.trim() || "empty"}`);
      }
      state.wal_checkpoint = { ...row, at: nowIso() };
      await persist();
    } catch (err) {
      return fail(`wal_checkpoint failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    state.stage = "cadence_advance";
    const nextDue = advanceDue(cadence.next_due_at);
    const newCadence: CadenceState = {
      next_due_at: nextDue,
      last_success_at: nowIso(),
      last_run_id: state.run_id,
    };
    await atomicWriteJson(CADENCE_PATH, newCadence);
    state.cadence_advanced_at = nowIso();
    state.status = "completed";
    state.stage = "notify";
    await persist();
    await fs.unlink(ACTIVE_PATH).catch(() => undefined);

    const downloaded = state.items.filter((i) => i.place_action === "placed").length;
    const skipped = state.items.filter((i) => i.place_action === "same_hash_skip").length;
    const summary =
      `ABVP refresh OK (${state.run_id})\n` +
      `Window ${state.lookback_start} → ${state.lookback_end}: ${state.items.length} Brand/ASIN/SR rows\n` +
      `Placed ${downloaded}, local-skip ${skipped}, all ledger rows verified\n` +
      `WAL checkpoint ok; next_due_at → ${nextDue}`;

    const sent = await sendSummary(ctx, summary, "user_info");
    return {
      success: true,
      output: summary.replace(/\n/g, "; "),
      notificationIntent: "user_info",
      sideEffectDelivered: sent,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (state) {
      state.status = ctx.signal?.aborted ? "interrupted" : "failed";
      state.last_error = message;
      if (statePath) await atomicWriteJson(statePath, state).catch(() => undefined);
    }
    logger.error({ err, runId: state?.run_id }, "ABVP refresh failed");
    const sent = await sendSummary(
      ctx,
      `ABVP refresh ${state?.status || "failed"}: ${message}`,
      "failure_alert",
    ).catch(() => false);
    return {
      success: false,
      output: "",
      error: message,
      notificationIntent: "failure_alert",
      sideEffectDelivered: sent,
    };
  } finally {
    if (state?.child.pgid != null) {
      await terminateProcessGroup(state.child.pgid, 30_000).catch(() => undefined);
      state.child = { pid: null, pgid: null, type: null, started_at: null };
      if (statePath) await atomicWriteJson(statePath, state).catch(() => undefined);
    }
    lock.release();
  }
}

async function handleAuthWait(
  ctx: AbvpRefreshContext,
  state: RunState,
  statePath: string,
  kind: AuthKind,
  url: string,
): Promise<{ restored: boolean; result?: AbvpRefreshResult }> {
  state.status = "auth_wait";
  state.stage = "inventory";
  state.auth = {
    kind,
    detected_at: nowIso(),
    deadline: new Date(Date.now() + AUTH_WAIT_MS).toISOString(),
    current_url: url,
  };
  state.notification = { intent: "decision_request", status: "pending", telegram_message_id: null };
  await atomicWriteJson(statePath, state);

  if (kind === "bot_blocked" || kind === "portal_contract_failure") {
    state.status = "failed";
    state.last_error = kind;
    await atomicWriteJson(statePath, state);
    const sent = await sendSummary(ctx, `ABVP refresh failed — ${kind} at ${url}`, "failure_alert");
    return {
      restored: false,
      result: {
        success: false,
        output: kind,
        error: kind,
        notificationIntent: "failure_alert",
        sideEffectDelivered: sent,
      },
    };
  }

  const delivered = await sendTelegramDecision(ctx, state, kind, url);
  if (!delivered.sent) {
    state.status = "auth_unnotified";
    state.notification.status = "failed";
    state.last_error = "Telegram decision_request failed; not parking for auth";
    await atomicWriteJson(statePath, state);
    return {
      restored: false,
      result: {
        success: false,
        output: state.last_error,
        error: state.last_error,
        notificationIntent: "failure_alert",
        sideEffectDelivered: false,
      },
    };
  }

  state.notification.status = "sent";
  state.notification.telegram_message_id = delivered.messageId ?? null;
  await atomicWriteJson(statePath, state);

  const deadline = Date.now() + AUTH_WAIT_MS;
  while (Date.now() < deadline) {
    if (ctx.signal?.aborted) break;
    await new Promise((r) => setTimeout(r, AUTH_POLL_MS));
    try {
      const opened = await openReportsPage(ctx.signal);
      if (!opened.auth) {
        const inv = await inventoryPortal(ctx.signal);
        if (!inv.auth && inv.contractOk && inv.rows.length > 0) {
          state.status = "inventory";
          state.auth = { kind: null, detected_at: null, deadline: null, current_url: null };
          await atomicWriteJson(statePath, state);
          return { restored: true };
        }
      }
    } catch (err) {
      logger.warn({ err }, "ABVP auth poll error");
    }
  }

  state.status = "auth_timeout";
  state.last_error = `Auth/MFA not completed within 45m (${kind})`;
  await atomicWriteJson(statePath, state);
  const sent = await sendSummary(
    ctx,
    `ABVP refresh auth timeout — ${kind}. next_due_at unchanged.`,
    "failure_alert",
  );
  return {
    restored: false,
    result: {
      success: false,
      output: state.last_error,
      error: state.last_error,
      notificationIntent: "failure_alert",
      sideEffectDelivered: sent,
    },
  };
}
