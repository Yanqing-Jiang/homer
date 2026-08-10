import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { logger } from "../utils/logger.js";
export const BROWSER_CONTROL_STATE_DIR = "/Users/yj/Library/Application Support/Homer/cdp-state";
export const BROWSER_CONTROL_SOCKET = join(BROWSER_CONTROL_STATE_DIR, "browser-control.sock");
export const BROWSER_STATUS_PATH = join(BROWSER_CONTROL_STATE_DIR, "status.json");
interface CdpTarget { id: string; type: string; url: string; webSocketDebuggerUrl: string }
export interface TargetRecord {
  surface: string; generation: number; targetId: string; expectedOrigins: string[]; currentUrl: string;
  lastVerifiedUrl: string; owner: string | null; leaseId: string | null; leaseExpiresAt: number | null; lastActivityAt: number;
}
export interface BrowserTargetClient { list(): Promise<CdpTarget[]>; create(url: string): Promise<CdpTarget>; close(targetId: string): Promise<void> }
export class HttpBrowserTargetClient implements BrowserTargetClient {
  constructor(private readonly port = 9222) {}
  async list(): Promise<CdpTarget[]> {
    const response = await fetch(`http://127.0.0.1:${this.port}/json/list`);
    if (!response.ok) throw new Error(`CDP target list failed: HTTP ${response.status}`);
    return (await response.json() as CdpTarget[]).filter((target) => target.type === "page");
  }
  async create(url: string): Promise<CdpTarget> {
    const response = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    if (!response.ok) throw new Error(`CDP target create failed: HTTP ${response.status}`);
    return await response.json() as CdpTarget;
  }
  async close(targetId: string): Promise<void> { await fetch(`http://127.0.0.1:${this.port}/json/close/${encodeURIComponent(targetId)}`); }
}
function originOf(url: string): string { try { return new URL(url).origin; } catch { return ""; } }
export class BrowserLeaseBroker {
  private generation = 0;
  private records = new Map<string, TargetRecord>();
  private reconcileLock: Promise<unknown> = Promise.resolve();
  private surfaceLocks = new Map<string, Promise<unknown>>();
  private inFlightAcquires = 0;
  private inFlightReconciles = 0;
  private draining = false;
  constructor(private readonly targets: BrowserTargetClient, private readonly now = Date.now) {}
  beginGeneration(generation: number): void { this.generation = generation; this.records.clear(); this.draining = false; }
  async reconcile(surface: string, expectedOrigins: string[], bootstrapUrl: string): Promise<TargetRecord> {
    if (!surface || expectedOrigins.length === 0) throw new Error("surface and expectedOrigin are required");
    const allowed = [...new Set(expectedOrigins.map((origin) => new URL(origin).origin))];
    if (!allowed.includes(new URL(bootstrapUrl).origin)) throw new Error("bootstrapUrl origin is not allowed");
    const run = this.reconcileLock.then(async () => {
      if (this.draining) throw new Error("broker is draining leases");
      this.inFlightReconciles++;
      try {
        const existing = this.records.get(surface);
        const listed = await this.targets.list();
        const live = existing?.generation === this.generation
          ? listed.find((target) => target.id === existing.targetId) : undefined;
        if (existing && live && allowed.includes(originOf(live.url))) {
          existing.currentUrl = live.url;
          existing.lastVerifiedUrl = live.url;
          existing.expectedOrigins = allowed;
          existing.lastActivityAt = this.now();
          return { ...existing };
        }
        if (live) await this.targets.close(live.id);
        const created = await this.targets.create(bootstrapUrl);
        if (!created.id || !created.webSocketDebuggerUrl) throw new Error("CDP returned an invalid page target");
        const record: TargetRecord = {
          surface, generation: this.generation, targetId: created.id, expectedOrigins: allowed,
          currentUrl: created.url, lastVerifiedUrl: created.url, owner: null, leaseId: null,
          leaseExpiresAt: null, lastActivityAt: this.now(),
        };
        this.records.set(surface, record);
        return { ...record };
      } finally {
        this.inFlightReconciles--;
      }
    });
    this.reconcileLock = run.then(() => undefined, () => undefined);
    return run;
  }
  async acquire(surface: string, owner: string, ttl: number): Promise<Record<string, unknown>> {
    return this.withSurfaceLock(surface, async () => {
      this.expireLeases();
      if (this.draining) throw new Error("broker is draining leases");
      if (surface === "human.general" && !owner.startsWith("human:")) throw new Error("automation cannot acquire human.general");
      const record = this.records.get(surface);
      if (!record || record.generation !== this.generation) throw new Error(`surface ${surface} is not reconciled`);
      if (record.leaseId) throw new Error(`surface ${surface} is leased by ${record.owner}`);
      this.inFlightAcquires++;
      try {
        const live = (await this.targets.list()).find((target) => target.id === record.targetId);
        if (!live || !record.expectedOrigins.includes(originOf(live.url))) throw new Error(`registered target for ${surface} is unavailable`);
        const leaseId = randomUUID();
        record.owner = owner;
        record.leaseId = leaseId;
        record.leaseExpiresAt = this.expiry(ttl);
        record.currentUrl = live.url;
        record.lastVerifiedUrl = live.url;
        record.lastActivityAt = this.now();
        return { leaseId, generation: this.generation, targetId: live.id,
          webSocketDebuggerUrl: live.webSocketDebuggerUrl, currentUrl: live.url };
      } finally { this.inFlightAcquires--; }
    });
  }
  renew(leaseId: string, ttl: number): Record<string, unknown> {
    this.expireLeases(); const record = this.byLease(leaseId);
    record.leaseExpiresAt = this.expiry(ttl); record.lastActivityAt = this.now();
    return { leaseId, generation: this.generation, expiresAt: record.leaseExpiresAt };
  }
  release(leaseId: string): Record<string, unknown> {
    const record = this.byLease(leaseId); this.clearLease(record);
    return { leaseId, released: true };
  }
  async drainLeases(timeoutMs = 10_000): Promise<void> {
    this.draining = true;
    const deadline = this.now() + timeoutMs;
    while ((this.activeLeaseCount() > 0 || this.inFlightAcquires > 0 || this.inFlightReconciles > 0) && this.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this.activeLeaseCount() > 0) {
      logger.warn({ leases: this.activeLeaseCount(), timeoutMs }, "Browser lease drain deadline reached");
      for (const record of this.records.values()) this.clearLease(record);
    }
  }
  resume(): void { this.draining = false; }
  private async withSurfaceLock<T>(surface: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.surfaceLocks.get(surface) ?? Promise.resolve();
    const run = prior.then(operation, operation);
    const tail = run.then(() => undefined, () => undefined);
    this.surfaceLocks.set(surface, tail);
    try { return await run; } finally {
      if (this.surfaceLocks.get(surface) === tail) this.surfaceLocks.delete(surface);
    }
  }
  private expiry(ttl: number): number {
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 86_400) throw new Error("ttl must be > 0 and <= 86400 seconds"); return this.now() + ttl * 1_000;
  }
  private byLease(leaseId: string): TargetRecord {
    const record = [...this.records.values()].find((candidate) => candidate.leaseId === leaseId);
    if (!record) throw new Error("unknown or expired lease");
    return record;
  }
  private activeLeaseCount(): number { this.expireLeases(); return [...this.records.values()].filter((r) => r.leaseId).length; }
  private expireLeases(): void {
    const now = this.now();
    for (const record of this.records.values()) if (record.leaseExpiresAt !== null && record.leaseExpiresAt <= now) this.clearLease(record);
  }
  private clearLease(record: TargetRecord): void {
    record.owner = null; record.leaseId = null; record.leaseExpiresAt = null; record.lastActivityAt = this.now();
  }
}
type ControlRequest = { verb: string; surface?: string; owner?: string; ttl?: number; leaseId?: string; expectedOrigin?: string[]; bootstrapUrl?: string; enabled?: boolean; reason?: string };
export function startBrowserControlServer(broker: BrowserLeaseBroker, maintenance: (enabled: boolean, reason: string) => Promise<void>, socketPath = BROWSER_CONTROL_SOCKET): Server {
  const stateDir = dirname(socketPath);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  if (existsSync(socketPath)) unlinkSync(socketPath);
  const server = createServer((socket) => {
    let input = "";
    let responding = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      if (!responding && input.includes("\n")) { responding = true; void respond(); }
    });
    const respond = async () => {
      socket.pause();
      try {
        const request = JSON.parse(input.slice(0, input.indexOf("\n"))) as ControlRequest;
        let result: unknown;
        if (request.verb === "reconcile") result = await broker.reconcile(request.surface!, request.expectedOrigin!, request.bootstrapUrl!);
        else if (request.verb === "acquire") result = await broker.acquire(request.surface!, request.owner!, request.ttl!);
        else if (request.verb === "renew") result = broker.renew(request.leaseId!, request.ttl!);
        else if (request.verb === "release") result = broker.release(request.leaseId!);
        else if (request.verb === "maintenance") {
          await maintenance(Boolean(request.enabled), request.reason ?? "browserctl");
          if (!request.enabled) broker.resume();
          result = { enabled: Boolean(request.enabled), reason: request.enabled ? request.reason ?? "browserctl" : null };
        } else throw new Error(`unknown verb: ${request.verb}`);
        socket.end(`${JSON.stringify({ ok: true, result })}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
      }
    };
  });
  server.listen(socketPath, () => {
    chmodSync(socketPath, 0o600);
    logger.info({ socketPath }, "Browser control socket listening");
  });
  return server;
}
export async function stopBrowserControlServer(server: Server, socketPath = BROWSER_CONTROL_SOCKET): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve())); if (existsSync(socketPath)) unlinkSync(socketPath);
}
