import { Cron } from "croner";
import { logger } from "../utils/logger.js";
import { BrowserLeaseBroker, type TargetRecord } from "./browser-control.js";
import { BrowserStatusService } from "./browser-status.js";

const SURFACES = {
  "amazon.vc": { origins: ["https://vendorcentral.amazon.com", "https://ara.amazon.com"], url: "https://vendorcentral.amazon.com/opportunity-explorer/explore" },
  "amazon.amc": { origins: ["https://advertising.amazon.com"], url: "https://advertising.amazon.com/marketing-cloud" },
} as const;
const HUMAN_QUIET_MS = 30 * 60 * 1000;
// DEBT: six-hour keepalive effectiveness is inferred and absolute Amazon expiry remains unavoidable, upgrade when two expiries occur despite successful touches or cookie expiry fails to advance over a 14-day observation window.
// DEBT: AMC from-scratch recovery remains alert-only until cleanroom relogin passes one real expired-session drill, upgrade when the next natural AMC expiry occurs in the 07:00–22:00 window.

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

export class SessionStewardship {
  private crons: Cron[] = []; private delayed = new Set<ReturnType<typeof setTimeout>>();
  private failures = new Map<string, number>(); private backoffUntil = new Map<string, number>();
  constructor(private readonly broker: BrowserLeaseBroker, private readonly status: BrowserStatusService,
    private readonly now = Date.now, private readonly random = Math.random) {}
  start(): void {
    for (const surface of Object.keys(SURFACES) as Array<keyof typeof SURFACES>) {
      for (const hour of [8, 14, 20]) {
        const cron = new Cron(`45 ${hour - 1} * * *`, { timezone: "America/Los_Angeles" }, () => {
          const timer = setTimeout(() => { this.delayed.delete(timer); void this.touch(surface, false, surface === "amazon.amc" && hour === 20 && new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short" }) === "Sun"); }, stewardshipJitterMs(this.random) + 15 * 60_000);
          this.delayed.add(timer);
        });
        this.crons.push(cron);
      }
    }
  }
  stop(): void { for (const cron of this.crons) cron.stop(); for (const timer of this.delayed) clearTimeout(timer); this.crons = []; this.delayed.clear(); }
  async touch(surface: keyof typeof SURFACES, manual = false, deep = false): Promise<Record<string, unknown>> {
    const cfg = SURFACES[surface]; const now = this.now(); const record = this.broker.snapshot().find((item) => item.surface === surface);
    let humanAt: number | null = null;
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
        proof = cdp.events.some((event) => surface === "amazon.vc"
          ? event.method === "Network.requestWillBeSent" && String(event.params?.request?.postData ?? "").includes("GetUserContext")
          : event.method === "Network.requestWillBeSent" && String(event.params?.request?.url ?? "").includes("a9g-api-gateway/amc") && Object.keys(event.params?.request?.headers ?? {}).some((key) => key.toLowerCase() === "amazon-advertising-api-csrf-token"));
      }
      const after = await this.urlAndHuman(cdp); const origin = new URL(after.url).origin;
      if (/\/ap\/|signin/i.test(after.url) || !cfg.origins.some((allowed) => allowed === origin) || !proof) throw new Error(`validation failed: url=${after.url} proof=${proof}`);
      await cdp.call("Runtime.evaluate", { expression: `(()=>{if(!window.__homerHumanActivityInstalled){window.__homerHumanActivityInstalled=true;window.__homerLastHumanActivity=0;for(const e of ['pointerdown','keydown','touchstart'])addEventListener(e,()=>window.__homerLastHumanActivity=Date.now(),{capture:true,passive:true})}})()` });
      const afterCookies = await cdp.call("Network.getCookies", { urls: cfg.origins });
      const max = (x: any) => Math.max(0, ...(x.cookies ?? []).map((cookie: any) => Number(cookie.expires) || 0));
      const result = { surface, skipped: false, lastTouchAt: new Date(now).toISOString(), resultingUrl: after.url,
        validation: surface === "amazon.vc" ? "non-/ap + observed GetUserContext" : `observed a9g/CSRF${deep ? " (Sunday deep)" : ""}`,
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
  async ensureSurfaces(): Promise<void> { for (const [surface, cfg] of Object.entries(SURFACES)) await this.broker.reconcile(surface, [...cfg.origins], cfg.url); }
}
