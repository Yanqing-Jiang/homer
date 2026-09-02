/**
 * The supervisor's singleton-forward recovery, driven entirely by fake deps.
 * No Chrome is spawned, no port is bound, no pid is signalled.
 *
 * The shape under test is the 2026-09-01 loop: launch → child exits in ~170ms → :9222
 * still answers → decide. Before the fix the only outcome was "schedule another restart",
 * which is what produced 63 restarts in 70 minutes.
 */
import "../helpers/no-telegram.js";
import assert from "node:assert/strict";
import test from "node:test";
import { ResidentChromeSupervisor, type ResidentChromeChild } from "../../src/scraping/chrome-launcher.js";
import type { PortOwner, SingletonEnvironment } from "../../src/scraping/chrome-orphan.js";

const OURS: PortOwner = { kind: "ours", pid: 2876, ppid: 1, parentAlive: false, parentIsSelf: false, command: "Google Chrome" };
const OURS_LIVE_PARENT: PortOwner = { kind: "ours", pid: 2876, ppid: 2818, parentAlive: true, parentIsSelf: false, command: "Google Chrome" };
/** F8: a survivor THIS daemon spawned and no longer tracks — parent alive, and it is us. */
const OURS_IN_PLACE: PortOwner = { kind: "ours", pid: 2876, ppid: process.pid, parentAlive: true, parentIsSelf: true, command: "Google Chrome" };
const FOREIGN: PortOwner = { kind: "foreign", pid: 700, command: "Google Chrome (user profile)" };

class FakeChild implements ResidentChromeChild {
  pid = 93065;
  killed: NodeJS.Signals[] = [];
  private listeners: Array<() => void> = [];
  once(_event: "exit" | "error", listener: () => void): unknown {
    this.listeners.push(listener);
    return this;
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(signal);
    return true;
  }
  fireExit(): void {
    for (const l of [...this.listeners]) l();
  }
}

interface Harness {
  supervisor: ResidentChromeSupervisor;
  /** The FIRST child spawned. */
  child: FakeChild;
  /** The child spawned most recently (a relaunch replaces it). */
  current(): FakeChild | undefined;
  timers: Array<{ callback: () => void; delayMs: number }>;
  terminated: number[];
  adopted: number[];
  handoffs: number;
  cleanLaunches: number;
  handoffKinds: string[];
  spawns: number;
  /** drainLeases() calls — a drain force-clears QC's lease after 10 s, so "lease intact" means zero. */
  drains: number;
  setExternalLeases(n: number): void;
}

function harness(opts: {
  owner: PortOwner;
  env: SingletonEnvironment;
  terminateOutcome?: "terminated" | "killed" | "alive";
  omitInspectors?: boolean;
  externalLeases?: number;
  probeState?: "ready" | "empty" | "absent";
  probeReason?: string;
}): Harness {
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  const terminated: number[] = [];
  const adopted: number[] = [];
  const handoffs = { count: 0 };
  const cleanLaunches = { count: 0 };
  const handoffKinds: string[] = [];
  const state = { child: undefined as FakeChild | undefined, spawns: 0, drains: 0, externalLeases: opts.externalLeases ?? 0 };
  const supervisor = new ResidentChromeSupervisor({
    spawnChrome: () => { state.spawns++; state.child = new FakeChild(); state.child.pid = 93065 + state.spawns - 1; return state.child; },
    // Adopted Chrome looks healthy to the probe.
    probe: async () => ({
      state: opts.probeState ?? "ready",
      pages: opts.probeState === "absent" || opts.probeState === "empty" ? 0 : 1,
      ...(opts.probeReason ? { reason: opts.probeReason } : {}),
    }),
    cdpPortOccupied: async () => true,
    ensureProfile: () => {},
    nextGeneration: () => 160,
    drainLeases: async () => { state.drains++; },
    inspectOwner: opts.omitInspectors ? undefined : () => opts.owner,
    singletonEnvironment: opts.omitInspectors ? undefined : async () => opts.env,
    terminateOrphan: async (pid) => { terminated.push(pid); return opts.terminateOutcome ?? "terminated"; },
    externalLeases: () => state.externalLeases,
    onLeaveForAdoption: (kind: string) => { handoffs.count++; handoffKinds.push(kind); },
    onCleanLaunch: () => { cleanLaunches.count++; },
    onAdopt: (pid) => { adopted.push(pid); },
    setTimer: (callback, delayMs) => { timers.push({ callback, delayMs }); return timers.length as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: () => {},
    heartbeatMs: 60_000,
    backoffMs: [2_000],
  });
  supervisor.start();
  return {
    supervisor, child: state.child!, current: () => state.child, timers, terminated, adopted,
    get handoffs() { return handoffs.count; },
    get cleanLaunches() { return cleanLaunches.count; },
    handoffKinds,
    get spawns() { return state.spawns; },
    get drains() { return state.drains; },
    setExternalLeases(n: number) { state.externalLeases = n; },
  };
}

/** Let the promise chain inside settleFastExit / resolveSingletonForward settle. */
const settle = () => new Promise<void>((r) => setImmediate(r));

test("a healthy orphan holding the profile lock is adopted, not fought", async () => {
  const h = harness({ owner: OURS, env: { cdpHealthy: true, profileLockPid: 2876 } });
  h.child.fireExit();
  await settle();
  await settle();

  const status = h.supervisor.status();
  assert.equal(status.ownership, "adopted");
  assert.equal(status.chromePid, 2876, "status reports the adopted pid");
  assert.equal(h.supervisor.launchedChromePid(), null, "we did not launch it, so we do not own it");
  assert.equal(h.terminated.length, 0, "an adoptable orphan is never signalled");
  // M8: the external holder must be re-derived, or the broker believes nothing holds a
  // browser QC's agent-browser may still be driving.
  assert.deepEqual(h.adopted, [2876], "the adoption hook fired so the external holder is restored or fenced");
  // Only the heartbeat timer — no restart was scheduled, which is what broke the loop.
  assert.deepEqual(h.timers.map((t) => t.delayMs), [60_000]);
});

test("an orphan we cannot verify is terminated with a bounded wait, then relaunched", async () => {
  const h = harness({ owner: OURS, env: { cdpHealthy: true, profileLockPid: 9999 } });
  h.child.fireExit();
  await settle();
  await settle();

  assert.deepEqual(h.terminated, [2876]);
  assert.equal(h.supervisor.status().ownership, "none");
  assert.ok(h.timers.some((t) => t.delayMs === 2_000), "a relaunch is scheduled after the orphan is gone");
});

test("an orphan that survives even SIGKILL is reported as foreign rather than assumed dead", async () => {
  const h = harness({ owner: OURS, env: { cdpHealthy: true, profileLockPid: 9999 }, terminateOutcome: "alive" });
  h.child.fireExit();
  await settle();
  await settle();

  assert.deepEqual(h.terminated, [2876]);
  assert.equal(h.supervisor.status().ownership, "foreign");
});

test("a Chrome on someone else's profile is never signalled", async () => {
  const h = harness({ owner: FOREIGN, env: { cdpHealthy: true, profileLockPid: 700 } });
  h.child.fireExit();
  await settle();
  await settle();

  assert.deepEqual(h.terminated, [], "a foreign Chrome is never terminated");
  assert.equal(h.supervisor.status().ownership, "foreign");
});

test("without owner inspection the supervisor falls back to the old restart behaviour", async () => {
  const h = harness({ owner: OURS, env: { cdpHealthy: true, profileLockPid: 2876 }, omitInspectors: true });
  h.child.fireExit();
  await settle();
  await settle();

  assert.deepEqual(h.terminated, []);
  assert.ok(h.timers.some((t) => t.delayMs === 2_000));
});

// The review's coverage gap: our profile, but a live parent still owns it.
test("our Chrome under a live parent is left alone and only retried", async () => {
  const h = harness({ owner: OURS_LIVE_PARENT, env: { cdpHealthy: true, profileLockPid: 2876 } });
  h.child.fireExit();
  await settle();
  await settle();

  assert.deepEqual(h.terminated, [], "another live daemon generation is never signalled");
  assert.deepEqual(h.adopted, [], "and never adopted out from under it");
  assert.equal(h.supervisor.status().ownership, "foreign");
  assert.ok(h.timers.some((t) => t.delayMs === 2_000));
});

// ------------------------------------------------------- H2: deliberate shutdown

test("a deliberate stop kills the Chrome we launched when no external lease is live", () => {
  const h = harness({ owner: OURS, env: { cdpHealthy: true, profileLockPid: 2876 }, externalLeases: 0 });
  h.supervisor.stop();
  assert.deepEqual(h.child.killed, ["SIGTERM"]);
  assert.equal(h.handoffs, 0);
});

// This is the case that made `npm run restart` end the 4,471-query QC backfill.
test("a deliberate stop LEAVES Chrome for adoption while an external lease is live", () => {
  const h = harness({ owner: OURS, env: { cdpHealthy: true, profileLockPid: 2876 }, externalLeases: 1 });
  h.supervisor.stop();
  assert.deepEqual(h.child.killed, [], "the QC backfill keeps its browser");
  assert.equal(h.handoffs, 1, "and the reservation is handed to the next generation");
});

test("a crash-path markLeaveForAdoption still wins over the later shutdown task", () => {
  const h = harness({ owner: OURS, env: { cdpHealthy: true, profileLockPid: 2876 }, externalLeases: 0 });
  h.supervisor.markLeaveForAdoption();
  h.supervisor.stop();
  assert.deepEqual(h.child.killed, []);
});

test("stopping twice, or with no child, signals nothing", () => {
  const h = harness({ owner: OURS, env: { cdpHealthy: true, profileLockPid: 2876 }, externalLeases: 0 });
  h.supervisor.stop();
  h.supervisor.stop();
  assert.deepEqual(h.child.killed, ["SIGTERM"], "idempotent");
});

// ------------------------------------------------------- N7 / F8: restart path

/**
 * The production trigger: three consecutive heartbeat failures while Chrome is STILL
 * answering /json/version but its target list is unreadable, during a live QC backfill.
 * N7 stopped the SIGTERM; F8 stops the relaunch too — the relaunch was forwarded into the
 * surviving Chrome (parented by this very daemon) and could never be adopted, so it looped
 * restart → forward → leave-live-owner → restart until the flap breaker parked the
 * supervisor in maintenance, and the first drain had force-cleared QC's lease on the way.
 */
test("F8: three failed /json/list heartbeats under a live external lease change NOTHING — no kill, no relaunch, no drain, no maintenance", async () => {
  const h = harness({
    owner: OURS, env: { cdpHealthy: true, profileLockPid: 2876 },
    externalLeases: 1, probeState: "empty", probeReason: "list probe failed",
  });
  for (let i = 0; i < 3; i++) await h.supervisor.heartbeatNow();
  await settle();
  await settle();

  assert.deepEqual(h.child.killed, [], "the QC backfill keeps its browser");
  assert.equal(h.spawns, 1, "no relaunch — a relaunch is forwarded into the same Chrome and buys nothing");
  assert.equal(h.drains, 0, "lease intact — nothing force-clears QC's lease");
  assert.equal(h.handoffs, 0, "no handoff — nothing is going to adopt anything within this generation");
  assert.deepEqual(h.timers.map((t) => t.delayMs), [60_000], "only the heartbeat timer, no restart timer");
  const status = h.supervisor.status();
  assert.equal(status.ownership, "launched");
  assert.equal(status.chromePid, h.child.pid, "the child stays tracked");
  assert.equal(status.cdp.restartDeferrals, 1, "the deferral is visible in status");
  assert.equal(status.maintenance.enabled, false);
});

test("F8: repeated deferrals never accumulate into the flap breaker", async () => {
  const h = harness({
    owner: OURS, env: { cdpHealthy: true, profileLockPid: 2876 },
    externalLeases: 1, probeState: "empty", probeReason: "list probe failed",
  });
  for (let cycle = 0; cycle < 8; cycle++) {
    for (let i = 0; i < 3; i++) await h.supervisor.heartbeatNow();
    await settle();
    await settle();
  }
  assert.equal(h.supervisor.maintenance().enabled, false, "eight deferrals in a row are a wait, not a flap");
  assert.equal(h.spawns, 1);
  assert.equal(h.drains, 0);
  assert.deepEqual(h.child.killed, []);
  assert.equal(h.supervisor.status().cdp.restartDeferrals, 8);
});

test("F8: once the external holder is gone the deferred restart proceeds as a kill + relaunch", async () => {
  const h = harness({
    owner: OURS, env: { cdpHealthy: true, profileLockPid: 2876 },
    externalLeases: 1, probeState: "empty", probeReason: "list probe failed",
  });
  for (let i = 0; i < 3; i++) await h.supervisor.heartbeatNow();
  await settle();
  assert.deepEqual(h.child.killed, [], "deferred while the lease is live");

  h.setExternalLeases(0);
  for (let i = 0; i < 3; i++) await h.supervisor.heartbeatNow();
  await settle();
  await settle();
  assert.deepEqual(h.child.killed, ["SIGTERM"], "the holder released, so the flaky browser is restarted as before");
  assert.equal(h.drains, 1);
  assert.ok(h.timers.some((t) => t.delayMs === 2_000), "a relaunch is scheduled");
});

test("F8: a same-generation in-place orphan is adopted, not fought", async () => {
  const h = harness({ owner: OURS_IN_PLACE, env: { cdpHealthy: true, profileLockPid: 2876 } });
  h.child.fireExit();
  await settle();
  await settle();

  const status = h.supervisor.status();
  assert.equal(status.ownership, "adopted");
  assert.equal(status.chromePid, 2876);
  assert.deepEqual(h.terminated, []);
  assert.deepEqual(h.adopted, [2876]);
  assert.deepEqual(h.timers.map((t) => t.delayMs), [60_000], "no restart scheduled — the loop is gone");
});

test("F8 guard: a forward into the Chrome this daemon just SIGTERMed is terminated, not adopted", async () => {
  // The kill path signals child 93065; the relaunch fires before Chrome has exited, is
  // forwarded into the dying browser, and the forward resolver sees an in-place orphan
  // that is healthy and holds the lock. Adopting it would fence agent reservations for a
  // browser that is about to die.
  const dying: PortOwner = { kind: "ours", pid: 93065, ppid: process.pid, parentAlive: true, parentIsSelf: true, command: "Google Chrome" };
  const h = harness({
    owner: dying, env: { cdpHealthy: true, profileLockPid: 93065 },
    externalLeases: 0, probeState: "empty", probeReason: "list probe failed",
  });
  for (let i = 0; i < 3; i++) await h.supervisor.heartbeatNow();
  await settle();
  await settle();
  assert.deepEqual(h.child.killed, ["SIGTERM"]);
  const relaunch = h.timers.find((t) => t.delayMs === 2_000);
  assert.ok(relaunch, "a relaunch is scheduled");
  relaunch!.callback();
  await settle();
  const second = h.current();
  assert.ok(second && second !== h.child, "a new child was spawned");
  second!.fireExit(); // singleton forward into the dying 93065
  await settle();
  await settle();

  assert.deepEqual(h.terminated, [93065], "the dying Chrome is finished off");
  assert.deepEqual(h.adopted, [], "and never adopted");
  assert.equal(h.supervisor.status().ownership, "none");
});

test("a heartbeat-driven restart still kills when nothing external holds the browser", async () => {
  const h = harness({
    owner: OURS, env: { cdpHealthy: true, profileLockPid: 2876 },
    externalLeases: 0, probeState: "empty", probeReason: "list probe failed",
  });
  for (let i = 0; i < 3; i++) await h.supervisor.heartbeatNow();
  await settle();
  await settle();

  assert.deepEqual(h.child.killed, ["SIGTERM"]);
  assert.equal(h.handoffs, 0);
});

test("a restart kills even under a live lease once the CDP is truly absent", async () => {
  const h = harness({
    owner: OURS, env: { cdpHealthy: false, profileLockPid: 2876 },
    externalLeases: 2, probeState: "absent",
  });
  for (let i = 0; i < 3; i++) await h.supervisor.heartbeatNow();
  await settle();
  await settle();

  assert.deepEqual(h.child.killed, ["SIGTERM"], "a dead browser is relaunched; the holder is already broken");
  assert.equal(h.handoffs, 0);
});

// N15: a launch that comes up cleanly must drop a handoff nothing will consume.
test("a clean launch discards a stale handoff", async () => {
  const h = harness({ owner: OURS, env: { cdpHealthy: true, profileLockPid: 2876 } });
  await h.supervisor.heartbeatNow();
  assert.equal(h.cleanLaunches, 1, "reported once for the generation");
  await h.supervisor.heartbeatNow();
  assert.equal(h.cleanLaunches, 1, "and not again on every heartbeat");
});

test("an adopted Chrome is never reported as a clean launch", async () => {
  const h = harness({ owner: OURS, env: { cdpHealthy: true, profileLockPid: 2876 } });
  h.child.fireExit();
  await settle();
  await settle();
  assert.equal(h.supervisor.status().ownership, "adopted");
  assert.equal(h.cleanLaunches, 0, "the handoff must survive to be consumed by the adopt path");
});

// --------------------------------------------------------- F2 / F5 / F6 (round 3)

/**
 * F2: both exit paths used to key on a child THIS daemon spawned, so a generation running on
 * an adopted Chrome returned silently, wrote no handoff, and the generation after it adopted
 * blind. The handoff must key on the Chrome we are responsible for; only the SIGNAL is
 * restricted to one we spawned.
 */
test("a deliberate stop on an ADOPTED Chrome hands off and never signals", async () => {
  const h = harness({ owner: OURS, env: { cdpHealthy: true, profileLockPid: 2876 }, externalLeases: 0 });
  h.child.fireExit();
  await settle();
  await settle();
  assert.equal(h.supervisor.status().ownership, "adopted");

  h.supervisor.stop();
  assert.deepEqual(h.child.killed, [], "an adopted Chrome is never signalled");
  assert.equal(h.handoffs, 1, "but the next generation is no longer left blind");
  assert.deepEqual(h.handoffKinds, ["deliberate-shutdown-adopted"]);
});

test("a deliberate stop on an adopted Chrome under a live lease takes the leave-for-adoption path", async () => {
  const h = harness({ owner: OURS, env: { cdpHealthy: true, profileLockPid: 2876 }, externalLeases: 1 });
  h.child.fireExit();
  await settle();
  await settle();

  h.supervisor.stop();
  assert.deepEqual(h.child.killed, []);
  assert.deepEqual(h.handoffKinds, ["deliberate-shutdown"]);
});

// F6: the handoff kind distinguishes the exit paths a post-mortem needs to tell apart. (The
// heartbeat-restart kind is gone with F8 — a deferred restart writes no handoff.)
test("the two deliberate-shutdown handoff kinds stay distinct", async () => {
  const launched = harness({ owner: OURS, env: { cdpHealthy: true, profileLockPid: 2876 }, externalLeases: 1 });
  launched.supervisor.stop();
  assert.deepEqual(launched.handoffKinds, ["deliberate-shutdown"]);

  const adopted = harness({ owner: OURS, env: { cdpHealthy: true, profileLockPid: 2876 }, externalLeases: 0 });
  adopted.child.fireExit();
  await settle();
  await settle();
  adopted.supervisor.stop();
  assert.deepEqual(adopted.handoffKinds, ["deliberate-shutdown-adopted"]);
});

/**
 * F5 (kept): the adopt branch must not clear `restartTimestamps`, so a genuine relaunch →
 * forward → adopt → relaunch cycle (a Chrome whose /json/list is broken with NO external
 * holder, adopted from a previous generation each time) still reaches the flap breaker.
 * F8 removed the leave-and-adopt relaunch, so the cycle is driven here by the kill path.
 */
test("repeated relaunch-and-adopt cycles still reach the flap breaker", async () => {
  const h = harness({
    owner: OURS, env: { cdpHealthy: true, profileLockPid: 2876 },
    externalLeases: 0, probeState: "empty", probeReason: "list probe failed",
  });
  for (let cycle = 0; cycle < 8; cycle++) {
    for (let i = 0; i < 3; i++) await h.supervisor.heartbeatNow();
    await settle();
    await settle();
    // The scheduled relaunch is forwarded to a surviving previous-generation Chrome and adopted again.
    const timer = h.timers.filter((t) => t.delayMs !== 60_000).pop();
    if (timer) { timer.callback(); await settle(); h.current()?.fireExit(); await settle(); await settle(); }
    if (h.supervisor.maintenance().enabled) break;
  }
  assert.equal(h.supervisor.maintenance().enabled, true,
    "the breaker must still trip, or a broken /json/list with no holder loops forever");
});
