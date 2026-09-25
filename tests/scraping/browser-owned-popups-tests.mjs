import test from "node:test";
import assert from "node:assert/strict";
import { ownedPopups, verifyLease } from "../../bin/browser-owned-popups.mjs";

const identity = { leaseId: "lease-a", rootId: "root-a", surface: "agent.a", owner: "browserctl-agent:10", generation: 7, instance: "interactive", cdpEndpoint: "http://127.0.0.1:9222" };
const page = (id, openerId) => ({ id, type: "page", url: `https://example.test/${id}`, ...(openerId ? { openerId } : {}) });
function fixture() {
  return {
    state: "ready", instance: "interactive", cdpEndpoint: identity.cdpEndpoint,
    leases: [
      { leaseId: identity.leaseId, targetId: identity.rootId, surface: identity.surface, owner: identity.owner, generation: identity.generation, leaseExpiresAt: Date.now() + 60_000 },
      { leaseId: "lease-b", targetId: "root-b", surface: "agent.b", owner: "browserctl-agent:20", generation: 7, leaseExpiresAt: Date.now() + 60_000 },
    ],
    reservations: [{ leaseId: identity.leaseId, surface: identity.surface, owner: identity.owner, expiresAt: Date.now() + 60_000 }],
  };
}
const pages = [page("root-a"), page("own-popup", "root-a"), page("own-grandchild", "own-popup"), page("root-b"), page("foreign-popup", "root-b"), page("human"), page("human-popup", "human")];

test("only live descendants of this lease root are selectable", () => {
  assert.deepEqual(ownedPopups(fixture(), pages, identity).map(row => row.id), ["own-popup", "own-grandchild"]);
});

test("other lease roots, its descendants, human tabs, and missing opener are refused", () => {
  const infos = [...pages, page("orphan", "closed-root"), { id: "frame-only", type: "page", url: "https://example.test/frame", openerFrameId: "root-a" }];
  assert.deepEqual(ownedPopups(fixture(), infos, identity).map(row => row.id), ["own-popup", "own-grandchild"]);
  assert.deepEqual(ownedPopups(fixture(), infos.filter(row => row.id !== "own-popup"), identity), [], "closed intermediate opener revokes grandchild routing");
  assert.deepEqual(ownedPopups(fixture(), infos.filter(row => row.id !== "own-grandchild" && row.id !== "own-popup"), identity), [], "closed selected popup leaves root as the only owned target");
});

test("expired, replaced, foreign-owned, or missing lease roots fail closed", () => {
  const variants = [
    status => { status.leases[0].leaseExpiresAt = Date.now() - 1; },
    status => { status.leases[0].generation++; },
    status => { status.leases[0].owner = "browserctl-agent:20"; },
    status => { status.leases[0].targetId = "replacement"; },
    status => { status.reservations[0].expiresAt = Date.now() - 1; },
    status => { status.state = "quarantined"; },
  ];
  for (const mutate of variants) {
    const status = fixture(); mutate(status);
    assert.throws(() => verifyLease(status, identity));
    assert.throws(() => ownedPopups(status, pages, identity));
  }
  assert.throws(() => ownedPopups(fixture(), pages.filter(row => row.id !== "root-a"), identity), /root disappeared/);
});
