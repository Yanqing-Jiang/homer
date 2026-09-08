import "../helpers/no-telegram.js";
import test from "node:test";
import assert from "node:assert/strict";
import { BrowserLeaseBroker } from "../../src/scraping/browser-control.js";

function fixture(initial: Array<[string, string]>) {
  let now = 1_000;
  let onList = () => {};
  const pages = new Map(initial.map(([id, url]) => [id, { id, url, type: "page", webSocketDebuggerUrl: `ws://test/${id}` }]));
  const closed: string[] = [];
  const broker = new BrowserLeaseBroker({
    list: async () => { onList(); return [...pages.values()].map(p => ({ ...p })); },
    create: async () => { throw new Error("cleanup must not create tabs"); },
    close: async id => { closed.push(id); pages.delete(id); },
  }, () => now);
  broker.beginGeneration(1);
  return { broker, pages, closed, advance: () => { now += 60_001; }, onList: (fn: () => void) => { onList = fn; } };
}

test("manual cleanup preserves an active collector, portals and nonblank opaque URLs", async () => {
  const h = fixture([["collector", "about:blank"], ["portal", "https://vendorcentral.amazon.com/"], ["blank", "about:blank"], ["new", "chrome://newtab/"], ["marker", "about:blank#homer-agent-1234-abcd"], ["data", "data:text/html,important"], ["fragment", "about:blank#user-work"]]);
  const r = await h.broker.reserveExternal("agent.collector", `browserctl-agent:${process.pid}`, 3600);
  await h.broker.registerExternalTarget(String(r.leaseId), "collector");
  const result = await h.broker.cleanupBlanks();
  assert.deepEqual(result, { closed: ["blank", "new", "marker"], remaining: 4, deferred: false });
  assert.equal(h.broker.externalLeaseCount(), 1);
  assert.ok(h.pages.has("collector"));
  assert.ok(h.pages.has("portal"));
  assert.ok(h.pages.has("data"));
  assert.ok(h.pages.has("fragment"));
});

test("pending reservation fences the whole sweep", async () => {
  const h = fixture([["a", "about:blank"], ["b", "about:blank"]]);
  await h.broker.reserveExternal("agent.pending", `browserctl-agent:${process.pid}`, 3600);
  assert.equal((await h.broker.cleanupBlanks()).deferred, true);
  assert.deepEqual(h.closed, []);
});

test("cleanup retains the sole page target and is idempotent", async () => {
  const h = fixture([["a", "about:blank"], ["b", "about:blank"]]);
  assert.deepEqual((await h.broker.cleanupBlanks()).closed, ["a"]);
  assert.deepEqual(await h.broker.cleanupBlanks(), { closed: [], remaining: 1, deferred: false });
});

test("adoption grace fences unknown previous holders", async () => {
  const h = fixture([["a", "about:blank"], ["b", "about:blank"]]);
  h.broker.setAdoptionGrace(61_000, "previous holder unknown");
  assert.equal((await h.broker.cleanupBlanks()).deferred, true);
  assert.deepEqual(h.closed, []);
});

test("a blank that navigates during cleanup is preserved", async () => {
  const h = fixture([["portal", "https://example.test/"], ["blank", "about:blank"]]);
  let lists = 0;
  h.onList(() => { if (++lists === 2) h.pages.get("blank")!.url = "https://example.test/new-work"; });
  await h.broker.cleanupBlanks();
  assert.deepEqual(h.closed, []);
});

test("generation change during cleanup aborts before closing", async () => {
  const h = fixture([["a", "about:blank"], ["b", "about:blank"]]);
  let lists = 0;
  h.onList(() => { if (++lists === 2) h.broker.beginGeneration(2); });
  assert.equal((await h.broker.cleanupBlanks()).deferred, true);
  assert.deepEqual(h.closed, []);
});

test("automatic cleanup waits for a minute and an idle browser", async () => {
  const h = fixture([["collector", "https://example.test/"], ["blank", "about:blank"]]);
  const r = await h.broker.reserveExternal("agent.collector", `browserctl-agent:${process.pid}`, 3600);
  await h.broker.registerExternalTarget(String(r.leaseId), "collector");
  await h.broker.observeTargets();
  assert.deepEqual(h.closed, []);
  h.advance();
  await h.broker.observeTargets();
  assert.deepEqual(h.closed, [], "automatic sweep defers during live work");
  await h.broker.release(String(r.leaseId));
  await h.broker.observeTargets();
  assert.deepEqual(h.closed, ["blank"]);
});

test("serialized sweeps close each candidate only once", async () => {
  const h = fixture([["portal", "https://example.test/"], ["blank", "about:blank"]]);
  await Promise.all([h.broker.cleanupBlanks(), h.broker.cleanupBlanks()]);
  assert.deepEqual(h.closed, ["blank"]);
});
