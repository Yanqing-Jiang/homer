/**
 * Orphan classification and exit-path policy for the resident Chrome.
 *
 * Fixtures only — nothing here spawns Chrome, binds :9222 or signals a real pid.
 * The cases are drawn from the 2026-09-01 outage: daemon 2818 died on a Telegram 409,
 * its Chrome 2876 (our profile, our port) survived reparented to launchd, and every
 * subsequent launch was swallowed by Chrome's ProcessSingleton.
 */
import "../helpers/no-telegram.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPortOwner,
  decideExitChromeAction,
  decideRestartChromeAction,
  decideSingletonForward,
  hasPortArg,
  hasProfileArg,
  isOurResidentChrome,
  terminatePidBounded,
  type ProcessInfo,
} from "../../src/scraping/chrome-orphan.js";

const PROFILE = "/Users/yj/Library/Application Support/Homer/Chrome-CDP";
const PORT = 9222;
const ID = { profilePath: PROFILE, port: PORT };
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function ours(pid: number, ppid: number): ProcessInfo {
  return {
    pid,
    ppid,
    command: `${CHROME} --remote-debugging-address=127.0.0.1 --remote-debugging-port=${PORT} --user-data-dir=${PROFILE} --profile-directory=Default --no-startup-window`,
  };
}

const noneAlive = () => false;
const allAlive = () => true;

test("profile argument matching respects the argument boundary", () => {
  assert.equal(hasProfileArg(`--user-data-dir=${PROFILE} --x`, PROFILE), true);
  assert.equal(hasProfileArg(`--user-data-dir=${PROFILE}`, PROFILE), true);
  // A sibling profile whose path merely starts with ours must never match.
  assert.equal(hasProfileArg(`--user-data-dir=${PROFILE}-scratch --x`, PROFILE), false);
});

test("port argument matching does not accept a longer port number", () => {
  assert.equal(hasPortArg("--remote-debugging-port=9222 --x", 9222), true);
  assert.equal(hasPortArg("--remote-debugging-port=92220", 9222), false);
});

test("only Chrome with our profile AND our port counts as ours", () => {
  assert.equal(isOurResidentChrome(ours(1, 1).command, ID), true);
  assert.equal(
    isOurResidentChrome(`${CHROME} --remote-debugging-port=9333 --user-data-dir=${PROFILE}`, ID),
    false,
    "different port",
  );
  assert.equal(
    isOurResidentChrome(`${CHROME} --remote-debugging-port=9222 --user-data-dir=/Users/yj/other`, ID),
    false,
    "different profile",
  );
  assert.equal(isOurResidentChrome("/usr/bin/python3 -m http.server 9222", ID), false, "not Chrome");
});

test("no listener classifies as none", () => {
  assert.deepEqual(classifyPortOwner([], ID, noneAlive), { kind: "none" });
});

test("a Chrome on a different profile is foreign and is never touched", () => {
  const foreign: ProcessInfo = { pid: 700, ppid: 1, command: `${CHROME} --remote-debugging-port=9222 --user-data-dir=/Users/yj/Library/Application Support/Google/Chrome` };
  const owner = classifyPortOwner([foreign], ID, noneAlive);
  assert.equal(owner.kind, "foreign");
  const decision = decideSingletonForward(owner, { cdpHealthy: true, profileLockPid: 700 });
  assert.equal(decision.action, "leave-foreign");
});

test("one foreign listener poisons a mixed set — we refuse to act", () => {
  const foreign: ProcessInfo = { pid: 800, ppid: 1, command: "/usr/bin/nc -l 9222" };
  const owner = classifyPortOwner([ours(2876, 1), foreign], ID, noneAlive);
  assert.equal(owner.kind, "foreign");
});

test("our Chrome with a dead parent and a matching profile lock is adopted", () => {
  const owner = classifyPortOwner([ours(2876, 1)], ID, noneAlive);
  assert.equal(owner.kind, "ours");
  assert.equal(owner.kind === "ours" && owner.parentAlive, false);
  const decision = decideSingletonForward(owner, { cdpHealthy: true, profileLockPid: 2876 });
  assert.equal(decision.action, "adopt");
  assert.equal(decision.pid, 2876);
});

test("an orphan whose CDP is unhealthy is terminated, not adopted", () => {
  const owner = classifyPortOwner([ours(2876, 1)], ID, noneAlive);
  const decision = decideSingletonForward(owner, { cdpHealthy: false, profileLockPid: 2876 });
  assert.equal(decision.action, "terminate");
  assert.equal(decision.pid, 2876);
  assert.match(decision.reason, /CDP endpoint is not healthy/);
});

test("an orphan the profile lock does not name is terminated", () => {
  const owner = classifyPortOwner([ours(2876, 1)], ID, noneAlive);
  assert.equal(decideSingletonForward(owner, { cdpHealthy: true, profileLockPid: 9999 }).action, "terminate");
  assert.equal(decideSingletonForward(owner, { cdpHealthy: true, profileLockPid: null }).action, "terminate");
});

test("our Chrome still parented by a live process is left alone", () => {
  const owner = classifyPortOwner([ours(2876, 2818)], ID, allAlive);
  assert.equal(owner.kind === "ours" && owner.parentAlive, true);
  const decision = decideSingletonForward(owner, { cdpHealthy: true, profileLockPid: 2876 });
  assert.equal(decision.action, "leave-live-owner");
});

test("a free port just relaunches", () => {
  assert.equal(decideSingletonForward({ kind: "none" }, { cdpHealthy: false, profileLockPid: null }).action, "relaunch");
});

// ------------------------------------------------------------- exit-path policy

test("abnormal exit with no live external lease kills the Chrome this daemon launched", () => {
  const d = decideExitChromeAction({ deliberate: false, chromePid: 2876, externalLeases: 0 });
  assert.equal(d.action, "kill");
});

test("abnormal exit with a live external lease leaves Chrome for adoption", () => {
  const d = decideExitChromeAction({ deliberate: false, chromePid: 2876, externalLeases: 1 });
  assert.equal(d.action, "leave-for-adoption");
  assert.match(d.reason, /adoption/);
});

test("nothing to reap when this daemon launched no Chrome (e.g. it adopted one)", () => {
  assert.equal(decideExitChromeAction({ deliberate: false, chromePid: null, externalLeases: 0 }).action, "none");
  assert.equal(decideExitChromeAction({ deliberate: false, chromePid: null, externalLeases: 3 }).action, "none");
});

// H2: this is the case that made a plain `npm run restart` end the QC backfill.
test("a DELIBERATE shutdown also leaves Chrome for adoption when an external lease is live", () => {
  const d = decideExitChromeAction({ deliberate: true, chromePid: 2876, externalLeases: 4 });
  assert.equal(d.action, "leave-for-adoption");
  assert.match(d.reason, /deliberate/);
});

test("a deliberate shutdown with no external lease still kills", () => {
  const d = decideExitChromeAction({ deliberate: true, chromePid: 2876, externalLeases: 0 });
  assert.equal(d.action, "kill");
  assert.match(d.reason, /deliberate/);
});

// ------------------------------------------------- bounded termination mechanics

test("terminatePidBounded reports a clean SIGTERM without escalating", async () => {
  const signals: string[] = [];
  let alive = true;
  const outcome = await terminatePidBounded(2876, {
    kill: (_pid, signal) => { signals.push(signal); alive = false; },
    alive: () => alive,
    sleep: async () => {},
    timeoutMs: 1_000,
    pollMs: 100,
  });
  assert.equal(outcome, "terminated");
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("terminatePidBounded escalates to SIGKILL after the bounded wait", async () => {
  const signals: string[] = [];
  let alive = true;
  const outcome = await terminatePidBounded(2876, {
    kill: (_pid, signal) => { signals.push(signal); if (signal === "SIGKILL") alive = false; },
    alive: () => alive,
    sleep: async () => {},
    timeoutMs: 500,
    pollMs: 100,
  });
  assert.equal(outcome, "killed");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("terminatePidBounded reports a Chrome that survived even SIGKILL", async () => {
  const outcome = await terminatePidBounded(2876, {
    kill: () => {},
    alive: () => true,
    sleep: async () => {},
    timeoutMs: 300,
    pollMs: 100,
  });
  assert.equal(outcome, "alive");
});

// ------------------------------------------------- N7 / F8: the in-process restart path

test("a restart DEFERS while an external lease is live and the tracked Chrome still answers", () => {
  const d = decideRestartChromeAction({ externalLeases: 1, cdpState: "ready", trackedChrome: true });
  assert.equal(d.action, "defer");
  assert.equal(decideRestartChromeAction({ externalLeases: 1, cdpState: "empty", trackedChrome: true }).action, "defer",
    "an unreadable target list is still a live browser");
});

test("a restart under a live lease with NOTHING tracked relaunches so the forward can adopt", () => {
  const d = decideRestartChromeAction({ externalLeases: 1, cdpState: "ready", trackedChrome: false });
  assert.equal(d.action, "relaunch");
  assert.match(d.reason, /does not track/);
});

test("a restart kills when the CDP is genuinely gone, lease or not", () => {
  // The holder is already broken in this case, and refusing to relaunch would strand Chrome.
  assert.equal(decideRestartChromeAction({ externalLeases: 3, cdpState: "absent", trackedChrome: true }).action, "kill");
  assert.equal(decideRestartChromeAction({ externalLeases: 0, cdpState: "absent", trackedChrome: true }).action, "kill");
  assert.equal(decideRestartChromeAction({ externalLeases: 3, cdpState: "absent", trackedChrome: false }).action, "kill");
});

test("a restart with no external lease kills as before", () => {
  assert.equal(decideRestartChromeAction({ externalLeases: 0, cdpState: "ready", trackedChrome: true }).action, "kill");
  assert.equal(decideRestartChromeAction({ externalLeases: 0, cdpState: "empty", trackedChrome: true }).action, "kill");
});

// ------------------------------------------------- F8: same-generation in-place orphan

test("our Chrome parented by THIS daemon is an in-place orphan and is adopted when healthy", () => {
  const self = 4242;
  const owner = classifyPortOwner([ours(2876, self)], { ...ID, selfPid: self }, allAlive);
  assert.equal(owner.kind, "ours");
  assert.equal(owner.kind === "ours" && owner.parentAlive, true, "the parent (us) is alive");
  assert.equal(owner.kind === "ours" && owner.parentIsSelf, true);
  const decision = decideSingletonForward(owner, { cdpHealthy: true, profileLockPid: 2876 });
  assert.equal(decision.action, "adopt", "before F8 this was leave-live-owner, and the relaunch loop could never adopt");
  assert.match(decision.reason, /in-place orphan/);
});

test("an in-place orphan that is unhealthy or does not hold the lock is terminated, not adopted", () => {
  const self = 4242;
  const owner = classifyPortOwner([ours(2876, self)], { ...ID, selfPid: self }, allAlive);
  assert.equal(decideSingletonForward(owner, { cdpHealthy: false, profileLockPid: 2876 }).action, "terminate");
  assert.equal(decideSingletonForward(owner, { cdpHealthy: true, profileLockPid: 9999 }).action, "terminate");
});

test("without selfPid a live parent is still somebody else's daemon", () => {
  const owner = classifyPortOwner([ours(2876, 4242)], ID, allAlive);
  assert.equal(owner.kind === "ours" && owner.parentIsSelf, false);
  assert.equal(decideSingletonForward(owner, { cdpHealthy: true, profileLockPid: 2876 }).action, "leave-live-owner");
});
