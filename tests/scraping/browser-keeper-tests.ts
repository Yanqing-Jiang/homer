/**
 * Keeper policy on the broker (2026-09-07).
 *
 * The interactive Chrome idles with exactly one page, its `about:blank` launch page. That page is
 * adopted as the reconciled record `keeper.interactive` so the broker owns it: held (no other
 * surface may adopt it), not an `agent.*` record (never reclaimed as an abandoned agent tab), never
 * leased (it holds neither Chrome nor an agent daemon open), and re-adopted by URL across daemon
 * generations. These tests pin the broker behaviour the wrapper's `keeper` verb relies on.
 */
import "../helpers/no-telegram.js";
import test from "node:test";
import assert from "node:assert/strict";
import { BrowserLeaseBroker } from "../../src/scraping/browser-control.js";

type Page = { id: string; url: string; type: string; webSocketDebuggerUrl: string };
function fixture(initial: Array<[string, string]>) {
  let next = 100;
  const pages = new Map<string, Page>(initial.map(([id, url]) => [id, { id, url, type: "page", webSocketDebuggerUrl: `ws://test/${id}` }]));
  const closed: string[] = [];
  const created: string[] = [];
  const client = {
    list: async () => [...pages.values()].map(page => ({ ...page })),
    create: async (url: string) => { const id = `n${next++}`; const page = { id, url, type: "page", webSocketDebuggerUrl: `ws://test/${id}` }; pages.set(id, page); created.push(id); return page; },
    close: async (id: string) => { closed.push(id); pages.delete(id); },
  };
  const broker = new BrowserLeaseBroker(client, Date.now, true, 4);
  broker.beginGeneration(1);
  return { broker, client, pages, closed, created };
}
const KEEPER = "keeper.interactive";
const AGENT = `browserctl-agent:${process.pid}`;
const keep = (broker: BrowserLeaseBroker) => broker.reconcile(KEEPER, ["about:blank"], "about:blank");

test("keeper adopts the exact launch blank, not an in-flight agent marker listed first", async () => {
  const h = fixture([["marker", "about:blank#homer-agent-1111-2222"], ["launch", "about:blank"]]);
  const reserved = await h.broker.reserveExternal("agent.uw", AGENT, 600);
  const record = await keep(h.broker);
  assert.equal(record.targetId, "launch");
  assert.deepEqual(h.closed, [], "a pending reservation fences the duplicate sweep, so the marker survives");
  await h.broker.registerExternalTarget(String(reserved.leaseId), "marker");
  assert.equal(h.broker.snapshot().find(r => r.surface === "agent.uw")?.targetId, "marker");
});

test("keeper is never an external holder, never abandoned, and survives an agent lease cycle", async () => {
  const h = fixture([["launch", "about:blank"]]);
  const record = await keep(h.broker);
  assert.equal(record.leaseId, null);
  assert.equal(h.broker.externalLeaseCount(), 0);
  assert.equal(h.broker.externalHolderSnapshot(), null, "a keeper must not keep Chrome or an agent daemon alive");
  const reserved = await h.broker.reserveExternal("agent.uw", AGENT, 600);
  const marker = await h.client.create("about:blank#homer-agent-3333");
  await h.broker.registerExternalTarget(String(reserved.leaseId), marker.id);
  assert.equal(h.broker.externalLeaseCount(), 1);
  await h.broker.release(String(reserved.leaseId), true, marker.id);
  assert.deepEqual(h.closed, [marker.id], "release closes only the agent marker");
  h.broker.snapshot(); // expireLeases: the keeper has no lease to expire and is not agent.*, so nothing is queued
  await h.broker.__flushPendingClosesForTest();
  assert.deepEqual([...h.pages.keys()], ["launch"]);
  assert.equal((await keep(h.broker)).targetId, "launch");
});

test("keeper reconcile is idempotent and re-adopts the same page across daemon generations", async () => {
  const h = fixture([["launch", "about:blank"]]);
  assert.equal((await keep(h.broker)).targetId, "launch");
  assert.equal((await keep(h.broker)).targetId, "launch");
  h.broker.beginGeneration(2);
  assert.equal((await keep(h.broker)).targetId, "launch", "same daemon, next generation: previousTargets");
  const restarted = new BrowserLeaseBroker(h.client, Date.now, true, 4);
  restarted.beginGeneration(3);
  assert.equal((await keep(restarted)).targetId, "launch", "new daemon process: re-adopted by URL");
  assert.deepEqual(h.created, [], "an existing launch blank is never duplicated");
  assert.deepEqual(h.closed, []);
});

test("keeper reconcile sweeps only extra plain blanks and leaves every non-blank page", async () => {
  const h = fixture([["portal", "https://unusualwhales.com/flow"], ["b1", "about:blank"], ["b2", "about:blank"], ["b3", "about:blank"]]);
  const record = await keep(h.broker);
  assert.equal(record.targetId, "b1");
  assert.deepEqual(h.closed.sort(), ["b2", "b3"]);
  assert.ok(h.pages.has("portal"));
  assert.deepEqual(h.created, []);
});

test("keeper is created only when Chrome has no blank at all", async () => {
  const h = fixture([["portal", "https://unusualwhales.com/flow"]]);
  const record = await keep(h.broker);
  assert.deepEqual(h.created, [record.targetId]);
  assert.equal(h.pages.get(record.targetId)?.url, "about:blank");
  assert.ok(h.pages.has("portal"));
});

test("the blank cleanup sweep exempts the keeper record's tab", async () => {
  const h = fixture([["launch", "about:blank"], ["leak", "about:blank"], ["orphan", "about:blank#homer-agent-4444-5555"]]);
  // A pending reservation fences reconcile's own duplicate sweep, so the extras survive adoption.
  const reserved = await h.broker.reserveExternal("agent.pending", AGENT, 600);
  await keep(h.broker);
  assert.deepEqual(h.closed, []);
  await h.broker.release(String(reserved.leaseId));
  const result = await h.broker.cleanupBlanks();
  assert.deepEqual(result.closed.sort(), ["leak", "orphan"]);
  assert.ok(h.pages.has("launch"), "the keeper is a record, so cleanup-blanks never closes it");
  assert.equal(result.remaining, 1);
});
