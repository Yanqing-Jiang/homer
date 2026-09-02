/**
 * M6 and M8 on the broker itself.
 *
 * M6: the Chrome exit paths and the degraded-browser retry must react to EXTERNAL holders
 * (agent-browser / browserctl grants), never to Homer's own 15-90 s stewardship leases —
 * counting those made a crash inside a touch orphan Chrome and made the retry skip.
 * M8: adopting a Chrome must not leave the broker believing nothing holds a browser an
 * external agent is still driving.
 */
import "../helpers/no-telegram.js";
import assert from "node:assert/strict";
import test from "node:test";
import { BrowserLeaseBroker } from "../../src/scraping/browser-control.js";

type Target = { id: string; url: string; webSocketDebuggerUrl?: string };

function brokerWith(targets: Target[], now = () => Date.now()) {
  const list = [...targets];
  return new BrowserLeaseBroker({
    list: async () => list,
    create: async (url: string) => {
      const t = { id: `t${list.length + 1}`, url, webSocketDebuggerUrl: `ws://x/${list.length + 1}` };
      list.push(t);
      return t;
    },
    close: async (id: string) => {
      const i = list.findIndex((t) => t.id === id);
      if (i >= 0) list.splice(i, 1);
    },
  }, now);
}

const VC = "https://vendorcentral.amazon.com";
/**
 * N5: `ownerIsDead` was generalised (2026-09-01 14:21) from `browserctl-agent:<pid>` to any
 * `<name>:<pid>[:<suffix>]`, so a fixture owner with a made-up pid now reads as dead and
 * `expireLeases()` drops it out from under the assertion. Every owner here carries this
 * process's pid, which is exactly what a real owner carries: a live one.
 */
const HOLDER = `abvp-refresh:${process.pid}:run-abc`;
const AGENT = `browserctl-agent:${process.pid}`;
const DEAD_AGENT = "browserctl-agent:999999";

// ---------------------------------------------------------------------------- M6

test("a stewardship lease is not an external holder", async () => {
  const broker = brokerWith([{ id: "t1", url: `${VC}/x`, webSocketDebuggerUrl: "ws://x/1" }]);
  broker.beginGeneration(1);
  await broker.reconcile("amazon.vc", [VC], `${VC}/x`);
  assert.equal(broker.externalLeaseCount(), 0);

  await broker.acquire("amazon.vc", "stewardship:scheduled", 90);
  assert.equal(broker.externalLeaseCount(), 0, "Homer's own touch must not look like QC's backfill");
});

test("an agent-browser reservation is an external holder", async () => {
  const broker = brokerWith([{ id: "t1", url: `${VC}/x`, webSocketDebuggerUrl: "ws://x/1" }]);
  broker.beginGeneration(1);
  assert.equal(broker.externalLeaseCount(), 0);
  await broker.reserveExternal("agent.vc-query-detail", HOLDER, 7200, true);
  assert.equal(broker.externalLeaseCount(), 1);
});

test("a lease on an agent.* surface is an external holder", async () => {
  const broker = brokerWith([{ id: "t1", url: `${VC}/x`, webSocketDebuggerUrl: "ws://x/1" }]);
  broker.beginGeneration(1);
  const reservation = await broker.reserveExternal("agent.vc-query-detail", AGENT, 3600) as { leaseId: string };
  await broker.registerExternalTarget(reservation.leaseId, "t1");
  assert.ok(broker.externalLeaseCount() >= 1, "a registered agent target still counts");
});

// ---------------------------------------------------------------------------- M8

test("a granted reservation is snapshotted and restored across a generation", async () => {
  const broker = brokerWith([{ id: "t1", url: `${VC}/x`, webSocketDebuggerUrl: "ws://x/1" }]);
  broker.beginGeneration(1);
  await broker.reserveExternal("agent.vc-query-detail", HOLDER, 3600, true);
  const snapshot = broker.externalHolderSnapshot();
  assert.ok(snapshot);
  assert.equal(snapshot!.reservation?.granted, true);

  // A new daemon generation: beginGeneration clears records AND the reservation.
  broker.beginGeneration(2);
  assert.equal(broker.externalHolderSnapshot(), null);
  assert.equal(broker.externalLeaseCount(), 0);

  const restored = await broker.restoreExternalHolder(snapshot!);
  assert.equal(restored.reservation, true);
  assert.equal(broker.externalLeaseCount(), 1, "the global agent-browser serialization is back");
  await assert.rejects(() => broker.reserveExternal("agent.sqpcheck", "b4-report", 600), /reserved by/);
});

/**
 * N2 + N3, the shape that actually exists in production: a `browserctl agent` holder whose
 * reservation was CLEARED by registerExternalTarget, whose grant owner is the DEAD daemon's
 * pid, and whose surviving identity is the `browserctl-agent:<pid>` adopter rooted outside
 * the daemon. The old snapshot captured nothing and the old restore refused everything.
 */
test("a live browserctl-agent holder survives a generation: honoured, and its release-grant works", async () => {
  const target = { id: "t1", url: `${VC}/query`, webSocketDebuggerUrl: "ws://x/1" };
  const broker = brokerWith([target]);
  broker.beginGeneration(1);

  // ABVP reserves with a grant (owner = the daemon's own pid), the agent adopts and registers
  // its tab — which clears the reservation for a non-granted holder and, for a granted one,
  // records the adopter.
  const reservation = await broker.reserveExternal("agent.vc-query-detail", `abvp-refresh:${process.pid}:run`, 7200, true) as { leaseId: string };
  broker.adoptExternal(reservation.leaseId, AGENT, "agent.vc-query-detail");
  await broker.registerExternalTarget(reservation.leaseId, target.id);

  const snapshot = broker.externalHolderSnapshot();
  assert.ok(snapshot, "the holder is captured even when it lives only as a lease record");
  assert.equal(snapshot!.records.length, 1);
  assert.equal(snapshot!.records[0]!.surface, "agent.vc-query-detail");

  // The daemon dies; the agent keeps driving. Simulate the dead daemon by rewriting the
  // holder identity to a pid that is gone, exactly as N3 describes.
  const acrossRestart = {
    reservation: snapshot!.reservation
      ? { ...snapshot!.reservation, owner: "abvp-refresh:999999:run", adopterOwner: AGENT }
      : null,
    records: snapshot!.records.map((r) => ({ ...r, owner: "abvp-refresh:999999:run", adopterOwner: AGENT })),
  };

  broker.beginGeneration(2);
  assert.equal(broker.externalLeaseCount(), 0, "the new generation starts blind");

  const restored = await broker.restoreExternalHolder(acrossRestart);
  assert.ok(restored.reservation || restored.records > 0, "the live adopter's holder is honoured");
  assert.ok(restored.liveOwners.includes(AGENT), "re-owned to the identity that is actually alive");
  // One holder, seen as both a grant and its registered tab — the count is a holder tally,
  // not a holder count, and anything >0 is what the exit paths key on.
  assert.ok(broker.externalLeaseCount() >= 1);

  // Serialization is genuinely back: an unrelated agent cannot rebind this Chrome.
  await assert.rejects(
    () => broker.reserveExternal("agent.sqpcheck", "b4-report", 600),
    /globally serialized|reserved by/,
  );

  // And the holder's own release still works by leaseId, across the generation boundary.
  const released = await broker.releaseGrant(reservation.leaseId) as { released: boolean };
  assert.equal(released.released, true);
  assert.equal(broker.externalLeaseCount(), 0, "release-grant really freed the browser");
  await broker.reserveExternal("agent.sqpcheck", "b4-report", 600);
});

test("a record whose tab is gone is not resurrected as a phantom lease", async () => {
  const target = { id: "t1", url: `${VC}/query`, webSocketDebuggerUrl: "ws://x/1" };
  const broker = brokerWith([target]);
  broker.beginGeneration(1);
  const reservation = await broker.reserveExternal("agent.vc-query-detail", AGENT, 3600) as { leaseId: string };
  await broker.registerExternalTarget(reservation.leaseId, target.id);
  const snapshot = broker.externalHolderSnapshot()!;

  // New generation, and the tab died with the old one.
  const empty = brokerWith([]);
  empty.beginGeneration(2);
  const restored = await empty.restoreExternalHolder(snapshot);
  assert.equal(restored.records, 0);
  assert.equal(empty.externalLeaseCount(), 0);
});

test("restore refuses an expired holder, a dead holder, or a live conflict", async () => {
  const broker = brokerWith([]);
  broker.beginGeneration(1);
  const base = { surface: "agent.vc-query-detail", owner: HOLDER, leaseId: "L", granted: true };

  assert.equal((await broker.restoreExternalHolder({ reservation: { ...base, expiresAt: Date.now() - 1 }, records: [] })).reservation, false, "expired");
  assert.equal(
    (await broker.restoreExternalHolder({ reservation: { ...base, owner: DEAD_AGENT, adopterOwner: DEAD_AGENT, expiresAt: Date.now() + 60_000 }, records: [] })).reservation,
    false,
    "both identities are gone",
  );
  assert.equal(
    (await broker.restoreExternalHolder({ reservation: { ...base, surface: "amazon.vc", expiresAt: Date.now() + 60_000 }, records: [] })).reservation,
    false,
    "only agent.* surfaces are external reservations",
  );

  assert.equal((await broker.restoreExternalHolder({ reservation: { ...base, expiresAt: Date.now() + 60_000 }, records: [] })).reservation, true);
  assert.equal(
    (await broker.restoreExternalHolder({ reservation: { ...base, leaseId: "M", expiresAt: Date.now() + 60_000 }, records: [] })).reservation,
    false,
    "never displaces a live reservation",
  );
});

test("a snapshot with nothing external is null, so no handoff is written", async () => {
  const broker = brokerWith([{ id: "t1", url: `${VC}/x`, webSocketDebuggerUrl: "ws://x/1" }]);
  broker.beginGeneration(1);
  await broker.reconcile("amazon.vc", [VC], `${VC}/x`);
  await broker.acquire("amazon.vc", "stewardship:scheduled", 90);
  assert.equal(broker.externalHolderSnapshot(), null, "a stewardship touch is not a holder");
});

test("the adoption grace fences new agent reservations and reads as contention", async () => {
  const broker = brokerWith([]);
  broker.beginGeneration(1);
  broker.setAdoptionGrace(Date.now() + 60_000, "adopted without a handoff");
  assert.ok(broker.adoptionGraceUntil());
  await assert.rejects(
    () => broker.reserveExternal("agent.vc-query-detail", HOLDER, 600),
    // ABVP classifies contention vs sickness on this substring; contention defers, sickness
    // consumes a run attempt and alerts.
    /reserved by/,
  );

  broker.setAdoptionGrace(Date.now() - 1, "already elapsed");
  assert.equal(broker.adoptionGraceUntil(), null);
  await broker.reserveExternal("agent.vc-query-detail", HOLDER, 600);
  assert.equal(broker.externalLeaseCount(), 1);
});

test("a real relaunch clears the adoption grace", () => {
  const broker = brokerWith([]);
  broker.beginGeneration(1);
  broker.setAdoptionGrace(Date.now() + 60_000, "adopted without a handoff");
  broker.beginGeneration(2);
  assert.equal(broker.adoptionGraceUntil(), null);
});

// ------------------------------------------------------- G12 / G13 (ABVP round 5, §5)

/**
 * G13: `clearLease` nulls the lease fields and leaves `targetId`, so every adopter reclaimed
 * by `expireLeases` used to leak one tab for the life of the browser. Round 4 made that
 * reclaim path routine, so the leak became routine too.
 */
test("reclaiming a dead adopter closes its tab instead of leaking it", async () => {
  const target = { id: "t1", url: `${VC}/query`, webSocketDebuggerUrl: "ws://x/1" };
  const closed: string[] = [];
  const list = [target];
  const broker = new BrowserLeaseBroker({
    list: async () => list,
    create: async (url: string) => ({ id: `t${list.length + 1}`, url }),
    close: async (id: string) => { closed.push(id); const i = list.findIndex((t) => t.id === id); if (i >= 0) list.splice(i, 1); },
  });
  broker.beginGeneration(1);
  const reservation = await broker.reserveExternal("agent.vc-query-detail", AGENT, 3600) as { leaseId: string };
  await broker.registerExternalTarget(reservation.leaseId, target.id);
  assert.equal(broker.externalLeaseCount(), 1);

  // The adopter is SIGKILLed: its record names a pid that is gone.
  const record = broker.snapshot().find((r) => r.surface === "agent.vc-query-detail")!;
  (record as { owner: string | null }).owner = DEAD_AGENT;
  broker.__setRecordOwnerForTest("agent.vc-query-detail", DEAD_AGENT, DEAD_AGENT);

  assert.equal(broker.externalLeaseCount(), 0, "the lease is reclaimed");
  await broker.__flushPendingClosesForTest();
  assert.deepEqual(closed, ["t1"], "and the abandoned tab is closed, not left behind");
  assert.equal(broker.snapshot().find((r) => r.surface === "agent.vc-query-detail"), undefined,
    "no record is left pointing at a closed target");
});

test("a plain TTL expiry never closes a reconciled surface's tab", async () => {
  const closed: string[] = [];
  const list: Target[] = [];
  let clock = Date.now();
  let n = 0;
  const broker = new BrowserLeaseBroker({
    list: async () => list,
    create: async (url: string) => { const t = { id: `t${++n}`, url, webSocketDebuggerUrl: `ws://x/${n}` }; list.push(t); return t; },
    close: async (id: string) => { closed.push(id); const i = list.findIndex((t) => t.id === id); if (i >= 0) list.splice(i, 1); },
  }, () => clock);
  broker.beginGeneration(1);
  await broker.reconcile("amazon.vc", [VC], `${VC}/x`);
  await broker.acquire("amazon.vc", "stewardship:scheduled", 90);

  clock += 200_000; // the 90 s stewardship lease lapses
  broker.snapshot();
  await broker.__flushPendingClosesForTest();
  assert.deepEqual(closed, [], "reconcile re-leases the SAME tab; closing it would blank the surface");
  assert.ok(broker.snapshot().some((r) => r.surface === "amazon.vc"), "the surface record survives");
});

/**
 * G12: `release()`'s grant-retaining branch forgets the adopter, but the reclaim path did not,
 * so a grant whose adopter was SIGKILLed kept naming a dead pid on the reservation — the very
 * field a later reclaim decision reads.
 */
test("reclaiming a granted record also forgets the dead adopter on the reservation", async () => {
  const target = { id: "t1", url: `${VC}/query`, webSocketDebuggerUrl: "ws://x/1" };
  const broker = brokerWith([target]);
  broker.beginGeneration(1);
  const reservation = await broker.reserveExternal("agent.vc-query-detail", HOLDER, 3600, true) as { leaseId: string };
  broker.adoptExternal(reservation.leaseId, AGENT, "agent.vc-query-detail");
  await broker.registerExternalTarget(reservation.leaseId, target.id);
  assert.equal(broker.externalReservationAdopterForTest(), AGENT);

  broker.__setRecordOwnerForTest("agent.vc-query-detail", HOLDER, DEAD_AGENT);
  broker.snapshot(); // any operation runs expireLeases

  assert.equal(broker.externalReservationAdopterForTest(), null,
    "the grant survives, but it no longer names a pid that is gone");
  assert.ok(broker.externalHolderSnapshot()?.reservation, "the holder's grant itself is retained");
  await broker.__flushPendingClosesForTest();
});

// ------------------------------------------------------------------- F1 (round 3)

/**
 * "Restored nothing" is not "nothing is holding this browser". `onAdopt` runs milliseconds
 * after a ProcessSingleton forward, which is exactly when /json/list is most likely to fail —
 * and a swallowed failure used to be reported as "adopted Chrome is free", skipping the fence
 * while a live agent was still driving a tab.
 */
test("a failed target list during restore reports unknown, never holders-gone", async () => {
  const broker = new BrowserLeaseBroker({
    list: async () => { throw new Error("CDP target list failed: HTTP 500"); },
    create: async () => { throw new Error("not used"); },
    close: async () => {},
  });
  broker.beginGeneration(2);
  const record = {
    surface: "agent.vc-query-detail", generation: 1, targetId: "t1", expectedOrigins: [VC],
    currentUrl: `${VC}/q`, lastVerifiedUrl: `${VC}/q`, owner: AGENT, leaseId: "L",
    leaseExpiresAt: Date.now() + 3_600_000, lastActivityAt: Date.now(), adopterOwner: AGENT,
  };
  const result = await broker.restoreExternalHolder({ reservation: null, records: [record] });
  assert.equal(result.outcome, "unknown");
  assert.equal(result.listFailed, true);
  assert.equal(result.records, 0);
});

test("a live holder whose lease lapsed is unknown, not gone", async () => {
  const broker = brokerWith([{ id: "t1", url: `${VC}/q`, webSocketDebuggerUrl: "ws://x/1" }]);
  broker.beginGeneration(2);
  const record = {
    surface: "agent.vc-query-detail", generation: 1, targetId: "t1", expectedOrigins: [VC],
    currentUrl: `${VC}/q`, lastVerifiedUrl: `${VC}/q`, owner: AGENT, leaseId: "L",
    // A swallowed `browserctl renew` failure: the agent is alive, its lease is not.
    leaseExpiresAt: Date.now() - 1_000, lastActivityAt: Date.now(), adopterOwner: AGENT,
  };
  const result = await broker.restoreExternalHolder({ reservation: null, records: [record] });
  assert.equal(result.outcome, "unknown");
  assert.equal(result.unresolvedLiveHolders, 1);
});

test("a live holder whose tab is gone is unknown, not gone", async () => {
  const broker = brokerWith([]); // the tab died with the old generation
  broker.beginGeneration(2);
  const record = {
    surface: "agent.vc-query-detail", generation: 1, targetId: "t-missing", expectedOrigins: [VC],
    currentUrl: `${VC}/q`, lastVerifiedUrl: `${VC}/q`, owner: AGENT, leaseId: "L",
    leaseExpiresAt: Date.now() + 3_600_000, lastActivityAt: Date.now(), adopterOwner: AGENT,
  };
  const result = await broker.restoreExternalHolder({ reservation: null, records: [record] });
  assert.equal(result.outcome, "unknown");
});

test("a handoff whose holders are all dead really is holders-gone", async () => {
  const broker = brokerWith([{ id: "t1", url: `${VC}/q`, webSocketDebuggerUrl: "ws://x/1" }]);
  broker.beginGeneration(2);
  const record = {
    surface: "agent.vc-query-detail", generation: 1, targetId: "t1", expectedOrigins: [VC],
    currentUrl: `${VC}/q`, lastVerifiedUrl: `${VC}/q`, owner: DEAD_AGENT, leaseId: "L",
    leaseExpiresAt: Date.now() + 3_600_000, lastActivityAt: Date.now(), adopterOwner: DEAD_AGENT,
  };
  const result = await broker.restoreExternalHolder({ reservation: null, records: [record] });
  assert.equal(result.outcome, "holders-gone");
  assert.equal(result.unresolvedLiveHolders, 0);
});

test("the status summary exposes the fence and the reservation", async () => {
  const broker = brokerWith([]);
  broker.beginGeneration(1);
  assert.equal(broker.externalReservationSummary(), null);
  await broker.reserveExternal("agent.vc-query-detail", HOLDER, 600, true);
  const summary = broker.externalReservationSummary();
  assert.equal(summary?.surface, "agent.vc-query-detail");
  assert.equal(summary?.granted, true);
  assert.equal(broker.adoptionGraceUntil(), null);
  broker.setAdoptionGrace(Date.now() + 60_000, "fenced");
  assert.ok(broker.adoptionGraceUntil());
});
