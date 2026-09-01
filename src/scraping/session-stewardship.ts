import { Cron } from "croner";
import { logger } from "../utils/logger.js";
import { getPrivateOverlay, importPrivateModule } from "../private-overlay.js";
import { BrowserLeaseBroker, type TargetRecord } from "./browser-control.js";
import { BrowserStatusService } from "./browser-status.js";

/**
 * A browser surface kept signed in by scheduled "touches" (tab reloads that prove
 * the session is still authenticated). Surface definitions are operator-specific:
 * the private overlay's `stewardshipSurfacesModule` exports `SURFACES`
 * (Record<surfaceName, StewardshipSurface>); without one there is nothing to steward.
 */
export interface StewardshipSurface {
  /** Origins whose cookies are inspected and which a post-reload URL must belong to. */
  origins: readonly string[];
  /** Bootstrap URL used when reconciling the surface's tab. */
  url: string;
  /** Returns true for a CDP Network event that proves the reload happened signed in. */
  proof: (event: any) => boolean;
  /** Human-readable description of the proof recorded in the touch result. */
  validation: (deep: boolean) => string;
  /** Optional: request the longer (deep) validation window for a given local hour/weekday. */
  deepTouch?: (hour: number, weekdayShort: string) => boolean;
}

const HUMAN_QUIET_MS = 30 * 60 * 1000;
const TOUCH_HOURS = [8, 14, 20];
const TIMEZONE = "America/Los_Angeles";

export const stewardshipJitterMs = (random = Math.random): number => Math.floor(random() * 30 * 60_000) - 15 * 60_000;
export const stewardshipBackoffMs = (failures: number): number => Math.min(6 * 60 * 60_000, 15 * 60_000 * 2 ** Math.max(0, failures - 1));
export function stewardshipSkip(record: TargetRecord | undefined, humanAt: number | null, now: number, backoffUntil: number): string | null {
  if (!record) return "surface is not reconciled";
  if (record.leaseId) return `surface leased by ${record.owner}`;
  if (humanAt !== null && now - humanAt < HUMAN_QUIET_MS) return "human activity in last 30 minutes";
  if (now < backoffUntil) return "failure backoff active";
  return null;
}

class Cdp {
  private id = 0; private pending = new Map<number, (value: any) => void>();
  readonly events: any[] = [];
  constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id) { this.pending.get(msg.id)?.(msg); this.pending.delete(msg.id); } else this.events.push(msg);
    });
  }
  static async open(url: string): Promise<Cdp> {
    const ws = new WebSocket(url); await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve(), { once: true }); ws.addEventListener("error", () => reject(new Error("CDP WebSocket attach failed")), { once: true }); });
    return new Cdp(ws);
  }
  async call(method: string, params: object = {}): Promise<any> {
    const id = ++this.id; const reply = new Promise<any>((resolve) => this.pending.set(id, resolve));
    this.ws.send(JSON.stringify({ id, method, params })); const msg = await reply;
    if (msg.error) throw new Error(`${method}: ${msg.error.message}`); return msg.result;
  }
  close(): void { this.ws.close(); }
}

// Scheme+host+path only: sign-in and console URLs carry session parameters in the
// query string, and these values reach logs and status JSON.
function redactUrl(url: string): string {
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; }
  catch { return String(url).split("?")[0]?.split("#")[0]?.slice(0, 200) ?? "unknown"; }
}

/** Load the operator's surface table from the private overlay (empty without one). */
async function loadOverlaySurfaces(): Promise<Record<string, StewardshipSurface>> {
  const overlay = getPrivateOverlay();
  if (!overlay?.manifest.stewardshipSurfacesModule) return {};
  const mod = await importPrivateModule<{ SURFACES?: Record<string, StewardshipSurface> }>(overlay.manifest.stewardshipSurfacesModule);
  return mod.SURFACES ?? {};
}

export class SessionStewardship {
  private crons: Cron[] = []; private delayed = new Set<ReturnType<typeof setTimeout>>();
  private failures = new Map<string, number>(); private backoffUntil = new Map<string, number>();
  private surfacesPromise: Promise<Record<string, StewardshipSurface>> | undefined;
  private stopped = false;
  constructor(private readonly broker: BrowserLeaseBroker, private readonly status: BrowserStatusService,
    private readonly now = Date.now, private readonly random = Math.random,
    surfaces?: Record<string, StewardshipSurface>) {
    if (surfaces) this.surfacesPromise = Promise.resolve(surfaces);
  }
  private surfaces(): Promise<Record<string, StewardshipSurface>> {
    if (!this.surfacesPromise) {
      this.surfacesPromise = loadOverlaySurfaces().catch((error) => {
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, "Chrome session stewardship: surfaces unavailable");
        return {};
      });
    }
    return this.surfacesPromise;
  }
  start(): void {
    this.stopped = false;
    void this.surfaces().then((surfaces) => {
      if (this.stopped) return;
      const names = Object.keys(surfaces);
      if (names.length === 0) { logger.info("Chrome session stewardship: no surfaces configured (no private overlay)"); return; }
      for (const surface of names) {
        for (const hour of TOUCH_HOURS) {
          const cron = new Cron(`45 ${hour - 1} * * *`, { timezone: TIMEZONE }, () => {
            const timer = setTimeout(() => {
              this.delayed.delete(timer);
              const weekday = new Date().toLocaleString("en-US", { timeZone: TIMEZONE, weekday: "short" });
              void this.touch(surface, false, surfaces[surface]?.deepTouch?.(hour, weekday) === true);
            }, stewardshipJitterMs(this.random) + 15 * 60_000);
            this.delayed.add(timer);
          });
          this.crons.push(cron);
        }
      }
      logger.info({ surfaces: names }, "Chrome session stewardship scheduled");
    });
  }
  stop(): void { this.stopped = true; for (const cron of this.crons) cron.stop(); for (const timer of this.delayed) clearTimeout(timer); this.crons = []; this.delayed.clear(); }
  async touch(surface: string, manual = false, deep = false): Promise<Record<string, unknown>> {
    const cfg = (await this.surfaces())[surface];
    if (!cfg) return { surface, skipped: true, reason: "unknown surface" };
    const now = this.now(); const record = this.broker.snapshot().find((item) => item.surface === surface);
    let humanAt: number | null = null;
    // DEBT: __homerLastHumanActivity is page-local and its listeners install only after a successful
    // touch, so navigation or a fresh tab drops the marker and human use can go unseen until the next
    // touch re-installs it, upgrade to CDP-level (Input domain) activity observation when a scheduled
    // touch reloads a tab the operator was actively using.
    if (record && !record.leaseId) humanAt = await this.readHumanActivity(record).catch(() => null);
    const skip = stewardshipSkip(record, humanAt, now, this.backoffUntil.get(surface) ?? 0);
    if (skip) return { surface, skipped: true, reason: skip };
    let leaseId = ""; let cdp: Cdp | undefined;
    try {
      const lease = await this.broker.acquire(surface, `stewardship:${manual ? "manual" : "scheduled"}`, 90) as any; leaseId = lease.leaseId;
      cdp = await Cdp.open(lease.webSocketDebuggerUrl);
      const before = await this.urlAndHuman(cdp); if (/\/ap\/|signin/i.test(before.url)) throw new Error("refusing to touch sign-in page");
      if (before.humanAt && now - before.humanAt < HUMAN_QUIET_MS) return { surface, skipped: true, reason: "human activity in last 30 minutes" };
      await cdp.call("Network.enable"); const beforeCookies = await cdp.call("Network.getCookies", { urls: cfg.origins });
      await cdp.call("Page.reload", { ignoreCache: false });
      const deadline = Date.now() + (deep ? 20_000 : 12_000); let proof = false;
      while (Date.now() < deadline && !proof) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        proof = cdp.events.some((event) => cfg.proof(event));
      }
      const after = await this.urlAndHuman(cdp); const origin = new URL(after.url).origin;
      if (/\/ap\/|signin/i.test(after.url) || !cfg.origins.some((allowed) => allowed === origin) || !proof) throw new Error(`validation failed: url=${redactUrl(after.url)} proof=${proof}`);
      await cdp.call("Runtime.evaluate", { expression: `(()=>{if(!window.__homerHumanActivityInstalled){window.__homerHumanActivityInstalled=true;window.__homerLastHumanActivity=0;for(const e of ['pointerdown','keydown','touchstart'])addEventListener(e,()=>window.__homerLastHumanActivity=Date.now(),{capture:true,passive:true})}})()` });
      const afterCookies = await cdp.call("Network.getCookies", { urls: cfg.origins });
      const max = (x: any) => Math.max(0, ...(x.cookies ?? []).map((cookie: any) => Number(cookie.expires) || 0));
      const result = { surface, skipped: false, lastTouchAt: new Date(now).toISOString(), resultingUrl: redactUrl(after.url),
        validation: cfg.validation(deep),
        cookieExpiryMovementSeconds: max(afterCookies) - max(beforeCookies) };
      this.failures.set(surface, 0); this.backoffUntil.set(surface, 0);
      this.status.update(surface, { state: "authenticated", lastProbeAt: result.lastTouchAt, lastOkAt: result.lastTouchAt, lastTouchAt: result.lastTouchAt, reason: null });
      logger.info(result, "Chrome session stewardship touch succeeded"); return result;
    } catch (error) {
      const count = (this.failures.get(surface) ?? 0) + 1; this.failures.set(surface, count); this.backoffUntil.set(surface, now + stewardshipBackoffMs(count));
      const reason = error instanceof Error ? error.message : String(error); const at = new Date(now).toISOString();
      this.status.update(surface, { state: "unauthenticated", lastProbeAt: at, lastTouchAt: at, reason });
      logger.warn({ surface, reason, failures: count }, "Chrome session stewardship touch failed"); return { surface, skipped: false, ok: false, reason };
    } finally { cdp?.close(); if (leaseId) await this.broker.release(leaseId).catch(() => undefined); }
  }
  private async urlAndHuman(cdp: Cdp): Promise<{ url: string; humanAt: number | null }> {
    const result = await cdp.call("Runtime.evaluate", { expression: `({url:location.href,humanAt:Number(window.__homerLastHumanActivity)||null})`, returnByValue: true }); return result.result.value;
  }
  private async readHumanActivity(record: TargetRecord): Promise<number | null> { const lease = await this.broker.acquire(record.surface, "stewardship:precheck", 15) as any; let cdp: Cdp | undefined; try { cdp = await Cdp.open(lease.webSocketDebuggerUrl); return (await this.urlAndHuman(cdp)).humanAt; } finally { cdp?.close(); await this.broker.release(lease.leaseId); } }
  async ensureSurfaces(): Promise<void> { for (const [surface, cfg] of Object.entries(await this.surfaces())) await this.broker.reconcile(surface, [...cfg.origins], cfg.url); }
}
