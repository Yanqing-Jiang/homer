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
import { BrowserLeaseBroker, HttpBrowserTargetClient } from "./browser-control.js";

const CDP_PORT = 9222;
const CDP_PROFILE_PREFIX = "/tmp/chrome-cdp-profile-";
export const RESIDENT_CDP_PROFILE = "/Users/yj/Library/Application Support/Homer/Chrome-CDP";
const CDP_POLL_INTERVAL_MS = 1_000;
const CDP_POLL_MAX_MS = 15_000;
const CDP_HEARTBEAT_MS = 60_000;
const CDP_RESTART_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;
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
  ensureProfile: () => void;
  nextGeneration: () => number;
  drainLeases: () => Promise<void>;
  observeTargets?: () => Promise<void>;
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  heartbeatMs: number;
  backoffMs: readonly number[];
}

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
  private transition: () => void = () => {};
  generation = 0;

  constructor(private readonly deps: ChromeSupervisorDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.launch();
    this.scheduleHeartbeat();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
    const child = this.child;
    this.child = undefined;
    child?.kill("SIGTERM");
  }

  isActive(): boolean { return this.running; }

  maintenance(): { enabled: boolean; reason: string | null } {
    return { enabled: this.maintenanceEnabled, reason: this.maintenanceReason };
  }
  setTransitionHandler(handler: () => void): void { this.transition = handler; }
  status(): { generation: number; chromePid: number | null; cdp: CdpProbe & { restartCount: number }; maintenance: { enabled: boolean; reason: string | null } } {
    return { generation: this.generation, chromePid: this.child?.pid ?? null, cdp: { ...this.lastProbe, restartCount: this.restartCount }, maintenance: this.maintenance() };
  }

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
    const result = await this.deps.probe();
    this.lastProbe = result; this.transition();
    if (result.state !== "absent" && !result.reason) {
      await this.deps.observeTargets?.();
      this.failedHeartbeats = 0;
      this.restartAttempt = 0;
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
      const child = this.deps.spawnChrome();
      this.child = child;
      this.lastProbe = { state: "empty", pages: 0, reason: "Chrome starting" }; this.transition();
      const settle = () => {
        if (this.child !== child) return;
        this.child = undefined;
        this.lastProbe = { state: "absent", pages: 0, reason: "Chrome exited" }; this.transition();
        this.scheduleRestart("unexpected child exit");
      };
      child.once("exit", settle);
      child.once("error", settle);
      logger.info({ pid: child.pid, generation: this.generation }, "Resident Chrome started");
    } catch (err) {
      logger.error({ err, generation: this.generation }, "Resident Chrome launch failed");
      this.scheduleRestart("launch failed");
    }
  }

  private scheduleRestart(reason: string): void {
    if (!this.running || this.maintenanceEnabled || this.restartTimer || this.restartDraining) return;
    this.restartDraining = true;
    void this.deps.drainLeases().catch((err) => {
      logger.warn({ err }, "Browser lease drain failed before Chrome restart");
    }).finally(() => {
      this.restartDraining = false;
      if (!this.running || this.maintenanceEnabled || this.restartTimer) return;
      const child = this.child;
      this.child = undefined;
      child?.kill("SIGTERM");
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
    "about:blank",
  ], { stdio: "ignore" }),
  probe: () => probeCdp(CDP_PORT),
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
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
  heartbeatMs: CDP_HEARTBEAT_MS,
  backoffMs: CDP_RESTART_BACKOFF_MS,
});

export function isResidentChromeSupervisionActive(): boolean {
  return residentChromeSupervisor.isActive();
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
 * When Chrome answers /json/version but has zero page targets, seed about:blank
 * via PUT /json/new (GET is rejected). Returns true if ≥1 page target exists after.
 */
async function ensurePageTarget(port: number): Promise<boolean> {
  const existing = await countCdpPageTargets(port);
  if (existing != null && existing > 0) return true;

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
