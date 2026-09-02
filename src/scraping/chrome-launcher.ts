/**
 * Chrome CDP Auto-Launcher
 *
 * Ensures a Chrome DevTools Protocol endpoint is available for agent-browser.
 * Strategy: check existing CDP → headless launch → headed fallback.
 */

import { execSync, spawn, type ChildProcess } from "child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import Database from "better-sqlite3";
import { logger } from "../utils/logger.js";
import { processRegistry } from "../process/registry.js";
import { getRuntimePaths } from "../utils/runtime-paths.js";
import {
  BROWSER_CONTROL_STATE_DIR,
  BrowserLeaseBroker,
  HttpBrowserTargetClient,
  type ExternalReservation,
  type TargetRecord,
} from "./browser-control.js";
import {
  classifyPortOwner,
  decideExitChromeAction,
  decideRestartChromeAction,
  decideSingletonForward,
  inspectPortListeners,
  isPidAlive,
  readProfileLockPid,
  terminatePidBounded,
  type PortOwner,
  type SingletonDecision,
  type SingletonEnvironment,
} from "./chrome-orphan.js";

const CDP_PORT = 9222;
const CDP_PROFILE_PREFIX = "/tmp/chrome-cdp-profile-";
export const RESIDENT_CDP_PROFILE = "/Users/yj/Library/Application Support/Homer/Chrome-CDP";
const CDP_POLL_INTERVAL_MS = 1_000;
const CDP_POLL_MAX_MS = 15_000;
const CDP_HEARTBEAT_MS = 60_000;
const CDP_RESTART_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;
/** A child gone this fast never finished starting — see settleFastExit. */
const CHROME_FAST_EXIT_MS = 5_000;
const RESTART_FLAP_WINDOW_MS = 300_000;
const RESTART_FLAP_LIMIT = 5;
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const runtimePaths = getRuntimePaths();
const PROFILE_SOURCE = runtimePaths.chromeProfileRoot;

export interface CDPHandle {
  /** PID of launched Chrome process (0 if reusing existing) */
  pid: number;
  /** Temp profile dir backing this Chrome (undefined when reusing an existing CDP) */
  userDataDir?: string;
  /** Call to kill Chrome and remove temp profile */
  cleanup: () => void;
}

/**
 * Most recent CDP Chrome this process launched. Tracked so recycleSession()
 * can deterministically tear down the profile dir we own.
 */
let activeCDPHandle: CDPHandle | undefined;

/**
 * Wall-clock (ms) of the most recent scrape entry (ensureCDP / recycleSession).
 * The cleanup scheduler reads this to decide whether the long-lived CDP Chrome
 * has been idle long enough to tear down. Module-scoped is sound: the scheduler
 * and every scrape caller run in the same daemon process.
 */
let lastCdpUseAt = 0;

// DEBT: headed supervision begins only after GUI login, upgrade when a collector must survive a reboot before user login.
export interface ResidentChromeChild {
  pid?: number;
  once(event: "exit" | "error", listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface ChromeSupervisorDeps {
  spawnChrome: () => ResidentChromeChild;
  probe: () => Promise<CdpProbe>;
  /**
   * Seeds a page target on a listener that has none. Injected rather than
   * imported so the class stays fake-driven; the wiring below points it at
   * ensurePageTarget, the one sanctioned seeder.
   */
  ensurePage?: () => Promise<boolean>;
  /** True while :9222 still answers /json/version — used to classify a fast child exit. */
  cdpPortOccupied?: () => Promise<boolean>;
  ensureProfile: () => void;
  nextGeneration: () => number;
  drainLeases: () => Promise<void>;
  observeTargets?: () => Promise<void>;
  /**
   * Who currently LISTENs on the CDP port. Injected (rather than imported) so the
   * singleton-forward recovery below is driven by fixtures in tests and never
   * shells out to lsof/ps from a unit test.
   */
  inspectOwner?: () => PortOwner;
  /** Evidence the adoption decision needs: CDP health + the profile lock holder. */
  singletonEnvironment?: () => Promise<SingletonEnvironment>;
  /** Bounded SIGTERM → SIGKILL of an orphan we decided not to adopt. */
  terminateOrphan?: (pid: number) => Promise<"terminated" | "killed" | "alive">;
  /** Live EXTERNAL browser holders (never Homer's own stewardship leases). */
  externalLeases?: () => number;
  /** Persist whatever an external holder needs to survive this daemon generation. */
  onLeaveForAdoption?: (kind: string) => void;
  /** Called after adopting an orphan, so the broker can re-derive the external holder. */
  onAdopt?: (pid: number) => void | Promise<void>;
  /** Called after a CLEAN launch, so a handoff nothing will consume is not left on disk. */
  onCleanLaunch?: () => void;
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  heartbeatMs: number;
  backoffMs: readonly number[];
}

/**
 * "launched" — this daemon spawned the Chrome it is supervising.
 * "adopted"  — the port was already held by an orphan of a PREVIOUS daemon generation
 *              carrying our profile and our port; we took it over instead of fighting
 *              Chrome's ProcessSingleton (the 2026-09-01 crash loop).
 * "foreign"  — someone else's Chrome holds the port. We never signal it.
 * "none"     — nothing supervised yet.
 */
export type ChromeOwnership = "launched" | "adopted" | "foreign" | "none";

export const browserLeaseBroker = new BrowserLeaseBroker(new HttpBrowserTargetClient(CDP_PORT));
export async function drainLeases(): Promise<void> { await browserLeaseBroker.drainLeases(); }

export class ResidentChromeSupervisor {
  private child?: ResidentChromeChild;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private running = false;
  private failedHeartbeats = 0;
  private restartAttempt = 0;
  private restartDraining = false;
  private maintenanceEnabled = false;
  private maintenanceReason: string | null = null;
  private lastProbe: CdpProbe = { state: "absent", pages: 0 };
  private restartCount = 0;
  /**
   * Restarts DEFERRED because an external holder was driving a browser that still answered
   * CDP (F8). Published in status.json so "the heartbeat keeps failing but nothing restarts"
   * is readable as a deliberate state rather than a stuck supervisor.
   */
  private restartDeferrals = 0;
  /**
   * pid of the child most recently SIGTERMed by the kill path. A relaunch that fires before
   * Chrome has honoured the signal is forwarded into that dying Chrome, whose parent is this
   * daemon — the in-place-orphan shape decideSingletonForward would adopt. Adopting a
   * browser we just asked to die (and fencing agent reservations for it, see
   * restoreExternalHolderAfterAdoption) is wrong, so the forward resolver terminates it instead.
   */
  private signalledPid: number | null = null;
  /** Wall-clock of each scheduled restart inside the flap window — see tripFlapBreaker. */
  private restartTimestamps: number[] = [];
  /**
   * Re-registers the long-lived surface targets after a Chrome restart. A restart
   * calls beginGeneration(), which clears the broker registry, but nothing else
   * re-runs the startup reconcile — so without this the surfaces stay absent until
   * the daemon itself restarts, silently disabling stewardship touches and blanking
   * status.json for health consumers.
   */
  private reconcileSurfaces?: () => Promise<void>;
  private surfacesGeneration = 0;
  private transition: () => void = () => {};
  /**
   * How this daemon came to be pointed at the live Chrome. Published in status.json
   * and the log so an operator can tell "we launched it" from "we inherited an orphan
   * of a previous daemon generation" without reconstructing it from timestamps.
   */
  private ownership: ChromeOwnership = "none";
  /** pid of an ADOPTED Chrome — one this daemon did not spawn and must not assume it owns. */
  private adoptedPid: number | null = null;
  private leaveForAdoption = false;
  /** Generation whose clean launch has already been reported — see onCleanLaunch. */
  private cleanLaunchGeneration = 0;
  generation = 0;

  constructor(private readonly deps: ChromeSupervisorDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.launch();
    this.scheduleHeartbeat();
  }

  /**
   * Deliberate shutdown. Lease-aware since the 2026-09-01 review: an ordinary
   * `npm run restart` used to SIGTERM Chrome unconditionally, which would have ended the
   * in-flight QC competitor backfill (a live `browserctl-agent:` lease) exactly the way
   * the crash path was fixed not to. Same policy in both directions now — with a live
   * EXTERNAL holder we leave the browser up and the next generation adopts it.
   *
   * `deps.externalLeases` is optional so a fake-driven supervisor keeps the old behaviour.
   */
  stop(): void {
    this.running = false;
    this.clearTimers();
    const child = this.child;
    this.child = undefined;
    // F2: key on the Chrome this daemon is RESPONSIBLE FOR, not on the one it spawned. Both
    // exit paths used to read `this.child`, which is undefined for an adopted Chrome — so a
    // generation running on an adopted browser returned here silently, wrote no handoff, and
    // the generation after it adopted blind. Signalling is still gated separately: we never
    // signal a Chrome we did not spawn.
    const chromePid = child?.pid ?? this.adoptedPid;
    if (chromePid == null) return;
    if (this.leaveForAdoption) {
      logger.warn({ pid: chromePid, ownership: this.ownership }, "Resident Chrome left running for adoption — not signalling on stop");
      return;
    }
    let externalLeases = 0;
    try { externalLeases = this.deps.externalLeases?.() ?? 0; } catch { externalLeases = 0; }
    const decision = decideExitChromeAction({ deliberate: true, chromePid, externalLeases });
    if (decision.action === "leave-for-adoption") {
      this.leaveForAdoption = true;
      this.deps.onLeaveForAdoption?.("deliberate-shutdown");
      logger.warn(
        { pid: chromePid, ownership: this.ownership, externalLeases, reason: decision.reason },
        "Deliberate shutdown: leaving resident Chrome running for adoption by the next daemon generation (live external lease)",
      );
      return;
    }
    if (decision.action === "none") return;
    if (!child) {
      // Adopted: never signalled, but the next generation still needs whatever holder state
      // exists — and the operator needs to know Chrome was left running at all.
      this.deps.onLeaveForAdoption?.("deliberate-shutdown-adopted");
      logger.warn(
        { pid: chromePid, externalLeases },
        "Deliberate shutdown: resident Chrome was ADOPTED, not spawned — leaving it running and never signalling it",
      );
      return;
    }
    child.kill("SIGTERM");
  }

  /** Set by the fatal-exit reaper when a live lease means Chrome must survive this daemon. */
  markLeaveForAdoption(): void { this.leaveForAdoption = true; }

  isActive(): boolean { return this.running; }

  maintenance(): { enabled: boolean; reason: string | null } {
    return { enabled: this.maintenanceEnabled, reason: this.maintenanceReason };
  }
  setTransitionHandler(handler: () => void): void { this.transition = handler; }
  /** Registering treats the current generation as already reconciled by daemon startup. */
  setSurfaceReconciler(reconcile: () => Promise<void>): void {
    this.reconcileSurfaces = reconcile;
    this.surfacesGeneration = this.generation;
  }
  status(): { generation: number; chromePid: number | null; ownership: ChromeOwnership; cdp: CdpProbe & { restartCount: number; restartDeferrals: number }; maintenance: { enabled: boolean; reason: string | null } } {
    return { generation: this.generation, chromePid: this.child?.pid ?? this.adoptedPid, ownership: this.ownership,
      cdp: { ...this.lastProbe, restartCount: this.restartCount, restartDeferrals: this.restartDeferrals }, maintenance: this.maintenance() };
  }

  /** pid of the Chrome THIS daemon spawned — null when absent or merely adopted. */
  launchedChromePid(): number | null { return this.child?.pid ?? null; }

  async setMaintenance(enabled: boolean, reason: string): Promise<void> {
    if (enabled) {
      this.maintenanceEnabled = true;
      this.maintenanceReason = reason;
      this.transition();
      if (this.restartTimer) this.deps.clearTimer(this.restartTimer);
      this.restartTimer = undefined;
      await this.deps.drainLeases();
      return;
    }
    this.maintenanceEnabled = false;
    this.maintenanceReason = null;
    this.transition();
    if (this.running && !this.child) this.launch();
  }

  async heartbeatNow(): Promise<void> {
    if (!this.running || this.maintenanceEnabled) return;
    let result = await this.deps.probe();
    // A cleanly launched Chrome now opens NO window (--no-startup-window), so its
    // first probe is empty-without-reason. Seed the page target here instead of
    // waiting for a scrape to demand one, otherwise status/health sit at "empty"
    // for a browser that is perfectly healthy. `reason` set means the target list
    // was unreadable — transient, and never a licence to mutate browser state.
    if (result.state === "empty" && !result.reason && this.deps.ensurePage) {
      if (await this.deps.ensurePage()) result = await this.deps.probe();
    }
    this.lastProbe = result; this.transition();
    if (result.state !== "absent" && !result.reason) {
      // N15: a launch that reached a healthy probe without a singleton forward means no
      // adoption happened, so any handoff on disk will never be consumed — drop it rather
      // than leave it for an unrelated adoption up to four hours later.
      if (this.ownership === "launched" && this.cleanLaunchGeneration !== this.generation) {
        this.cleanLaunchGeneration = this.generation;
        try { this.deps.onCleanLaunch?.(); } catch (err) { logger.warn({ err }, "Clean-launch handoff discard failed"); }
      }
      await this.deps.observeTargets?.();
      if (this.reconcileSurfaces && this.surfacesGeneration !== this.generation) {
        try {
          await this.reconcileSurfaces();
          this.surfacesGeneration = this.generation;
        } catch (err) {
          logger.warn({ err, generation: this.generation }, "Surface reconcile after Chrome restart failed");
        }
      }
      this.failedHeartbeats = 0;
      this.restartAttempt = 0;
      this.signalledPid = null;
      return;
    }
    this.failedHeartbeats++;
    if (this.failedHeartbeats >= 3) {
      this.failedHeartbeats = 0;
      this.scheduleRestart("three consecutive heartbeat failures");
    }
  }

  private launch(): void {
    if (!this.running || this.maintenanceEnabled || this.child) return;
    try {
      this.deps.ensureProfile();
      this.generation = this.deps.nextGeneration();
      const spawnedAt = Date.now();
      const child = this.deps.spawnChrome();
      this.child = child;
      this.ownership = "launched";
      this.adoptedPid = null;
      this.lastProbe = { state: "empty", pages: 0, reason: "Chrome starting" }; this.transition();
      const settle = () => {
        if (this.child !== child) return;
        this.child = undefined;
        this.lastProbe = { state: "absent", pages: 0, reason: "Chrome exited" }; this.transition();
        const elapsedMs = Date.now() - spawnedAt;
        if (elapsedMs >= CHROME_FAST_EXIT_MS || !this.deps.cdpPortOccupied) {
          this.scheduleRestart("unexpected child exit");
          return;
        }
        void this.settleFastExit(elapsedMs);
      };
      child.once("exit", settle);
      child.once("error", settle);
      logger.info({ pid: child.pid, generation: this.generation }, "Resident Chrome started");
    } catch (err) {
      logger.error({ err, generation: this.generation }, "Resident Chrome launch failed");
      this.scheduleRestart("launch failed");
    }
  }

  /**
   * A child that dies within CHROME_FAST_EXIT_MS while :9222 keeps answering did
   * not crash: Chrome's ProcessSingleton found another instance holding the
   * profile lock, forwarded our command line to it and exited 0 (2026-08-18).
   * Relaunching cannot win that race, so the classification exists to name the
   * condition in the log and feed the flap breaker fast. It still schedules a
   * restart — adopting or killing the squatter is a separate fix.
   */
  private async settleFastExit(elapsedMs: number): Promise<void> {
    let occupied = false;
    try {
      occupied = (await this.deps.cdpPortOccupied?.()) ?? false;
    } catch (err) {
      logger.warn({ err }, "CDP port check after fast Chrome exit failed");
    }
    if (!occupied) {
      this.scheduleRestart("unexpected child exit");
      return;
    }
    logger.warn(
      { elapsedMs, port: CDP_PORT, generation: this.generation, profile: RESIDENT_CDP_PROFILE },
      "Resident Chrome exited immediately while CDP stayed up — another Chrome owns the profile (singleton forward)",
    );
    await this.resolveSingletonForward();
  }

  /**
   * Decide what to do about the Chrome that already owns :9222, then do it.
   *
   * Before 2026-09-01 this path only ever scheduled another relaunch, and every
   * relaunch was forwarded to the squatter again — 63 supervisor restarts in 70
   * minutes. Now the owner is identified: our own orphan is adopted when it is
   * healthy and demonstrably holds the profile lock, terminated (bounded) and
   * relaunched when it is not, and a Chrome on ANY other profile is left strictly
   * alone. Whichever path is taken is recorded in status.json (`ownership`) and the log.
   */
  private async resolveSingletonForward(): Promise<void> {
    if (!this.deps.inspectOwner || !this.deps.singletonEnvironment) {
      this.scheduleRestart("singleton forward — another Chrome owns the profile");
      return;
    }
    let decision: SingletonDecision;
    try {
      const owner = this.deps.inspectOwner();
      const env = await this.deps.singletonEnvironment();
      decision = decideSingletonForward(owner, env);
    } catch (err) {
      logger.warn({ err }, "Singleton-forward owner inspection failed — falling back to restart");
      this.scheduleRestart("singleton forward — owner inspection failed");
      return;
    }
    if (decision.action === "adopt" && decision.pid !== null && decision.pid === this.signalledPid) {
      // F8 guard: this is the child the kill path SIGTERMed moments ago and the relaunch
      // outran it. It is dying, not orphaned — finish the job instead of adopting it.
      decision = { action: "terminate", pid: decision.pid, reason: `Chrome ${decision.pid} was SIGTERMed by this daemon and has not exited yet — terminating rather than adopting a dying browser` };
    }

    if (decision.action === "adopt" && decision.pid !== null) {
      this.ownership = "adopted";
      this.adoptedPid = decision.pid;
      this.restartAttempt = 0;
      this.failedHeartbeats = 0;
      // F5: `restartTimestamps` is deliberately NOT cleared, so a genuine relaunch → forward →
      // adopt → relaunch cycle still accumulates towards the flap breaker. The window is
      // self-expiring (RESTART_FLAP_WINDOW_MS), so a one-off startup adoption is unaffected.
      // (The heartbeat restart under a live lease no longer relaunches at all — F8 — so it
      // neither reaches this branch nor the breaker.)
      logger.warn(
        { pid: decision.pid, generation: this.generation, reason: decision.reason, profile: RESIDENT_CDP_PROFILE },
        "Adopted orphaned resident Chrome",
      );
      this.transition();
      // M8: beginGeneration() cleared the broker registry AND the external reservation, so
      // without this the broker believes nothing holds a browser an external agent may
      // still be driving. The hook restores the previous generation's reservation, or
      // fences new agent reservations for a grace period when it cannot.
      try { await this.deps.onAdopt?.(decision.pid); }
      catch (err) { logger.error({ err, pid: decision.pid }, "External-holder restore after adoption failed"); }
      // Re-probe and re-reconcile against the adopted browser: the failed launch
      // already bumped the generation and cleared the broker registry, so the
      // surfaces must be re-registered against the targets this Chrome actually has.
      await this.heartbeatNow();
      return;
    }

    if (decision.action === "terminate" && decision.pid !== null) {
      logger.warn({ pid: decision.pid, reason: decision.reason }, "Terminating un-adoptable orphaned resident Chrome");
      const outcome = this.deps.terminateOrphan
        ? await this.deps.terminateOrphan(decision.pid).catch((err) => {
            logger.warn({ err, pid: decision.pid }, "Orphan termination failed");
            return "alive" as const;
          })
        : ("alive" as const);
      logger.warn({ pid: decision.pid, outcome }, "Orphaned resident Chrome termination finished");
      this.ownership = outcome === "alive" ? "foreign" : "none";
      this.adoptedPid = null;
      this.transition();
      this.scheduleRestart(`orphan ${outcome} — relaunching resident Chrome`);
      return;
    }

    if (decision.action === "leave-foreign" || decision.action === "leave-live-owner") {
      this.ownership = "foreign";
      this.adoptedPid = null;
      logger.error({ pid: decision.pid, reason: decision.reason }, "CDP port owned by a Chrome we must not touch");
      this.transition();
    }
    this.scheduleRestart(`singleton forward — ${decision.reason}`);
  }

  private scheduleRestart(reason: string): void {
    if (!this.running || this.maintenanceEnabled || this.restartTimer || this.restartDraining) return;
    // N7: decide BEFORE drainLeases() — the drain force-clears every lease after 10 s.
    let externalLeases = 0;
    try { externalLeases = this.deps.externalLeases?.() ?? 0; } catch { externalLeases = 0; }
    const restart = decideRestartChromeAction({
      externalLeases, cdpState: this.lastProbe.state, trackedChrome: this.child !== undefined || this.adoptedPid !== null,
    });
    if (restart.action === "defer") {
      // F8: nothing is signalled, drained, spawned or handed off. The child (or adopted pid)
      // stays tracked, the lease ledger stays intact, and the flap breaker is not fed —
      // there is no relaunch to flap. The next three failed heartbeats re-evaluate.
      this.restartDeferrals++;
      logger.warn(
        { reason, externalLeases, cdpState: this.lastProbe.state, probeReason: this.lastProbe.reason ?? null,
          chromePid: this.child?.pid ?? this.adoptedPid, ownership: this.ownership, deferrals: this.restartDeferrals, decision: restart.reason },
        "Chrome restart deferred: an external holder is driving a browser that still answers CDP — keeping it, no relaunch, no lease drain",
      );
      this.transition();
      return;
    }
    if (restart.action === "relaunch") {
      logger.warn({ reason, externalLeases, cdpState: this.lastProbe.state, decision: restart.reason },
        "Chrome restart: no tracked browser under a live external lease — relaunching so the singleton forward adopts the survivor");
    }
    this.restartDraining = true;
    void this.deps.drainLeases().catch((err) => {
      logger.warn({ err }, "Browser lease drain failed before Chrome restart");
    }).finally(() => {
      this.restartDraining = false;
      if (!this.running || this.maintenanceEnabled || this.restartTimer) return;
      const child = this.child;
      this.child = undefined;
      if (restart.action === "kill" && child) {
        this.signalledPid = child.pid ?? null;
        child.kill("SIGTERM");
      }
      if (this.tripFlapBreaker(reason)) return;
      const delayMs = this.deps.backoffMs[Math.min(this.restartAttempt, this.deps.backoffMs.length - 1)]!;
      this.restartAttempt++;
      this.restartCount++; this.transition();
      logger.warn({ reason, delayMs }, "Scheduling resident Chrome restart");
      this.restartTimer = this.deps.setTimer(() => {
        this.restartTimer = undefined;
        this.launch();
      }, delayMs);
    });
  }

  /**
   * Relaunching only ever fixes a Chrome that CAN come back. More than
   * RESTART_FLAP_LIMIT restarts inside RESTART_FLAP_WINDOW_MS means the relaunch
   * itself has become the failure (2026-08-18: every relaunch was forwarded to a
   * squatting Chrome, 19 restarts and 14 stray tabs in ten minutes). Entering
   * maintenance is the safe stop — it drains leases, suppresses launch(), and
   * `browserctl maintenance off` both re-arms and relaunches, so no new plumbing.
   * Returns true when the breaker tripped and the caller must NOT schedule.
   *
   * DEBT: the trip itself sends no alert — this module has no operator-alert
   * dependency and the scheduler's Telegram path is not reachable from here without
   * a cycle. It is visible in status.json (`maintenance`, and `cdp.reason` names the
   * `bin/browserctl maintenance off` command, F9) which the hourly health check reads;
   * upgrade to a direct alert when the supervisor gains an alert dep.
   */
  private tripFlapBreaker(reason: string): boolean {
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((at) => now - at < RESTART_FLAP_WINDOW_MS);
    this.restartTimestamps.push(now);
    if (this.restartTimestamps.length <= RESTART_FLAP_LIMIT) return false;
    logger.error(
      { reason, restarts: this.restartTimestamps.length, windowMs: RESTART_FLAP_WINDOW_MS, restartCount: this.restartCount, generation: this.generation },
      "Resident Chrome restart flap breaker tripped — entering maintenance instead of relaunching",
    );
    // Cleared here so maintenance-off re-arms the breaker with a fresh window.
    this.restartTimestamps = [];
    void this.setMaintenance(true, "restart flap circuit breaker — manual browserctl maintenance off to re-arm")
      .catch((err) => logger.error({ err }, "Entering maintenance after restart flap breaker failed"));
    return true;
  }

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = this.deps.setTimer(() => {
      void this.heartbeatNow().finally(() => {
        if (this.running) this.scheduleHeartbeat();
      });
    }, this.deps.heartbeatMs);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) this.deps.clearTimer(this.heartbeatTimer);
    if (this.restartTimer) this.deps.clearTimer(this.restartTimer);
    this.heartbeatTimer = undefined;
    this.restartTimer = undefined;
  }
}

const generationPath = join(dirname(RESIDENT_CDP_PROFILE), "chrome-cdp-generation");
export const residentChromeSupervisor = new ResidentChromeSupervisor({
  spawnChrome: () => spawn(CHROME_PATH, [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${RESIDENT_CDP_PROFILE}`,
    "--profile-directory=Default",
    "--no-first-run",
    "--no-default-browser-check",
    // Chrome progressively throttles timers in hidden/occluded tabs. Measured on
    // the query-competitor collector 2026-08-27: an in-page setTimeout pacing gate
    // asking for 1250ms between requests delivered ~1.02x right after navigation,
    // 2.26x one batch later, then 3.49x — the collector was offering ~0.23 req/s
    // against a server allowance near 0.89, and the decay looked like server-side
    // throttling when it was self-inflicted. Any long-running agent page paced from
    // JS has the same problem, so this belongs on the resident browser.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    // No positional URL and no startup window. If ProcessSingleton forwards this
    // command line to a Chrome already holding the profile lock, the forward is a
    // no-op instead of another about:blank tab — the 2026-08-18 tab storm was a
    // relaunch loop each of whose forwards opened one. The cost is that a clean
    // launch has zero page targets; heartbeatNow seeds the first one via ensurePage.
    "--no-startup-window",
  ], { stdio: "ignore" }),
  probe: () => probeCdp(CDP_PORT),
  ensurePage: () => ensurePageTarget(CDP_PORT),
  cdpPortOccupied: () => isCDPAvailable(CDP_PORT),
  ensureProfile: () => {
    mkdirSync(RESIDENT_CDP_PROFILE, { recursive: true, mode: 0o700 });
    chmodSync(RESIDENT_CDP_PROFILE, 0o700);
  },
  nextGeneration: () => {
    let current = 0;
    try { current = Number.parseInt(readFileSync(generationPath, "utf8"), 10) || 0; } catch { /* first launch */ }
    const next = current + 1;
    writeFileSync(generationPath, `${next}\n`, { mode: 0o600 });
    browserLeaseBroker.beginGeneration(next);
    return next;
  },
  drainLeases,
  observeTargets: () => browserLeaseBroker.observeTargets(),
  inspectOwner: () => classifyPortOwner(
    inspectPortListeners(CDP_PORT),
    // selfPid: a survivor parented by THIS daemon is an in-place orphan, adoptable (F8).
    { profilePath: RESIDENT_CDP_PROFILE, port: CDP_PORT, selfPid: process.pid },
    isPidAlive,
  ),
  singletonEnvironment: async () => ({
    cdpHealthy: (await probeCdp(CDP_PORT)).state !== "absent",
    profileLockPid: readProfileLockPid(RESIDENT_CDP_PROFILE),
  }),
  terminateOrphan: (pid) => terminatePidBounded(pid, { timeoutMs: 5_000 }),
  externalLeases: () => browserLeaseBroker.externalLeaseCount(),
  onLeaveForAdoption: (kind) => writeExternalReservationHandoff(kind),
  onAdopt: (pid) => restoreExternalHolderAfterAdoption(pid),
  onCleanLaunch: () => discardExternalReservationHandoff("clean launch"),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
  heartbeatMs: CDP_HEARTBEAT_MS,
  backoffMs: CDP_RESTART_BACKOFF_MS,
});

export function isResidentChromeSupervisionActive(): boolean {
  return residentChromeSupervisor.isActive();
}

/**
 * Last-ditch reap of the resident Chrome on a daemon exit path that is NOT a
 * deliberate shutdown (an uncaught fatal, or `main().catch`). `main().catch` calls
 * `process.exit(1)` directly and therefore never runs the registered shutdown tasks —
 * that is exactly how the 2026-09-01 orphan (Chrome 2876 reparented to launchd)
 * survived its daemon and made every subsequent start fail on a singleton forward.
 *
 * The lease ledger is consulted FIRST: if an external holder (QC's agent-browser
 * backfill) still has a live lease, killing Chrome would interrupt its run, so we
 * deliberately leave the browser up and say so — the next daemon generation adopts it
 * via decideSingletonForward instead.
 *
 * Only ever signals a Chrome THIS daemon spawned; an adopted Chrome is never killed here.
 */
export async function reapResidentChromeOnFatalExit(kind: string): Promise<void> {
  // F2: the DECISION is made on the Chrome this daemon is responsible for (launched or
  // adopted); only the SIGNAL is restricted to one we spawned. Keying both on
  // launchedChromePid() meant a generation running on an adopted Chrome reported "nothing to
  // reap" and wrote no handoff, so the generation after it adopted blind.
  const status = residentChromeSupervisor.status();
  const chromePid = status.chromePid;
  const launchedPid = residentChromeSupervisor.launchedChromePid();
  const externalLeases = browserLeaseBroker.externalLeaseCount();
  const decision = decideExitChromeAction({ deliberate: false, chromePid, externalLeases });
  if (decision.action === "none") {
    logger.warn({ kind, reason: decision.reason }, "Fatal exit: no resident Chrome to reap");
    return;
  }
  if (decision.action === "leave-for-adoption") {
    residentChromeSupervisor.markLeaveForAdoption();
    const handedOff = writeExternalReservationHandoff(kind);
    logger.error(
      { kind, chromePid, ownership: status.ownership, externalLeases, handedOff, reason: decision.reason },
      "Fatal exit: leaving resident Chrome running for adoption by the next daemon generation (live external lease)",
    );
    return;
  }
  if (launchedPid === null) {
    // Adopted. Never signalled — but hand off whatever holder state exists so the next
    // generation is not blind, and say so.
    const handedOff = writeExternalReservationHandoff(`${kind}-adopted`);
    logger.error(
      { kind, chromePid, handedOff },
      "Fatal exit: resident Chrome was ADOPTED, not spawned — leaving it running and never signalling it",
    );
    return;
  }
  logger.error({ kind, chromePid: launchedPid, reason: decision.reason }, "Fatal exit: terminating resident Chrome so the next generation does not inherit an orphan");
  const outcome = await terminatePidBounded(launchedPid, { timeoutMs: 3_000 });
  logger.error({ kind, chromePid: launchedPid, outcome }, "Fatal exit: resident Chrome reap finished");
}

/**
 * Hand-off file for M8: the EXTERNAL holder this generation was leaving behind when it left
 * Chrome up for someone else. `beginGeneration()` clears both the records and the external
 * reservation, so without this the adopting generation believes nothing holds a browser
 * QC's agent-browser may still be driving — and the global agent-browser serialization that
 * exists for the 0.21.4 concurrent-rebinding hazard is silently gone.
 *
 * It carries the whole holder (reservation AND `agent.*` lease records with their
 * `adopterOwner`), not just the reservation: a `browserctl agent` holder's reservation is
 * cleared by `registerExternalTarget`, so in production the record IS the holder (round-2
 * review N2).
 *
 * Written on any path that leaves Chrome for another owner; consumed exactly once by the
 * next generation's adopt path, and deleted on a clean launch so it can never resurrect a
 * stale grant (round-2 review N15).
 */
const EXTERNAL_HANDOFF_PATH = join(BROWSER_CONTROL_STATE_DIR, "external-reservation-handoff.json");
/** A handoff older than this is ignored outright, whatever its own expiry claims. */
const EXTERNAL_HANDOFF_MAX_AGE_MS = 4 * 60 * 60 * 1000;
/** How long new agent reservations are refused after adopting with no usable handoff. */
const ADOPTION_GRACE_MS = 10 * 60 * 1000;

interface ExternalHolderHandoff {
  writtenAt?: number;
  kind?: string;
  holder?: { reservation: ExternalReservation | null; records: TargetRecord[] };
}

/** Returns true when a handoff was actually written, so callers can log the difference. */
export function writeExternalReservationHandoff(kind: string): boolean {
  try {
    const holder = browserLeaseBroker.externalHolderSnapshot();
    if (!holder) {
      logger.warn({ kind }, "No external browser holder to hand off — the next generation will fence instead");
      return false;
    }
    mkdirSync(dirname(EXTERNAL_HANDOFF_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(
      EXTERNAL_HANDOFF_PATH,
      `${JSON.stringify({ writtenAt: Date.now(), kind, holder })}\n`,
      { mode: 0o600 },
    );
    logger.warn(
      { kind, reservationOwner: holder.reservation?.owner ?? null,
        records: holder.records.map((r) => ({ surface: r.surface, owner: r.owner, adopterOwner: r.adopterOwner ?? null })) },
      "External browser holder handed off to the next daemon generation",
    );
    return true;
  } catch (err) {
    logger.error({ err, kind }, "Failed to write the external-holder handoff");
    return false;
  }
}

/** Remove a handoff nothing will consume — a clean launch means no adoption happened. */
export function discardExternalReservationHandoff(reason: string): void {
  try {
    if (!existsSync(EXTERNAL_HANDOFF_PATH)) return;
    rmSync(EXTERNAL_HANDOFF_PATH, { force: true });
    logger.info({ reason }, "Discarded a stale external-holder handoff (no adoption took place)");
  } catch { /* best effort */ }
}

/**
 * Restore the previous generation's external holder after adopting its Chrome, or fence new
 * agent reservations for a grace period when that is not possible (a SIGKILLed daemon writes
 * no handoff). The fence's error text is phrased as contention so callers that classify
 * contention vs sickness defer instead of alerting.
 */
export async function restoreExternalHolderAfterAdoption(chromePid: number): Promise<void> {
  let handoff: ExternalHolderHandoff | null = null;
  try {
    if (existsSync(EXTERNAL_HANDOFF_PATH)) {
      handoff = JSON.parse(readFileSync(EXTERNAL_HANDOFF_PATH, "utf8")) as ExternalHolderHandoff;
    }
  } catch (err) {
    logger.warn({ err }, "External-holder handoff unreadable");
  }
  // Consume it either way: a handoff we could not use must not be reconsidered later.
  try { if (existsSync(EXTERNAL_HANDOFF_PATH)) rmSync(EXTERNAL_HANDOFF_PATH, { force: true }); } catch { /* best effort */ }

  const fresh = Boolean(
    handoff?.holder
    && typeof handoff.writtenAt === "number"
    && Date.now() - handoff.writtenAt < EXTERNAL_HANDOFF_MAX_AGE_MS,
  );
  if (fresh && handoff?.holder) {
    const restored = await browserLeaseBroker.restoreExternalHolder(handoff.holder);
    if (restored.outcome === "restored") {
      logger.warn(
        { chromePid, ...restored },
        "Restored the previous generation's external browser holder onto the adopted Chrome",
      );
      return;
    }
    if (restored.outcome === "holders-gone") {
      // POSITIVE evidence: every holder named in the handoff has a dead pid, so nothing
      // external is driving this browser any more and no fence is warranted.
      logger.info({ chromePid, ...restored }, "External-holder handoff found but every holder is gone — adopted Chrome is free");
      return;
    }
    // F1: "restored nothing" is NOT "nothing is holding it". A failed /json/list (most likely
    // exactly here, milliseconds after a ProcessSingleton forward), a live agent whose lease
    // lapsed because its `browserctl renew` failure was swallowed, or a tab closed at this
    // instant all land here — and every one of them means an agent may still be attached.
    logger.error(
      { chromePid, ...restored },
      "External holder could not be reconstructed and may still be live — fencing agent reservations",
    );
  }

  // No usable handoff means the previous daemon died without warning (SIGKILL), so we cannot
  // tell whether an external agent is still attached to a tab. Fencing for the grace period
  // is deliberately conservative: callers defer rather than fail, and 10 minutes is short
  // next to a 2 h reservation TTL.
  // DEBT: the fence is applied after ANY handoff-less adoption, including one where nothing
  // external was ever attached; upgrade to inspecting the adopted browser's live targets for
  // agent-surface tabs if a deferred ABVP run is ever traced to it.
  const until = Date.now() + ADOPTION_GRACE_MS;
  browserLeaseBroker.setAdoptionGrace(until, "adopted a Chrome whose external holder could not be reconstructed");
  logger.error(
    { chromePid, graceUntil: new Date(until).toISOString(), hadHandoff: Boolean(handoff?.holder) },
    "Adopted Chrome without a usable external-holder handoff — refusing new agent reservations for the grace period",
  );
}

/** Wall-clock (ms) of the most recent CDP scrape entry; 0 if none this process. */
export function getLastCdpUseAt(): number {
  return lastCdpUseAt;
}

/**
 * Serializes ALL launch/recycle operations so concurrent callers can never
 * double-launch Chrome or race to bind :9222. A simple promise chain: each op
 * runs only after the previous settles (success or failure).
 */
let cdpOpLock: Promise<unknown> = Promise.resolve();
/**
 * Count of exclusive CDP ops queued or running. Incremented SYNCHRONOUSLY when an
 * op is enqueued so the unlocked fast path in ensureCDP can bail the instant a
 * teardown/recycle is pending — otherwise a fast-path caller could hand back a
 * live handle to a Chrome that teardown has already begun killing.
 */
let cdpExclusiveOps = 0;
function withCdpLock<T>(fn: () => Promise<T>): Promise<T> {
  cdpExclusiveOps++;
  const run = cdpOpLock.then(fn, fn).finally(() => { cdpExclusiveOps--; }); // run regardless of prior op's outcome
  cdpOpLock = run.then(() => undefined, () => undefined); // never let a rejection break the chain
  return run;
}

/**
 * Ensure a CDP endpoint is available on the given port.
 * Returns a handle with a cleanup function.
 */
async function isHeadless(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const resp = await fetch(`http://localhost:${port}/json/version`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return false;
    const data = (await resp.json()) as { "User-Agent"?: string };
    return /HeadlessChrome/i.test(data["User-Agent"] ?? "");
  } catch {
    return false;
  }
}

/**
 * Count type=page targets on /json/list. Version-up alone is not attachable —
 * agent-browser connect times out when the list is empty (delta-upgrade-watch
 * 2026-07-27). Probe failure returns null so callers can fail closed.
 */
async function countCdpPageTargets(port: number): Promise<number | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const resp = await fetch(`http://localhost:${port}/json/list`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const list = (await resp.json()) as unknown;
    if (!Array.isArray(list)) return null;
    return list.filter(
      (t): t is { type?: string } =>
        typeof t === "object" &&
        t !== null &&
        (t as { type?: unknown }).type === "page",
    ).length;
  } catch {
    return null;
  }
}

/**
 * When Chrome answers /json/version but has EXACTLY zero page targets, seed
 * about:blank via PUT /json/new (GET is rejected). An unreadable list (null) is
 * transient, and probeCdp's contract holds a mutating consumer to sparing it —
 * so report false without seeding rather than PUT blind at a browser whose real
 * target count we do not know. Returns true if ≥1 page target exists after.
 */
async function ensurePageTarget(port: number): Promise<boolean> {
  const existing = await countCdpPageTargets(port);
  if (existing == null) {
    logger.warn({ port }, "CDP page-target list unreadable — not seeding");
    return false;
  }
  if (existing > 0) return true;

  logger.warn(
    { port, pages: existing },
    "CDP has no page targets — seeding about:blank via /json/new",
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const resp = await fetch(`http://localhost:${port}/json/new?about:blank`, {
      method: "PUT",
      signal: controller.signal,
    });
    if (!resp.ok) {
      logger.warn({ port, status: resp.status }, "PUT /json/new failed");
      return false;
    }
  } catch (err) {
    logger.warn(
      { port, error: err instanceof Error ? err.message : String(err) },
      "PUT /json/new threw",
    );
    return false;
  } finally {
    clearTimeout(timer);
  }

  const after = await countCdpPageTargets(port);
  return after != null && after > 0;
}

export type CdpProbeState = "absent" | "ready" | "empty";
export interface CdpProbe {
  state: CdpProbeState;
  pages: number;
  /** Set ONLY when a listener answered /json/version but its list was unreadable. */
  reason?: string;
}

/**
 * The one read-only CDP state probe. Shared by chrome-launcher, the cleanup
 * scheduler and the health check so those three policies cannot drift apart again:
 *   absent — nothing LISTENs (healthy for an on-demand browser)
 *   ready  — /json/version answers AND ≥1 attachable page target
 *   empty  — a listener with no page target, or a list we could not read
 * A destructive consumer (cleanup) must spare on `reason` — an unreadable list is
 * transient and reaping on it kills healthy sessions. A reporting consumer
 * (health) may fold it into unhealthy. Never mutates browser state.
 */
export async function probeCdp(port: number = CDP_PORT): Promise<CdpProbe> {
  if (!(await isCDPAvailable(port))) return { state: "absent", pages: 0 };
  const pages = await countCdpPageTargets(port);
  if (pages == null) return { state: "empty", pages: 0, reason: "list probe failed" };
  return { state: pages > 0 ? "ready" : "empty", pages };
}

/**
 * PURE readiness probe: version listens AND at least one page target. Never
 * mutates browser state — seeding/healing (ensurePageTarget) belongs under
 * withCdpLock only, so two unlocked callers can't both PUT /json/new.
 */
async function isCDPReady(port: number): Promise<boolean> {
  return (await probeCdp(port)).state === "ready";
}

export interface EnsureCDPOptions {
  port?: number;
  /** Force headed Chrome (avoids HeadlessChrome UA that triggers bot detection). */
  headed?: boolean;
}

export async function ensureCDP(opts: EnsureCDPOptions = {}): Promise<CDPHandle> {
  const port = opts.port ?? CDP_PORT;
  const forceHeaded = opts.headed ?? false;
  // Stamp scrape activity BEFORE anything else so an idle-teardown that re-checks
  // this under the CDP lock can never reap a session a scrape just started using.
  lastCdpUseAt = Date.now();

  // Fast (unlocked) path — only the clean reuse case: a READY CDP (version + ≥1
  // page target) that already satisfies the headed requirement. Empty /json/list
  // is not ready — agent-browser connect will time out. Return a NON-OWNING handle
  // (pid:0, no-op cleanup): callers use pid>0 to mean "I launched this, so I clean
  // it up", so reusers must never tear down the shared live :9222 session. Anything
  // that might MUTATE state (launch, or a headless→headed upgrade) is decided under
  // the lock below so concurrent callers can't double-launch or double-recycle.
  // Skip the fast path entirely while any exclusive op (teardown/recycle/launch)
  // is queued or running: the live endpoint it would hand back may be mid-kill.
  // DEBT: ensureCDP() returns a readiness snapshot, not a usage lease; upgrade when
  // recycleSession() gains a live call site or any CDP consumer stops using withScrapeLock().
  if (cdpExclusiveOps === 0 && (await isCDPReady(port)) && !(forceHeaded && (await isHeadless(port)))) {
    // Recheck AFTER the awaits: an exclusive op may have been enqueued while we probed.
    if (cdpExclusiveOps === 0) {
      logger.debug({ port }, "CDP already available");
      return { pid: 0, cleanup: () => {} };
    }
  }

  // Resident mode owns all launches; legacy temp-profile creation remains only
  // for the step-7 post-soak deletion gate and must not race the supervisor.
  if (residentChromeSupervisor.isActive()) {
    if (await waitForCDP(port)) return { pid: 0, cleanup: () => {} };
    throw new Error(`Resident Chrome supervisor did not make CDP ready on port ${port}`);
  }

  // Serialize all launches/upgrades through the CDP op lock so two concurrent
  // callers (e.g. content-scraper + ingest) can't double-launch / double-recycle.
  return withCdpLock(async () => {
    // Re-check inside the lock: a queued op may have already brought CDP up (and
    // possibly already upgraded it to headed).
    if (await isCDPAvailable(port)) {
      // Heal empty-target zombies before handing the port to agent-browser.
      // If seeding fails on a Homer-owned listener, recycle; never spawn a second
      // Chrome against an occupied :9222.
      if (!(await ensurePageTarget(port))) {
        const ours = getListeningPids(port).some((pid) => isHomerCDPChrome(getCmdline(pid)));
        if (ours) {
          logger.warn({ port }, "Empty CDP targets and /json/new failed — recycling Homer Chrome");
          return recycleLocked(port, forceHeaded || !(await isHeadless(port)));
        }
        // Fail closed: handing back an empty non-Homer listener only defers the
        // failure to agent-browser connect (and a costly failure takeover).
        throw new Error("CDP listener not Homer-owned and has no attachable page target");
      }
      if (!(forceHeaded && (await isHeadless(port)))) {
        return { pid: 0, cleanup: () => {} };
      }
      // Headed required but the live endpoint is headless. Only an explicit
      // recycle may tear down a live listener, and only if it is OURS. A non-Homer
      // headless listener is reused as-is and never killed.
      const ours = getListeningPids(port).some((pid) => isHomerCDPChrome(getCmdline(pid)));
      if (!ours) {
        logger.warn({ port }, "Live headless CDP is not Homer-owned — reusing without kill");
        return { pid: 0, cleanup: () => {} };
      }
      logger.info({ port }, "Upgrading Homer headless CDP to headed");
      // We already hold the lock — recycle inline (recycleLocked), never the
      // locking recycleSession (that would deadlock).
      return recycleLocked(port, true);
    }
    return launchCDP(port, forceHeaded);
  });
}

/** Launch a CDP Chrome (headless-first, headed fallback) and track the handle. */
async function launchCDP(port: number, forceHeaded: boolean): Promise<CDPHandle> {
  // Never spawn a racing Chrome against a port that is already serving CDP —
  // that produced false "headed-ready" handles. Headed-upgrade of our own
  // headless instance is handled in ensureCDP via the sanctioned recycleSession.
  if (await isCDPAvailable(port)) {
    if (!(await ensurePageTarget(port))) {
      throw new Error(`CDP listener appeared on port ${port} with no attachable page target`);
    }
    logger.debug({ port }, "CDP already available at launch time — reusing without spawning");
    return { pid: 0, cleanup: () => {} };
  }

  if (!forceHeaded) {
    logger.info({ port }, "Launching headless Chrome with CDP");
    try {
      const handle = await launchChrome(port, true);
      if (await waitForCDP(port)) {
        logger.info({ pid: handle.pid, port }, "Headless Chrome CDP ready");
        activeCDPHandle = handle;
        return handle;
      }
      handle.cleanup();
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, "Headless Chrome launch failed");
    }
  }

  logger.info({ port, forced: forceHeaded }, "Launching headed Chrome with CDP");
  const handle = await launchChrome(port, false);
  if (await waitForCDP(port)) {
    logger.info({ pid: handle.pid, port }, "Headed Chrome CDP ready");
    activeCDPHandle = handle;
    return handle;
  }

  handle.cleanup();
  throw new Error(`Failed to launch Chrome with CDP on port ${port}`);
}

/**
 * PIDs LISTENing on the CDP port — NOT clients merely connected to it.
 * Using `-sTCP:LISTEN` is critical: a bare `lsof -ti :port` also returns the
 * agent-browser client and health probes, which must never be killed.
 */
function getListeningPids(port: number): number[] {
  try {
    const output = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { encoding: "utf-8" }).trim();
    return output.split("\n").filter(Boolean).map(Number).filter((n) => Number.isFinite(n) && n > 1);
  } catch {
    return []; // lsof exits non-zero when nothing is listening
  }
}

/** Command line of a pid, or "" if it can't be read. */
function getCmdline(pid: number): string {
  try {
    return execSync(`ps -ww -o command= -p ${pid}`, { encoding: "utf-8", timeout: 2_000 }).trim();
  } catch {
    return "";
  }
}

/** True only for a Homer-spawned CDP Chrome (our temp profile), never arbitrary user Chrome. */
function isHomerCDPChrome(cmdline: string): boolean {
  return cmdline.includes("Google Chrome") && cmdline.includes(`--user-data-dir=${CDP_PROFILE_PREFIX}`);
}

async function killCDPOnPort(port: number, signal: NodeJS.Signals = "SIGTERM"): Promise<boolean> {
  const pids = getListeningPids(port);
  let signalledOurs = false;
  for (const pid of pids) {
    // Only kill if the listener is one of ours — never the user's primary Chrome.
    if (!isHomerCDPChrome(getCmdline(pid))) {
      logger.warn({ port, pid }, "Listener on CDP port is not a Homer CDP Chrome — refusing to kill");
      continue;
    }
    try {
      process.kill(pid, signal);
      signalledOurs = true;
    } catch {
      // Already dead
    }
  }
  // Wait for the port to free up.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await isCDPAvailable(port))) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  // Escalate to SIGKILL once if SIGTERM didn't free our own listener — this is
  // what prevents recycleSession from looping forever on a stuck Chrome.
  if (signal === "SIGTERM" && signalledOurs) {
    logger.warn({ port }, "CDP Chrome survived SIGTERM — escalating to SIGKILL");
    return killCDPOnPort(port, "SIGKILL");
  }
  logger.warn({ port }, "Port still occupied after killing CDP Chrome");
  return !(await isCDPAvailable(port));
}

/**
 * True when /json/version answers — means something is LISTENing as CDP.
 * Does NOT imply agent-browser can attach (see isCDPReady / ensurePageTarget).
 * Keep this version-only for kill/port-occupancy checks.
 */
async function isCDPAvailable(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const resp = await fetch(`http://localhost:${port}/json/version`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

/** Wait until CDP is attachable: version up + ≥1 page target (seed if needed). */
async function waitForCDP(port: number): Promise<boolean> {
  const deadline = Date.now() + CDP_POLL_MAX_MS;
  while (Date.now() < deadline) {
    if (await isCDPAvailable(port)) {
      if (await ensurePageTarget(port)) return true;
    }
    await new Promise((r) => setTimeout(r, CDP_POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Materialize a LEAN copy of the user's Chrome profile — just enough to carry
 * logged-in sessions (cookies + auth-adjacent local storage), NOT the whole
 * ~5.7 GB profile. Cookies are copied via SQLite online backup so the snapshot
 * is consistent even while the primary Chrome is running (WAL mode). Source is
 * read-only throughout; the user's primary profile is never mutated.
 */
async function materializeLeanProfile(tempDir: string): Promise<void> {
  const srcDefault = join(PROFILE_SOURCE, "Default");
  const dstDefault = join(tempDir, "Default");
  mkdirSync(join(dstDefault, "Network"), { recursive: true });

  // Best-effort single-file copy that never throws — used for non-critical
  // metadata so it can't abort the function before the cookie backup.
  const copyBestEffort = (src: string, dst: string, label: string) => {
    try {
      if (existsSync(src)) copyFileSync(src, dst);
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err), label }, "Lean profile: best-effort copy failed");
    }
  };

  // Cookies FIRST — the critical login artifact, copied before any best-effort
  // surface so nothing can abort the function before cookies are materialized.
  // SQLite backup gives a consistent snapshot even while the primary Chrome is
  // running (WAL).
  //
  // Chrome 150+ prefers Default/Network/Cookies. If we only seed the legacy
  // Default/Cookies path, Chromium creates an empty Network/Cookies on launch
  // and ignores the legacy DB → every scrape starts logged-out. Always seed
  // Network/Cookies (and mirror to Default/Cookies for older readers).
  const cookieSources = [
    join(srcDefault, "Network", "Cookies"),
    join(srcDefault, "Cookies"),
  ];
  const cookieDests = [
    join(dstDefault, "Network", "Cookies"),
    join(dstDefault, "Cookies"),
  ];
  let copiedCookies = false;
  for (const src of cookieSources) {
    if (!existsSync(src)) continue;
    try {
      const db = new Database(src, { readonly: true, fileMustExist: true, timeout: 5_000 });
      try {
        // Backup once into Network/Cookies (preferred), then mirror the file.
        mkdirSync(dirname(cookieDests[0]!), { recursive: true });
        await db.backup(cookieDests[0]!);
        mkdirSync(dirname(cookieDests[1]!), { recursive: true });
        copyFileSync(cookieDests[0]!, cookieDests[1]!);
        copiedCookies = true;
      } finally {
        db.close();
      }
      break;
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err), src }, "Cookie DB backup failed — trying next candidate");
    }
  }
  if (!copiedCookies) {
    logger.warn({ source: srcDefault }, "No Chrome cookie DB copied for lean profile — scrapes may be logged out");
  }

  // Metadata (best-effort, after cookies). Local State carries profile/key
  // metadata; Preferences avoids a "new profile" reset.
  copyBestEffort(join(PROFILE_SOURCE, "Local State"), join(tempDir, "Local State"), "Local State");
  copyBestEffort(join(srcDefault, "Preferences"), join(dstDefault, "Preferences"), "Preferences");

  // Login Data — saved passwords for autofill re-login when cookies expire.
  // Same best-effort pattern as Preferences; journal companions if present.
  for (const name of ["Login Data", "Login Data For Account"] as const) {
    copyBestEffort(join(srcDefault, name), join(dstDefault, name), name);
    copyBestEffort(join(srcDefault, `${name}-journal`), join(dstDefault, `${name}-journal`), `${name}-journal`);
  }

  // Local Storage (LevelDB) — best-effort. Some SPAs keep auth/session tokens
  // here, but a copy failure must NOT discard the cookie backup above.
  const lsSrc = join(srcDefault, "Local Storage");
  if (existsSync(lsSrc)) {
    try {
      cpSync(lsSrc, join(dstDefault, "Local Storage"), {
        recursive: true,
        filter: (p) => { const n = p.split("/").at(-1); return n !== "LOCK" && n !== "LOG" && n !== "LOG.old"; },
      });
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, "Lean profile: Local Storage copy failed (cookies still copied)");
    }
  }
}

async function launchChrome(port: number, headless: boolean): Promise<CDPHandle> {
  const tempDir = `${CDP_PROFILE_PREFIX}${Date.now()}`;
  mkdirSync(tempDir, { recursive: true });

  // Lean profile copy (login state only) — replaces the old full ~5.7 GB clone.
  try {
    await materializeLeanProfile(tempDir);
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, "Failed to create lean Chrome profile, launching with empty profile");
  }

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${tempDir}`,
    "--profile-directory=Default",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-extensions", // lean profile carries no extensions
    "about:blank", // always seed a page target so /json/list is never []
  ];

  if (headless) {
    args.unshift("--headless=new");
  }

  const proc: ChildProcess = spawn(CHROME_PATH, args, {
    stdio: "ignore",
    detached: true,
  });

  proc.unref();

  const pid = proc.pid ?? 0;

  // Register with process lifecycle for daemon shutdown
  if (pid) {
    processRegistry.register(proc, {
      command: "chrome-cdp",
      type: "utility",
      timeoutMs: 0, // No timeout — lives until cleanup
      source: "cli-runner",
      detached: true,
    });
  }

  const cleanup = () => {
    if (activeCDPHandle?.pid === pid) activeCDPHandle = undefined;
    try {
      if (pid) process.kill(pid, "SIGTERM");
    } catch {
      // Already dead
    }
    // Give Chrome a moment to shut down before removing profile
    setTimeout(() => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best effort
      }
    }, 2_000);
  };

  return { pid, userDataDir: tempDir, cleanup };
}

/** Wait until nothing is LISTENing on the port (Chrome fully released it). */
async function waitForPortClosed(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isCDPAvailable(port)) && getListeningPids(port).length === 0) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  logger.warn({ port }, "CDP port did not fully close within timeout");
}

/**
 * Cleanly tear down the current CDP Chrome and relaunch a fresh lean session.
 * Kills only the live listener (verified to be ours via killCDPOnPort), waits for
 * the port to close, removes the old temp profile, then relaunches and verifies CDP.
 * Callers owning the agent-browser socket must re-`connect` after this.
 *
 * NOTE: this is the SANCTIONED exception to the "never kill the live :9222" rule.
 * The cleanup scheduler must never kill the live session; an explicit, caller-
 * initiated recycle is the only path allowed to tear it down (to relaunch lean).
 */
export async function recycleSession(opts: EnsureCDPOptions = {}): Promise<CDPHandle> {
  if (residentChromeSupervisor.isActive()) {
    throw new Error("recycleSession is disabled while resident Chrome supervision is active");
  }
  const port = opts.port ?? CDP_PORT;
  const headed = opts.headed ?? true;
  lastCdpUseAt = Date.now();
  // Acquire the shared lock so a recycle can't race a concurrent ensureCDP launch
  // or another recycle (both would otherwise double-launch Chrome).
  return withCdpLock(() => recycleLocked(port, headed));
}

/**
 * Recycle implementation. ASSUMES the caller already holds the CDP op lock
 * (recycleSession wraps it; ensureCDP's in-lock headed-upgrade calls it directly).
 * Never acquires the lock itself and never calls ensureCDP — so there is no
 * recursion or deadlock path.
 */
/**
 * Tear down the current CDP Chrome WITHOUT relaunching. Kills only the verified
 * Homer listener via killCDPOnPort (cmdline-checked) — deliberately NOT a blind
 * process.kill on activeCDPHandle.pid, which could hit a reused PID if the handle
 * is stale. Then waits for the port to close, unregisters the tracked record, and
 * removes the temp profile dir. ASSUMES the caller already holds the CDP op lock.
 */
async function teardownLocked(port: number): Promise<void> {
  const old = activeCDPHandle;
  activeCDPHandle = undefined;

  await killCDPOnPort(port); // cmdline-verified; escalates to SIGKILL if needed
  await waitForPortClosed(port, 10_000);

  if (old?.pid) {
    try {
      processRegistry.unregister(old.pid);
    } catch {
      // Best effort — the orphan scan settles stale records anyway.
    }
  }
  if (old?.userDataDir) {
    try {
      rmSync(old.userDataDir, { recursive: true, force: true });
    } catch {
      // Best effort — the scheduler sweep will catch it later.
    }
  }
}

async function recycleLocked(port: number, headed: boolean): Promise<CDPHandle> {
  await teardownLocked(port);

  // Fail loudly rather than recurse: if the port is STILL serving after the
  // kill+wait, do NOT relaunch — abort so we never spawn a racing Chrome.
  if (await isCDPAvailable(port)) {
    throw new Error(`recycleSession: port ${port} still occupied after kill — aborting to avoid relaunch race`);
  }

  return launchCDP(port, headed);
}

/**
 * Launch a dedicated lean-profile Chrome on its OWN port for jobs that must not
 * contend for the broker's globally serialized shared-:9222 agent lease (a
 * long-running agent.* collector otherwise blocks them entirely). The caller
 * owns the returned handle and MUST call cleanup() — this Chrome is never
 * supervised, never adopted by the resident supervisor, and never touches
 * activeCDPHandle. A leftover Homer-owned listener on the port (crashed prior
 * run) is killed first; a non-Homer listener aborts the launch.
 */
export async function launchIsolatedCdp(port: number, opts: { headed?: boolean } = {}): Promise<CDPHandle> {
  if (port === CDP_PORT) throw new Error("launchIsolatedCdp must not target the shared CDP port");
  const headed = opts.headed ?? true;
  return withCdpLock(async () => {
    if (await isCDPAvailable(port)) {
      logger.warn({ port }, "Isolated CDP port occupied — recycling leftover Homer Chrome");
      if (!(await killCDPOnPort(port))) {
        throw new Error(`isolated CDP port ${port} is occupied by a non-Homer listener`);
      }
      await waitForPortClosed(port, 10_000);
    }
    const handle = await launchChrome(port, !headed);
    if (!(await waitForCDP(port))) {
      handle.cleanup();
      throw new Error(`isolated Chrome did not become CDP-ready on port ${port}`);
    }
    return handle;
  });
}

/**
 * Tear down the live CDP Chrome IF it has been idle (no scrape) for at least
 * idleThresholdMs — the cleanup scheduler's one sanctioned reaper for a session
 * whose tabs have piled up. Re-checks idleness INSIDE the lock to close the race
 * with a scrape that stamped lastCdpUseAt after the scheduler's cheap pre-check
 * but before we acquired the lock. Lazy relaunch: the next ensureCDP() brings a
 * fresh lean instance back on demand (cookies are re-materialized every launch,
 * so lost warmth is cheap). Returns the outcome for the scheduler's audit log.
 */
export async function teardownIdleSession(
  idleThresholdMs: number,
  port: number = CDP_PORT,
): Promise<"torn-down" | "busy" | "absent" | "survived"> {
  return withCdpLock(async () => {
    if (!(await isCDPAvailable(port))) return "absent";
    if (Date.now() - lastCdpUseAt < idleThresholdMs) return "busy";
    await teardownLocked(port);
    // Confirm the port actually closed. If a wedged Chrome outlived even SIGKILL,
    // report "survived" rather than mislogging a phantom reclaim — the endpoint is
    // still usable so the next ensureCDP reuses it, and the next cycle retries.
    return (await isCDPAvailable(port)) ? "survived" : "torn-down";
  });
}
