import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { logger } from "../utils/logger.js";
export const BROWSER_CONTROL_STATE_DIR = "/Users/yj/Library/Application Support/Homer/cdp-state";
export const BROWSER_CONTROL_SOCKET = join(BROWSER_CONTROL_STATE_DIR, "browser-control.sock");
export const BROWSER_STATUS_PATH = join(BROWSER_CONTROL_STATE_DIR, "status.json");
/** A killed lease wrapper is not gone while its persisted driver groups survive. */
export function browserDriverAlive(owner: string | null | undefined, socketPath = BROWSER_CONTROL_SOCKET): boolean {
  const match = owner?.match(/^browserctl-agent:(\d+)(?::|$)/);
  if (!match) return false;
  const file = `${socketPath}.drivers.${match[1]}.json`;
  try {
    const groups: number[] = JSON.parse(readFileSync(file, "utf8"));
    return groups.some(pid => {
      if (!Number.isInteger(pid) || pid <= 0) return true;
      try { process.kill(-pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    });
  } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}
interface CdpTarget { id: string; type: string; url: string; webSocketDebuggerUrl: string }
export interface TargetRecord {
  surface: string; generation: number; targetId: string; expectedOrigins: string[]; currentUrl: string;
  lastVerifiedUrl: string; owner: string | null; leaseId: string | null; leaseExpiresAt: number | null; lastActivityAt: number;
  /**
   * The process actually driving this tab, when it differs from `owner`.
   *
   * A GRANTED reservation deliberately keeps the long-lived holder as `owner` (otherwise
   * `ownerIsDead` reclaims the whole grant the moment a short-lived agent exits). That left the
   * record with no adopter identity at all, so a `browserctl agent` killed without running its
   * release `finally` left an unreclaimable record: the holder is alive, the holder's renew keeps
   * `leaseExpiresAt` in the future, and every later adopt in the same run was refused. Recording
   * the adopter separately gives `expireLeases` something it can check.
   */
  adopterOwner?: string | null;
}
export interface RestoreExternalHolderResult {
  reservation: boolean;
  records: number;
  liveOwners: string[];
  /**
   * "restored"     — something live was re-registered; the browser is accounted for.
   * "holders-gone" — every holder in the handoff has a dead pid; the browser is genuinely free.
   * "unknown"      — a live holder we could not re-register, or the target list failed. The
   *                  caller MUST fence: this is not evidence that the browser is free.
   */
  outcome: "restored" | "holders-gone" | "unknown";
  listFailed: boolean;
  unresolvedLiveHolders: number;
}

/** A reservation held over the broker's target-creation path. `granted` ones outlive an adopter. */
export interface ExternalReservation {
  surface: string; owner: string; leaseId: string; expiresAt: number; granted: boolean;
  /** The `browserctl-agent:<pid>` that most recently adopted this grant, if any. */
  adopterOwner?: string | null;
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
  private degradedReason: string | null = null;
  /**
   * `granted: true` means a long-lived reservation held by a Homer job (ABVP) that hands it
   * to short-lived agent processes. A granted reservation SURVIVES register-external-target
   * and survives the adopter's release, so the job keeps admission across an agent restart
   * (MFA recovery releases and reacquires) and across a later phase of the same run. It is
   * cleared only by release-grant, or by expiry.
   */
  private externalReservation: ExternalReservation | null = null;
  /** See setAdoptionGrace — set only after adopting a Chrome whose holder we cannot see. */
  private adoptionGrace: { until: number; reason: string } | null = null;
  /** Tabs abandoned by a reclaimed adopter, closed by a serialized sweep — see queueTargetClose. */
  private pendingCloses: Array<{ targetId: string; surface: string }> = [];
  private closeSweep: Promise<void> = Promise.resolve();
  private observedTargetIds: Set<string> | null = null;
  /**
   * Surface -> targetId from the generation just ended. `beginGeneration` clears `records`,
   * and reconcile then created a FRESH tab for every surface: each supervisor relaunch or
   * adoption bump leaked one AMC and one OX tab for the life of the browser (12 tabs by
   * 2026-09-01). Remembering the previous tab lets reconcile re-adopt it instead.
   */
  private previousTargets = new Map<string, string>();
  private transition: () => void = () => {};
  constructor(private readonly targets: BrowserTargetClient, private readonly now = Date.now, private readonly fenceLiveAgentExpiry = false) {}
  hasLease(id: string): boolean {
    return this.externalReservation?.leaseId === id || [...this.records.values()].some(record => record.leaseId === id);
  }
  beginGeneration(generation: number): void {
    for (const record of this.records.values()) this.previousTargets.set(record.surface, record.targetId);
    this.generation = generation; this.records.clear(); this.draining = false;
    this.externalReservation = null; this.observedTargetIds = null; this.adoptionGrace = null;
    this.transition();
  }
  setTransitionHandler(handler: () => void): void { this.transition = handler; }
  snapshot(): TargetRecord[] { this.expireLeases(); return [...this.records.values()].map((record) => ({ ...record })); }
  /**
   * The reason is often the message of an error thrown by reserveExternal's own degraded gate,
   * which already carries the `agent-browser automation degraded: ` prefix; storing that verbatim
   * nested the prefix once per 60 s retry (hundreds deep by 2026-09-01). Strip it.
   */
  setDegraded(reason: string | null): void {
    this.degradedReason = reason === null ? null : reason.replace(/^(agent-browser automation degraded: )+/, "");
  }
  degraded(): string | null { return this.degradedReason; }
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
        const target = await this.adoptOrCreateSurfaceTarget(surface, listed, allowed, bootstrapUrl, live?.id);
        const record: TargetRecord = {
          surface, generation: this.generation, targetId: target.id, expectedOrigins: allowed,
          currentUrl: target.url, lastVerifiedUrl: target.url, owner: null, leaseId: null,
          leaseExpiresAt: null, lastActivityAt: this.now(),
        };
        this.records.set(surface, record);
        this.transition();
        return { ...record };
      } finally {
        this.inFlightReconciles--;
      }
    });
    this.reconcileLock = run.then(() => undefined, () => undefined);
    return run;
  }
  /**
   * Prefer an existing tab over a new one. Candidates are live pages on an allowed origin that no
   * record of this generation holds (external agent tabs are re-registered by the adoption path,
   * so they are excluded). The previous generation's own tab wins; otherwise a page already
   * sitting at the bootstrap URL. Only when neither exists is a tab created.
   *
   * Leftover candidates are duplicates of this surface — orphans of earlier generations or of
   * login flows — and are closed, but ONLY while nothing external can be driving an unregistered
   * tab: no adoption grace (a holder we could not see) and no external reservation. Closing a tab
   * never touches the profile's cookies or cache.
   */
  private async adoptOrCreateSurfaceTarget(surface: string, listed: CdpTarget[], allowed: string[], bootstrapUrl: string, excludeId?: string): Promise<CdpTarget> {
    const held = new Set([...this.records.values()].filter((record) => record.surface !== surface).map((record) => record.targetId));
    const candidates = listed.filter((target) => target.id !== excludeId && !held.has(target.id) && allowed.includes(originOf(target.url)));
    const previousId = this.previousTargets.get(surface);
    const adopted = candidates.find((target) => target.id === previousId) ?? candidates.find((target) => target.url.startsWith(bootstrapUrl));
    if (!adopted) {
      const created = await this.targets.create(bootstrapUrl);
      if (!created.id || !created.webSocketDebuggerUrl) throw new Error("CDP returned an invalid page target");
      return created;
    }
    logger.info({ surface, targetId: adopted.id, viaPrevious: adopted.id === previousId, url: adopted.url }, "Re-adopted existing surface tab");
    const sweepable = this.adoptionGraceUntil() === null && this.externalReservation === null;
    for (const extra of candidates) {
      if (extra.id === adopted.id) continue;
      if (!sweepable) { logger.warn({ surface, targetId: extra.id, url: extra.url }, "Duplicate surface tab left open: browser may have an external holder"); continue; }
      try { await this.targets.close(extra.id); logger.info({ surface, targetId: extra.id, url: extra.url }, "Closed orphaned duplicate surface tab"); }
      catch (err) { logger.warn({ surface, targetId: extra.id, err: err instanceof Error ? err.message : String(err) }, "Failed to close duplicate surface tab"); }
    }
    return adopted;
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
        this.transition();
        return { leaseId, generation: this.generation, targetId: live.id,
          webSocketDebuggerUrl: live.webSocketDebuggerUrl, currentUrl: live.url };
      } finally { this.inFlightAcquires--; }
    });
  }
  /** Test seam: create a target through the same TargetSource the broker was built with. */
  async __targetsForTest_create(url: string): Promise<{ id: string; url: string }> {
    return this.targets.create(url) as Promise<{ id: string; url: string }>;
  }
  async reserveExternal(surface: string, owner: string, ttl: number, granted = false, options: { bypassDegraded?: boolean } = {}): Promise<Record<string, unknown>> {
    return this.withSurfaceLock("__external_admission", () => this.reserveExternalLocked(surface, owner, ttl, granted, options));
  }
  private async reserveExternalLocked(surface: string, owner: string, ttl: number, granted: boolean, options: { bypassDegraded?: boolean }): Promise<Record<string, unknown>> {
    this.expireLeases();
    // The startup self-test is the ONLY thing that clears a degradation, so it must not be refused
    // by it — otherwise one failed test (a dead agent pid holding a lease, 2026-09-01) locked the
    // broker degraded for good.
    if (this.degradedReason && !options.bypassDegraded) throw new Error(`agent-browser automation degraded: ${this.degradedReason}`);
    if (this.draining) throw new Error("broker is draining leases");
    const graceUntil = this.adoptionGraceUntil();
    if (graceUntil !== null) {
      throw new Error(`agent target creation is reserved by the adopted browser's previous holder until ${new Date(graceUntil).toISOString()} (adoption grace)`);
    }
    if (!surface.startsWith("agent.")) throw new Error("external agent surfaces must start with agent.");
    if (this.externalReservation) throw new Error(`agent target creation is reserved by ${this.externalReservation.owner}`);
    // DEBT: agent-browser sessions are globally serialized due to 0.21.4 concurrent rebinding, upgrade when agent-browser exposes target-id attach.
    const activeAgent = [...this.records.values()].find((record) => record.surface.startsWith("agent.") && record.leaseId);
    if (activeAgent) throw new Error(`agent-browser session is globally serialized; active owner ${activeAgent.owner}`);
    // Take the baseline BEFORE publishing the reservation. Published first, a targets.list()
    // failure returned no leaseId to the caller while the broker kept the reservation — the
    // caller could not release what it never received, and its own retry then saw its own
    // orphaned reservation as contention for a full TTL.
    const baselineTargetIds = (await this.targets.list()).map((target) => target.id);
    const leaseId = randomUUID();
    const expiresAt = this.expiry(ttl);
    this.externalReservation = { surface, owner, leaseId, expiresAt, granted };
    this.transition();
    return { leaseId, generation: this.generation, baselineTargetIds };
  }
  /**
   * Hand an existing external reservation to the process that will actually drive it.
   *
   * `waitForBrowserBrokerIdle` was a status snapshot, not admission: between observing an
   * idle broker and the agent's own `reserve-external` there was a window in which anything
   * else could take the browser, and the expensive agent stage was spent anyway. The holder
   * (ABVP) reserves FIRST with `granted`, then launches agents that adopt the leaseId.
   *
   * RE-ENTRANT by design. A granted reservation may be adopted any number of times while it
   * lives, because the ABVP download agent's own MFA-recovery flow releases the agent lease
   * and reacquires it, and the portal phase that follows opens a second agent session. A
   * single-use adoption dead-ended both.
   *
   * Surface-bound: only an agent on the reserved surface may adopt, so an unrelated job that
   * happens to inherit HOMER_BROWSER_GRANT in its environment cannot steal the reservation.
   */
  adoptExternal(leaseId: string, owner: string, surface?: string): Record<string, unknown> {
    this.expireLeases();
    const reservation = this.externalReservation;
    if (!reservation || reservation.leaseId !== leaseId) {
      throw new Error("unknown or expired external reservation");
    }
    if (surface && surface !== reservation.surface) {
      throw new Error(`grant is bound to surface ${reservation.surface}, not ${surface}`);
    }
    // Re-entrant means SEQUENTIAL re-adoption (release -> login recovery -> reacquire), not
    // concurrent adoption. Records are keyed by surface, so a second live adopter of the same
    // grant would overwrite the first's record and the first's release would then close the
    // SECOND agent's tab. Excluding any live agent record — including one holding this very
    // lease — keeps the broker's global agent-browser serialization intact.
    const activeAgent = [...this.records.values()].find(
      (record) => record.surface.startsWith("agent.") && record.leaseId,
    );
    if (activeAgent) {
      throw new Error(
        activeAgent.leaseId === leaseId
          ? `grant ${leaseId} already has a live adopter (${activeAgent.owner}); adoption is sequential, not concurrent`
          : `agent-browser session is globally serialized; active owner ${activeAgent.owner}`,
      );
    }
    // A granted reservation keeps the HOLDER as its owner. Re-owning it to the adopter's
    // `browserctl-agent:<pid>` would make ownerIsDead reclaim the whole grant the moment the
    // short-lived agent process exits — silently ending the holder's admission mid-run.
    if (!reservation.granted) reservation.owner = owner;
    // Always remember WHO is driving, even when the grant keeps the holder as its owner. This is
    // the identity expireLeases needs to reclaim a tab whose agent died without releasing.
    reservation.adopterOwner = owner;
    this.transition();
    return { leaseId, generation: this.generation, surface: reservation.surface, granted: reservation.granted };
  }

  /** Drop a granted reservation. Only the holder calls this; an adopter's release does not. */
  async releaseGrant(leaseId: string): Promise<Record<string, unknown>> {
    const reservation = this.externalReservation;
    if (reservation?.leaseId === leaseId) this.externalReservation = null;
    const record = [...this.records.values()].find((candidate) => candidate.leaseId === leaseId);
    if (record) this.clearLease(record);
    this.transition();
    return { leaseId, released: true };
  }

  async registerExternalTarget(leaseId: string, targetId: string): Promise<Record<string, unknown>> {
    const reservation = this.externalReservation;
    if (!reservation || reservation.leaseId !== leaseId) throw new Error("unknown or expired external reservation");
    const live = (await this.targets.list()).find((target) => target.id === targetId);
    if (!live) throw new Error("external target is unavailable");
    const record: TargetRecord = {
      surface: reservation.surface, generation: this.generation, targetId: live.id,
      expectedOrigins: [originOf(live.url)], currentUrl: live.url, lastVerifiedUrl: live.url,
      owner: reservation.owner, leaseId, leaseExpiresAt: reservation.expiresAt, lastActivityAt: this.now(),
      adopterOwner: reservation.granted ? reservation.adopterOwner ?? null : null,
    };
    this.records.set(record.surface, record);
    // A granted reservation is the holder's admission token and outlives this target.
    if (!reservation.granted) this.externalReservation = null;
    this.transition();
    return { leaseId, generation: this.generation, targetId: live.id, currentUrl: live.url };
  }
  renew(leaseId: string, ttl: number): Record<string, unknown> {
    this.expireLeases();
    if (this.externalReservation?.leaseId === leaseId) {
      this.externalReservation.expiresAt = this.expiry(ttl);
      // A granted reservation and its registered target share a leaseId; renew both, or the
      // record expires under a live holder and the browser is taken mid-run.
      const bound = [...this.records.values()].find((candidate) => candidate.leaseId === leaseId);
      if (bound) { bound.leaseExpiresAt = this.expiry(ttl); bound.lastActivityAt = this.now(); }
      return { leaseId, generation: this.generation, expiresAt: this.externalReservation.expiresAt };
    }
    const record = this.byLease(leaseId);
    record.leaseExpiresAt = this.expiry(ttl); record.lastActivityAt = this.now();
    this.transition();
    return { leaseId, generation: this.generation, expiresAt: record.leaseExpiresAt };
  }
  async release(leaseId: string, closeTarget = false, externalTargetId?: string): Promise<Record<string, unknown>> {
    // A registered target takes precedence over a reservation sharing its leaseId: an
    // adopter releasing its tab must close that tab and drop the record WITHOUT destroying
    // the holder's grant, or the holder loses admission halfway through its run.
    const bound = [...this.records.values()].find((candidate) => candidate.leaseId === leaseId);
    if (bound && this.externalReservation?.leaseId === leaseId && this.externalReservation.granted) {
      if (closeTarget) { await this.targets.close(bound.targetId); this.records.delete(bound.surface); }
      else this.clearLease(bound);
      // The adopter is gone; the grant is not. Forgetting the adopter keeps a stale, already-dead
      // pid from being the thing a later reclaim decision is made on.
      this.externalReservation.adopterOwner = null;
      this.transition();
      return { leaseId, released: true, grantRetained: true };
    }
    if (this.externalReservation?.leaseId === leaseId) {
      if (closeTarget && externalTargetId) await this.targets.close(externalTargetId);
      this.externalReservation = null;
      this.transition();
      return { leaseId, released: true };
    }
    const record = this.byLease(leaseId);
    if (closeTarget) {
      await this.targets.close(record.targetId);
      this.records.delete(record.surface);
    } else this.clearLease(record);
    this.transition();
    return { leaseId, released: true };
  }
  async observeTargets(): Promise<void> {
    const live = new Set((await this.targets.list()).map((target) => target.id));
    if (this.observedTargetIds === null) { this.observedTargetIds = live; return; }
    const registered = new Set([...this.records.values()].map((record) => record.targetId));
    for (const targetId of live) {
      if (!this.observedTargetIds.has(targetId) && !registered.has(targetId)) {
        logger.warn({ targetId }, "Unregistered browser target mutation observed");
      }
    }
    this.observedTargetIds = live;
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
  /**
   * Live EXTERNAL holders only — an agent-browser reservation, or a lease on an `agent.*`
   * surface / held by a `browserctl-agent:` owner. Homer's own short stewardship leases
   * (`stewardship:scheduled` 90s, `stewardship:precheck` 15s on amazon.*) are deliberately
   * excluded: counting them made the exit reaper leave Chrome for adoption whenever a crash
   * happened to land inside a touch, and made the degraded-browser retry skip for the same
   * reason. Read by the daemon's Chrome exit paths and the degraded retry guard.
   */
  externalLeaseCount(): number {
    this.expireLeases();
    const records = [...this.records.values()].filter((record) =>
      record.leaseId !== null
      && (record.surface.startsWith("agent.") || (record.owner ?? "").startsWith("browserctl-agent:")));
    return records.length + (this.externalReservation ? 1 : 0);
  }
  /**
   * Everything an EXTERNAL holder needs to survive a daemon generation.
   *
   * Round-2 review N2: persisting only `externalReservation` was inert for the holder that
   * actually exists in production. `registerExternalTarget` CLEARS the reservation for a
   * non-granted `browserctl agent` holder the moment it registers its tab, so from then on
   * the holder exists only as a lease RECORD (`agent.vc-query-detail`, owner
   * `browserctl-agent:<pid>`) — which `externalLeaseCount()` counts but the old snapshot
   * did not. Both halves are captured here.
   */
  externalHolderSnapshot(): { reservation: ExternalReservation | null; records: TargetRecord[] } | null {
    this.expireLeases();
    const records = [...this.records.values()]
      .filter((record) => record.leaseId !== null
        && (record.surface.startsWith("agent.") || (record.owner ?? "").startsWith("browserctl-agent:")))
      .map((record) => ({ ...record }));
    const reservation = this.externalReservation ? { ...this.externalReservation } : null;
    if (!reservation && records.length === 0) return null;
    return { reservation, records };
  }

  /**
   * Re-register a previous generation's EXTERNAL holder after this generation adopted its
   * Chrome.
   *
   * Round-2 review N3: the old check refused whenever `ownerIsDead(reservation.owner)`, and
   * an ABVP grant's owner is `abvp-refresh:<DAEMON pid>:<run_id>` — dead by definition across
   * a restart — so every handoff ever written was refused. The entity that actually survives
   * a daemon restart and keeps driving Chrome is the `browserctl-agent:<pid>` adopter, whose
   * process tree roots outside the daemon (2026-09-01: pid 27408 under `backfill_worker.sh`
   * pid 6104, ppid 1). So a holder is honoured when EITHER identity still has a live pid, and
   * the restored entry is re-owned to that live identity — otherwise `expireLeases` would
   * drop it again on the very next call.
   *
   * Only restores a record whose target is still open, so a tab that died with the old
   * generation cannot resurrect as a phantom lease.
   */
  async restoreExternalHolder(
    snapshot: { reservation: ExternalReservation | null; records: TargetRecord[] },
  ): Promise<RestoreExternalHolderResult> {
    this.expireLeases();
    const liveOwners: string[] = [];
    let restoredReservation = false;
    let restoredRecords = 0;
    /**
     * F1: entries we could NOT restore even though their process is demonstrably alive —
     * an expired lease under a live agent (a swallowed `browserctl renew` failure), a tab
     * that happened to be closed at this instant, or a surface already occupied. "Restored
     * nothing" must never be reported as "nothing is holding this browser".
     */
    let unresolvedLiveHolders = 0;
    let listFailed = false;

    if (snapshot.reservation) {
      const r = snapshot.reservation;
      const live = this.liveIdentity(r.owner, r.adopterOwner ?? null);
      if (live) {
        if (!this.externalReservation && r.surface.startsWith("agent.") && (r.expiresAt > this.now() || this.fenceLiveAgentExpiry)) {
          this.externalReservation = { ...r, owner: live };
          restoredReservation = true;
          liveOwners.push(live);
        } else {
          unresolvedLiveHolders++;
        }
      }
    }

    if (snapshot.records.length > 0) {
      let listed: CdpTarget[] = [];
      try {
        listed = await this.targets.list();
      } catch (err) {
        // F1: this used to be swallowed silently, and an empty target list then made every
        // record look gone. `onAdopt` runs milliseconds after a ProcessSingleton forward,
        // which is exactly when /json/list is most likely to fail.
        listFailed = true;
        logger.warn({ err }, "CDP target list failed while restoring an external holder — treating the browser as possibly held");
      }
      const liveTargetIds = new Set(listed.map((target) => target.id));
      for (const record of snapshot.records) {
        const live = this.liveIdentity(record.owner, record.adopterOwner ?? null);
        if (!live) continue; // the holder really is gone
        if (listFailed) { unresolvedLiveHolders++; continue; }
        if (this.records.has(record.surface)
          || !record.leaseId
          || (!this.fenceLiveAgentExpiry && record.leaseExpiresAt !== null && record.leaseExpiresAt <= this.now())
          || !liveTargetIds.has(record.targetId)) {
          unresolvedLiveHolders++;
          continue;
        }
        this.records.set(record.surface, { ...record, owner: live, generation: this.generation });
        restoredRecords++;
        liveOwners.push(live);
      }
    }

    if (restoredReservation || restoredRecords > 0) this.transition();
    const outcome: RestoreExternalHolderResult["outcome"] = restoredReservation || restoredRecords > 0
      ? "restored"
      : (listFailed || unresolvedLiveHolders > 0) ? "unknown" : "holders-gone";
    return { reservation: restoredReservation, records: restoredRecords, liveOwners, outcome, listFailed, unresolvedLiveHolders };
  }

  /**
   * The first of these owners whose pid is demonstrably alive, else null.
   *
   * DEBT (F8): shares `ownerIsDead`'s pid-reuse hazard, but in the UNSAFE direction — this
   * one RESURRECTS state across a process boundary, so a recycled pid restores a dead
   * holder's record with up to its full remaining TTL (3 h for QC), blocking every `agent.*`
   * surface and burning ABVP deferrals for a holder that no longer exists. macOS allocates
   * pids sequentially and the restart window is seconds, so the probability is very low.
   * Upgrade together with G11, by capturing the process start time at acquire/adopt and
   * persisting it in the handoff alongside the pid.
   *
   * F9: the pid floor matches `ownerIsDead` (`<= 0`), and EPERM counts as alive in both, so
   * the two never disagree about the same owner string.
   */
  private liveIdentity(...owners: Array<string | null | undefined>): string | null {
    for (const owner of owners) {
      if (!owner) continue;
      const match = /^[^:]+:(\d+)(?::|$)/.exec(owner);
      if (!match) continue; // no pid to check — not evidence of a live external process
      const pid = Number(match[1]);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try { process.kill(pid, 0); return owner; } catch (err) {
        if (browserDriverAlive(owner) || (err as NodeJS.ErrnoException).code !== "ESRCH") return owner; // EPERM: alive, not ours
      }
    }
    return null;
  }

  /**
   * Refuse new agent reservations until `until`. Set when this daemon adopts a Chrome it
   * did not launch and could NOT reconstruct the previous holder's reservation: an
   * external driver may still be attached to a tab, and agent-browser 0.21.4 cannot
   * survive a concurrent rebind. The message deliberately reads as contention ("reserved
   * by") so callers that classify contention vs sickness defer instead of alerting.
   */
  setAdoptionGrace(until: number, reason: string): void {
    this.adoptionGrace = until > this.now() ? { until, reason } : null;
    this.transition();
  }
  /** Read-only view of the external reservation for status publication (F12). */
  externalReservationSummary(): { surface: string; owner: string; expiresAt: number; granted: boolean } | null {
    this.expireLeases();
    if (!this.externalReservation) return null;
    const { surface, owner, expiresAt, granted } = this.externalReservation;
    return { surface, owner, expiresAt, granted };
  }
  adoptionGraceUntil(): number | null {
    if (this.adoptionGrace && this.adoptionGrace.until <= this.now()) this.adoptionGrace = null;
    return this.adoptionGrace?.until ?? null;
  }
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
  private activeLeaseCount(): number {
    this.expireLeases();
    return [...this.records.values()].filter((r) => r.leaseId).length + (this.externalReservation ? 1 : 0);
  }
  private expireLeases(): void {
    const now = this.now();
    if (this.externalReservation && (this.ownerIsDead(this.externalReservation.owner) || (this.externalReservation.expiresAt <= now && !this.fenceLiveAgentExpiry))) this.externalReservation = null;
    /** agent.* surfaces reclaimed from a dead driver — their tab is deleted after the loop. */
    const abandoned: TargetRecord[] = [];
    for (const record of this.records.values()) {
      if (record.leaseExpiresAt !== null && record.leaseExpiresAt <= now
        && !(this.fenceLiveAgentExpiry && record.surface.startsWith("agent.") && !this.ownerIsDead(record.adopterOwner ?? record.owner))) {
        // A plain TTL expiry is routine and the tab must SURVIVE: a long-lived surface record
        // (amazon.vc / amazon.amc) is re-leased against the same targetId by reconcile.
        this.clearLease(record);
        continue;
      }
      // Either identity being dead makes the record reclaimable: the holder (whose renew is what
      // keeps leaseExpiresAt ahead of now) or the adopter actually driving the tab.
      if (record.leaseId && (this.ownerIsDead(record.owner) || this.ownerIsDead(record.adopterOwner ?? null))) {
        const leaseId = record.leaseId;
        this.clearLease(record);
        // G12: release()'s grant-retaining branch forgets the adopter; this path did not, so a
        // grant whose adopter was SIGKILLed kept naming a dead pid on the reservation — the very
        // thing a later reclaim decision reads.
        if (this.externalReservation?.leaseId === leaseId) this.externalReservation.adopterOwner = null;
        // G13: clearLease nulls the lease fields and leaves targetId, so every reclaimed adopter
        // leaked one tab for the life of the browser. Round 4 made this path routine, so the leak
        // became routine too. Only agent.* tabs are closed: they are created per-adopter via
        // /json/new and nothing reuses them, unlike the reconciled amazon.* surfaces above.
        if (record.surface.startsWith("agent.")) abandoned.push(record);
      }
    }
    for (const record of abandoned) {
      this.records.delete(record.surface);
      this.queueTargetClose(record.targetId, record.surface);
    }
  }

  /**
   * Close a tab abandoned by a reclaimed adopter. `expireLeases` is synchronous and runs on
   * nearly every broker operation, while `targets.close` is async — so closes are queued and
   * drained by a single serialized sweep rather than awaited inline. A failed close is logged
   * and dropped: the record is already gone, and retrying forever would be worse than one
   * stray tab.
   */
  private queueTargetClose(targetId: string, surface: string): void {
    this.pendingCloses.push({ targetId, surface });
    this.closeSweep = this.closeSweep.then(() => this.flushTargetCloses(), () => this.flushTargetCloses());
  }

  private async flushTargetCloses(): Promise<void> {
    while (this.pendingCloses.length > 0) {
      const pending = this.pendingCloses.shift()!;
      try {
        await this.targets.close(pending.targetId);
        logger.info(pending, "Closed the tab of a reclaimed agent lease");
      } catch (err) {
        logger.warn({ err, ...pending }, "Failed to close the tab of a reclaimed agent lease");
      }
    }
  }

  /** Test seam: settle the queued-close sweep. Never called from the daemon. */
  async __flushPendingClosesForTest(): Promise<void> { await this.closeSweep; }

  /** Test seam: simulate a holder/adopter whose process died, without spawning one. */
  __setRecordOwnerForTest(surface: string, owner: string | null, adopterOwner: string | null): void {
    const record = this.records.get(surface);
    if (!record) throw new Error(`no record for ${surface}`);
    record.owner = owner;
    record.adopterOwner = adopterOwner;
  }

  /** Test seam: the adopter currently named on the external reservation. */
  externalReservationAdopterForTest(): string | null {
    return this.externalReservation?.adopterOwner ?? null;
  }
  /**
   * A lease whose owning process is gone is reclaimed at once instead of blocking every
   * `agent.*` surface for its full TTL (2026-08-29: a killed query-competitor collector left a
   * 3h lease behind).
   *
   * Owner-shape AGNOSTIC. It used to match only `browserctl-agent:<pid>`, which meant a holder
   * shaped `abvp-refresh:<pid>:<run_id>` was never checked at all — so a granted record could not
   * be reclaimed, and `restoreExternalReservation` would happily resurrect a dead holder's grant
   * into a new daemon generation. Any `<name>:<pid>` or `<name>:<pid>:<suffix>` owner is now
   * checked; an owner carrying no pid (e.g. `human:yanqing`) is never considered dead.
   *
   * DEBT (G11): pid REUSE is not detected — only `ESRCH` counts as dead, so a recycled pid makes
   * a dead adopter look alive and its record stays locked for the run (the conservative
   * direction; reclaiming a LIVE adopter is unreachable). Closing it needs the process start
   * time captured at acquire/adopt and compared here, and this runs on nearly every broker
   * operation, so it cannot afford a `ps` per call. Upgrade when a lockout is actually traced to
   * a recycled pid, or when start time can be captured once at registration and cached.
   */
  private ownerIsDead(owner: string | null): boolean {
    const m = owner ? /^[^:]+:(\d+)(?::|$)/.exec(owner) : null;
    if (!m) return false;
    const pid = Number(m[1]);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return false; } catch (err) { return (err as NodeJS.ErrnoException).code === "ESRCH" && !browserDriverAlive(owner); }
  }
  private clearLease(record: TargetRecord): void {
    record.owner = null; record.leaseId = null; record.leaseExpiresAt = null; record.adopterOwner = null; record.lastActivityAt = this.now();
  }
}
export type ControlRequest = { instance?: string; verb: string; surface?: string; owner?: string; ttl?: number; granted?: boolean; leaseId?: string; targetId?: string; closeTarget?: boolean; expectedOrigin?: string[]; bootstrapUrl?: string; enabled?: boolean; reason?: string };
export interface BrowserControlInstance {
  id: string;
  endpoint: string;
  broker: BrowserLeaseBroker;
  ready(): Promise<void>;
  status(): Promise<unknown>;
  changed(): void;
}
export function startBrowserControlServer(broker: BrowserLeaseBroker, maintenance: (enabled: boolean, reason: string) => Promise<void>, socketPath = BROWSER_CONTROL_SOCKET, touch?: (surface: string) => Promise<unknown>, instances: BrowserControlInstance[] = []): Server {
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
        const byLease = request.leaseId ? instances.find(item => item.broker.hasLease(request.leaseId!)) : undefined;
        const instanceId = request.instance ?? byLease?.id ?? "downloads";
        const instance = instances.find(item => item.id === instanceId);
        if (instanceId !== "downloads" && !instance) throw new Error("unknown browser instance");
        if (byLease && byLease.id !== instanceId) throw new Error("lease instance mismatch");
        if (instance && instance.id !== "downloads" && request.leaseId && broker.hasLease(request.leaseId)) throw new Error("lease instance mismatch");
        if (instance && ["reserve-external", "reconcile", "acquire", "adopt-external"].includes(request.verb)) await instance.ready();
        const selected = instance?.broker ?? broker;
        let result: unknown;
        if (request.verb === "status" && instance) result = await instance.status();
        else if (request.verb === "reconcile") result = await selected.reconcile(request.surface!, request.expectedOrigin!, request.bootstrapUrl!);
        else if (request.verb === "acquire") result = await selected.acquire(request.surface!, request.owner!, request.ttl!);
        else if (request.verb === "reserve-external") result = await selected.reserveExternal(request.surface!, request.owner!, request.ttl!, request.granted === true);
        else if (request.verb === "capabilities") result = { verbs: ["reserve-external", "adopt-external", "release-grant", "acquire", "renew", "release", "reconcile", "touch", "maintenance"], grants: true, instances: ["downloads", ...instances.map(item => item.id)] };
        else if (request.verb === "adopt-external") result = selected.adoptExternal(request.leaseId!, request.owner!, request.surface);
        else if (request.verb === "release-grant") result = await selected.releaseGrant(request.leaseId!);
        else if (request.verb === "register-external-target") result = await selected.registerExternalTarget(request.leaseId!, request.targetId!);
        else if (request.verb === "renew") result = selected.renew(request.leaseId!, request.ttl!);
        else if (request.verb === "release") result = await selected.release(request.leaseId!, request.closeTarget, request.targetId);
        else if (request.verb === "touch" && !instance && touch && request.surface) result = await touch(request.surface);
        else if (request.verb === "maintenance") {
          if (instance) throw new Error("interactive maintenance cannot interrupt an owned workflow; release its lease first");
          await maintenance(Boolean(request.enabled), request.reason ?? "browserctl");
          if (!request.enabled) selected.resume();
          result = { enabled: Boolean(request.enabled), reason: request.enabled ? request.reason ?? "browserctl" : null };
        } else throw new Error(`unknown verb: ${request.verb}`);
        instance?.changed();
        if (result && typeof result === "object") result = { ...result, instance: instanceId, cdpEndpoint: instance?.endpoint ?? "http://127.0.0.1:9222" };
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
