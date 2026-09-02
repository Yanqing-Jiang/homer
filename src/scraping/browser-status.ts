import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BROWSER_STATUS_PATH, type TargetRecord } from "./browser-control.js";

export type SurfaceHealth = {
  state: "authenticated" | "unauthenticated" | "unknown";
  lastProbeAt: string | null; lastOkAt: string | null; lastTouchAt: string | null; reason: string | null;
};
export type ChromeStatus = {
  schema: 1; updatedAt: string; generation: number; supervisorPid: number; chromePid: number | null;
  /** How this daemon came to be pointed at the live Chrome — see ChromeOwnership. */
  ownership: "launched" | "adopted" | "foreign" | "none";
  /** Non-null while agent-browser automation is refused; the daemon still runs everything else. */
  degradedReason: string | null;
  /**
   * ISO deadline of the post-adoption fence, or null. Non-null means this generation adopted
   * a Chrome whose external holder it could not reconstruct and is refusing new agent
   * reservations until then — the one thing an operator cannot otherwise tell from the file.
   */
  adoptionGraceUntil: string | null;
  /** The live external (agent-browser) reservation, if any. */
  externalReservation: { surface: string; owner: string; expiresAt: string; granted: boolean } | null;
  profilePath: string;
  /**
   * `restartDeferrals` counts heartbeat restarts the supervisor DEFERRED because an external
   * holder was driving a browser that still answered CDP (F8) — a rising count with a
   * non-ready state is a deliberate wait, not a stuck supervisor. `reason` carries the
   * `bin/browserctl maintenance off` command while maintenance is on (F9), so the hourly
   * health check's `CDP <state> (<reason>)` line names the way out.
   */
  cdp: { state: "ready" | "empty" | "absent"; pages: number; restartCount: number; restartDeferrals?: number; reason: string | null };
  maintenance: { enabled: boolean; reason: string | null };
  surfaces: Record<string, SurfaceHealth & { targetId: string | null; lease: { owner: string; expiresAt: string } | null }>;
};

export function writeStatusAtomic(path: string, status: ChromeStatus): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(status, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const dirFd = openSync(dirname(path), "r");
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

export class BrowserStatusService {
  private timer?: ReturnType<typeof setInterval>;
  private health = new Map<string, SurfaceHealth>();
  constructor(
    private readonly snapshot: () => Omit<ChromeStatus, "schema" | "updatedAt" | "surfaces"> & { records: TargetRecord[] },
    private readonly path = BROWSER_STATUS_PATH,
    private readonly now = Date.now,
  ) {}
  start(): void { this.publish(); this.timer = setInterval(() => this.publish(), 60_000); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  update(surface: string, patch: Partial<SurfaceHealth>): void {
    const prior = this.health.get(surface) ?? { state: "unknown", lastProbeAt: null, lastOkAt: null, lastTouchAt: null, reason: null };
    this.health.set(surface, { ...prior, ...patch }); this.publish();
  }
  publish(): void {
    const { records, ...base } = this.snapshot();
    const surfaces: ChromeStatus["surfaces"] = {};
    for (const record of records) {
      const raw = this.health.get(record.surface) ?? { state: "unknown" as const, lastProbeAt: null, lastOkAt: null, lastTouchAt: null, reason: null };
      const stale = raw.lastProbeAt !== null && this.now() - Date.parse(raw.lastProbeAt) > 8 * 60 * 60 * 1000;
      surfaces[record.surface] = { ...raw, state: stale ? "unknown" : raw.state, targetId: record.targetId,
        lease: record.leaseId && record.owner && record.leaseExpiresAt ? { owner: record.owner, expiresAt: new Date(record.leaseExpiresAt).toISOString() } : null };
    }
    writeStatusAtomic(this.path, { schema: 1, updatedAt: new Date(this.now()).toISOString(), ...base, surfaces });
  }
}
