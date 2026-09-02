/**
 * Surface tabs must survive a generation bump, and duplicates must be swept.
 *
 * Every `beginGeneration` cleared the registry and reconcile then opened a fresh tab per
 * surface, so each supervisor relaunch or adoption leaked one AMC and one OX tab (12 open
 * tabs on 2026-09-01). Also: the degraded gate refused the very self-test that clears it,
 * and the reason string nested its own prefix once per retry.
 */
import "../helpers/no-telegram.js";
import assert from "node:assert/strict";
import test from "node:test";
import { BrowserLeaseBroker } from "../../src/scraping/browser-control.js";

type Target = { id: string; type: string; url: string; webSocketDebuggerUrl: string };
const AMC = "https://advertising.amazon.com/marketing-cloud";
const OX = "https://vendorcentral.amazon.com/opportunity-explorer/explore";

function harness(initial: Array<[string, string]> = []) {
  let seq = 0;
  const list: Target[] = initial.map(([id, url]) => ({ id, type: "page", url, webSocketDebuggerUrl: `ws://x/${id}` }));
  const closed: string[] = [];
  const created: string[] = [];
  const broker = new BrowserLeaseBroker({
    list: async () => [...list],
    create: async (url: string) => { const t = { id: `new${++seq}`, type: "page", url, webSocketDebuggerUrl: `ws://x/new${seq}` }; list.push(t); created.push(t.id); return t; },
    close: async (id: string) => { const i = list.findIndex((t) => t.id === id); if (i >= 0) list.splice(i, 1); closed.push(id); },
  });
  return { broker, list, closed, created };
}

test("generation bump re-adopts the previous surface tab instead of creating one", async () => {
  const h = harness();
  h.broker.beginGeneration(1);
  const first = await h.broker.reconcile("amazon.amc", ["https://advertising.amazon.com"], AMC);
  assert.equal(h.created.length, 1);
  h.broker.beginGeneration(2);
  const second = await h.broker.reconcile("amazon.amc", ["https://advertising.amazon.com"], AMC);
  assert.equal(second.targetId, first.targetId);
  assert.equal(h.created.length, 1, "no new tab on a generation bump");
  assert.deepEqual(h.closed, []);
});

test("fresh generation adopts a page already at the bootstrap URL and sweeps duplicates", async () => {
  const h = harness([["a1", `${AMC}?entityId=E1`], ["a2", `${AMC}?entityId=E1`], ["a3", `${AMC}?entityId=E1`], ["blank", "about:blank"], ["ox1", OX]]);
  h.broker.beginGeneration(5);
  const record = await h.broker.reconcile("amazon.amc", ["https://advertising.amazon.com"], AMC);
  assert.equal(record.targetId, "a1");
  assert.deepEqual(h.closed.sort(), ["a2", "a3"]);
  assert.equal(h.created.length, 0);
  assert.ok(h.list.some((t) => t.id === "blank"), "unrelated tabs are untouched");
  assert.ok(h.list.some((t) => t.id === "ox1"), "other surfaces' tabs are untouched");
});

test("sign-in leftovers on the surface origin are swept once a bootstrap tab is adopted", async () => {
  const h = harness([["signin", "https://vendorcentral.amazon.com/ap/signin?x=1"], ["ox1", OX], ["ox2", OX]]);
  h.broker.beginGeneration(1);
  const record = await h.broker.reconcile("amazon.vc", ["https://vendorcentral.amazon.com", "https://ara.amazon.com"], OX);
  assert.equal(record.targetId, "ox1");
  assert.deepEqual(h.closed.sort(), ["ox2", "signin"]);
});

test("nothing on the origin matches: a tab is created and nothing is closed", async () => {
  const h = harness([["signin", "https://vendorcentral.amazon.com/ap/signin"]]);
  h.broker.beginGeneration(1);
  const record = await h.broker.reconcile("amazon.vc", ["https://vendorcentral.amazon.com"], OX);
  assert.equal(record.targetId, "new1");
  assert.deepEqual(h.closed, []);
});

test("tabs registered to another record are never adopted or swept", async () => {
  const h = harness([["agent", `${AMC}?entityId=E1`], ["a2", `${AMC}?entityId=E1`]]);
  h.broker.beginGeneration(1);
  const reserved = await h.broker.reserveExternal("agent.abvp", `holder:${process.pid}`, 60) as { leaseId: string };
  await h.broker.registerExternalTarget(reserved.leaseId, "agent");
  const record = await h.broker.reconcile("amazon.amc", ["https://advertising.amazon.com"], AMC);
  assert.equal(record.targetId, "a2");
  assert.deepEqual(h.closed, []);
  assert.ok(h.list.some((t) => t.id === "agent"));
});

test("no sweep while an external reservation is live", async () => {
  const h = harness([["a1", AMC], ["a2", AMC]]);
  h.broker.beginGeneration(1);
  await h.broker.reserveExternal("agent.abvp", `holder:${process.pid}`, 60, true);
  const record = await h.broker.reconcile("amazon.amc", ["https://advertising.amazon.com"], AMC);
  assert.equal(record.targetId, "a1");
  assert.deepEqual(h.closed, [], "an unregistered tab may belong to the reservation holder");
});

test("degraded reason never nests its own prefix", () => {
  const h = harness();
  h.broker.setDegraded("agent-browser automation degraded: agent-browser automation degraded: active owner x:1");
  assert.equal(h.broker.degraded(), "active owner x:1");
  h.broker.setDegraded(null);
  assert.equal(h.broker.degraded(), null);
});

test("self-test can reserve through the degraded gate; ordinary callers cannot", async () => {
  const h = harness();
  h.broker.beginGeneration(1);
  h.broker.setDegraded("stale cause");
  await assert.rejects(h.broker.reserveExternal("agent.x", `job:${process.pid}`, 60), /degraded: stale cause/);
  const reserved = await h.broker.reserveExternal("agent.selftest", `startup-selftest:${process.pid}:1`, 60, false, { bypassDegraded: true }) as { leaseId: string };
  assert.ok(reserved.leaseId);
  await h.broker.release(reserved.leaseId);
});
