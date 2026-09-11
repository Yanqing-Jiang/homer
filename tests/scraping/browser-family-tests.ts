import assert from "node:assert/strict";
import test from "node:test";
import { BrokerError, BrowserLeaseBroker, type BrowserTargetClient, type CdpTargetInfo } from "../../src/scraping/browser-control.js";

/** Fixture Chrome with opener attribution, mirroring Target.getTargets: openerId is dropped when the opener closes, openerFrameId survives. */
class Targets implements BrowserTargetClient {
  rows: Array<{ id: string; type: string; url: string; webSocketDebuggerUrl: string; openerId?: string; openerFrameId?: string }> = [];
  private seq = 0;
  async list() { return this.rows.map(({ id, type, url, webSocketDebuggerUrl }) => ({ id, type, url, webSocketDebuggerUrl })); }
  async create(url: string) { const row = { id: `t${++this.seq}`, type: "page", url, webSocketDebuggerUrl: "ws://fixture" }; this.rows.push(row); return row; }
  async close(id: string) {
    if (!this.rows.some(row => row.id === id)) throw new Error(`no such target ${id}`);
    this.rows = this.rows.filter(row => row.id !== id);
    for (const row of this.rows) if (row.openerId === id) delete row.openerId;
  }
  async inspect(): Promise<CdpTargetInfo[]> { return this.rows.map(({ id, type, url, openerId, openerFrameId }) => ({ id, type, url, openerId, openerFrameId })); }
  popup(openerId: string, url: string) { const row = { id: `t${++this.seq}`, type: "page", url, webSocketDebuggerUrl: "ws://fixture", openerId, openerFrameId: openerId }; this.rows.push(row); return row; }
  human(url: string) { const row = { id: `t${++this.seq}`, type: "page", url, webSocketDebuggerUrl: "ws://fixture" }; this.rows.push(row); return row; }
}
const owner = `fixture:${process.pid}`;
async function openAgent(broker: BrowserLeaseBroker, targets: Targets, surface: string) {
  const reserved = await broker.reserveExternal(surface, owner, 60);
  const tab = await targets.create(`about:blank#homer-agent-${surface}`);
  await broker.registerExternalTarget(String(reserved.leaseId), tab.id);
  tab.url = `https://${surface}.example/`;
  return { leaseId: String(reserved.leaseId), tab };
}

test("release closes the lease tab and its popups, never a sibling's tab or popup, and never a human tab", async () => {
  const targets = new Targets(); const broker = new BrowserLeaseBroker(targets, Date.now, true, 4);
  const a = await openAgent(broker, targets, "agent.a"); const b = await openAgent(broker, targets, "agent.b");
  const aPop = targets.popup(a.tab.id, "https://a.example/popup"); const aGrand = targets.popup(aPop.id, "https://a.example/grandchild");
  const bPop = targets.popup(b.tab.id, "https://b.example/popup"); const human = targets.human("https://news.example/");
  await broker.release(a.leaseId, true, a.tab.id);
  const left = new Set((await targets.list()).map(row => row.id));
  assert.deepEqual([...left].sort(), [b.tab.id, bPop.id, human.id].sort());
  assert.equal(left.has(aGrand.id), false);
});

test("a popup whose opener already closed is an orphan; a live-lease popup and a human tab are protected", async () => {
  const targets = new Targets(); const broker = new BrowserLeaseBroker(targets, Date.now, true, 4);
  const live = await openAgent(broker, targets, "agent.live");
  const gone = targets.human("https://finished.example/root"); const orphan = targets.popup(gone.id, "https://finished.example/popup");
  targets.rows = targets.rows.filter(row => row.id !== gone.id); delete orphan.openerId;   // opener closed behind Chrome's back
  const livePop = targets.popup(live.tab.id, "https://live.example/popup"); const human = targets.human("https://news.example/");
  const humanChild = targets.popup(human.id, "https://news.example/story");
  const pages = await broker.unknownPages();
  assert.deepEqual(Object.fromEntries(pages.map(page => [page.id, page.orphan])), { [orphan.id]: true, [livePop.id]: false, [human.id]: false, [humanChild.id]: false });
  const outcome = await broker.recoverOrphans();
  assert.deepEqual(outcome.closed.map(page => page.id), [orphan.id]);
  assert.deepEqual(outcome.protected.map(page => page.id).sort(), [livePop.id, human.id, humanChild.id].sort());
  assert.ok((await targets.list()).some(row => row.id === live.tab.id));
});

test("a pinned surface is created once, re-adopted across generations, and never steals a lease tab or a popup", async () => {
  const targets = new Targets(); const broker = new BrowserLeaseBroker(targets, Date.now, true, 4);
  const uw = await openAgent(broker, targets, "agent.uw"); uw.tab.url = "https://unusualwhales.com/flow";
  const uwPop = targets.popup(uw.tab.id, "https://unusualwhales.com/popup");
  const first = await broker.ensurePinned("pinned.unusualwhales", ["https://unusualwhales.com"], "https://unusualwhales.com/");
  assert.notEqual(first.targetId, uw.tab.id); assert.notEqual(first.targetId, uwPop.id);
  assert.equal((await broker.ensurePinned("pinned.unusualwhales", ["https://unusualwhales.com"], "https://unusualwhales.com/")).targetId, first.targetId);
  assert.equal(broker.recordsWithPrefix("pinned.").length, 1);
  broker.beginGeneration(2);
  const again = await broker.ensurePinned("pinned.unusualwhales", ["https://unusualwhales.com"], "https://unusualwhales.com/");
  assert.equal(again.targetId, first.targetId);
  assert.equal((await targets.list()).filter(row => row.url.startsWith("https://unusualwhales.com")).length, 3);
  // Pinned tabs are unknown to nobody: never reported as unknown, never an orphan candidate.
  assert.equal((await broker.unknownPages()).some(page => page.id === first.targetId), false);
  await assert.rejects(broker.ensurePinned("agent.nope", ["https://x.example"], "https://x.example/"), /pinned\./);
});

test("admission refusals carry stable codes and unchanged messages", async () => {
  const targets = new Targets(); const broker = new BrowserLeaseBroker(targets, Date.now, true, 1);
  await broker.reserveExternal("agent.one", owner, 60);
  await assert.rejects(broker.reserveExternal("agent.two", owner, 60), (error: unknown) => error instanceof BrokerError && error.code === "CAPACITY" && /agent capacity 1 reached/.test(error.message));
  await assert.rejects(broker.reserveExternal("agent.one", owner, 60), (error: unknown) => error instanceof BrokerError && error.code === "SURFACE_OCCUPIED");
});
