/**
 * The grant protocol on the broker itself: adoption is re-entrant, surface-bound, survives an
 * adopter's release, and is dropped only by the holder. None of this was covered by the 24
 * existing CDP tests, which exercise only the pre-existing reserve/register/release path.
 */
import "../helpers/no-telegram.js";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { BrowserLeaseBroker } from "../../src/scraping/browser-control.js";

type Target = { id: string; url: string; webSocketDebuggerUrl?: string };

function brokerWith(targets: Target[]) {
  const list = [...targets];
  return new BrowserLeaseBroker({
    list: async () => list,
    create: async (url: string) => {
      const t = { id: `t${list.length + 1}`, url };
      list.push(t);
      return t;
    },
    close: async (id: string) => {
      const i = list.findIndex((t) => t.id === id);
      if (i >= 0) list.splice(i, 1);
    },
  } as never);
}

test("a granted reservation can be adopted more than once", async () => {
  const broker = brokerWith([{ id: "t0", url: "about:blank" }]);
  const res = (await broker.reserveExternal("agent.abvp", "abvp:1", 600, true)) as { leaseId: string };
  const first = broker.adoptExternal(res.leaseId, "browserctl-agent:100", "agent.abvp");
  assert.equal((first as { leaseId: string }).leaseId, res.leaseId);
  // The MFA-recovery flow releases and relaunches; adoption must work again.
  const second = broker.adoptExternal(res.leaseId, "browserctl-agent:200", "agent.abvp");
  assert.equal((second as { leaseId: string }).leaseId, res.leaseId);
});

test("a NON-granted reservation is consumed by registration, as before", async () => {
  const broker = brokerWith([{ id: "t0", url: "about:blank" }]);
  const res = (await broker.reserveExternal("agent.plain", "browserctl-agent:1", 600)) as { leaseId: string };
  const created = await broker.__targetsForTest_create("https://example.com");
  await broker.registerExternalTarget(res.leaseId, created.id);
  assert.throws(() => broker.adoptExternal(res.leaseId, "x", "agent.plain"), /unknown or expired/);
});

test("a granted reservation survives registration and the adopter's release", async () => {
  const broker = brokerWith([{ id: "t0", url: "about:blank" }]);
  const res = (await broker.reserveExternal("agent.abvp", "abvp:1", 600, true)) as { leaseId: string };
  broker.adoptExternal(res.leaseId, "browserctl-agent:100", "agent.abvp");
  const created = await broker.__targetsForTest_create("https://advertising.amazon.com/bv");
  await broker.registerExternalTarget(res.leaseId, created.id);

  const released = await broker.release(res.leaseId, true, created.id);
  assert.equal((released as { grantRetained?: boolean }).grantRetained, true);
  // The holder still has admission, so the next agent session can adopt.
  const again = broker.adoptExternal(res.leaseId, "browserctl-agent:200", "agent.abvp");
  assert.equal((again as { leaseId: string }).leaseId, res.leaseId);
});

test("only the holder's release-grant actually drops the reservation", async () => {
  const broker = brokerWith([{ id: "t0", url: "about:blank" }]);
  const res = (await broker.reserveExternal("agent.abvp", "abvp:1", 600, true)) as { leaseId: string };
  await broker.releaseGrant(res.leaseId);
  assert.throws(() => broker.adoptExternal(res.leaseId, "x", "agent.abvp"), /unknown or expired/);
  // And the browser is free again.
  const next = (await broker.reserveExternal("agent.other", "someone", 600)) as { leaseId: string };
  assert.ok(next.leaseId);
});

test("a grant is bound to its surface, so an inherited env variable cannot steal it", async () => {
  const broker = brokerWith([{ id: "t0", url: "about:blank" }]);
  const res = (await broker.reserveExternal("agent.abvp", "abvp:1", 600, true)) as { leaseId: string };
  assert.throws(
    () => broker.adoptExternal(res.leaseId, "browserctl-agent:9", "agent.sqpcheck"),
    /bound to surface agent\.abvp/,
  );
});

test("a held reservation excludes every other agent surface", async () => {
  const broker = brokerWith([{ id: "t0", url: "about:blank" }]);
  await broker.reserveExternal("agent.abvp", "abvp:1", 600, true);
  await assert.rejects(() => broker.reserveExternal("agent.sqpcheck", "b4-report", 600), /reserved by/);
});

test("a reservation expires on its TTL, so a crashed holder cannot hold the browser forever", async () => {
  const broker = brokerWith([{ id: "t0", url: "about:blank" }]);
  const res = (await broker.reserveExternal("agent.abvp", "abvp:1", 1, true)) as { leaseId: string };
  // ABVP renews every 60s against a 600s TTL; a crash stops the renewals and the reservation
  // lapses on its own rather than blocking the browser until someone notices.
  await new Promise((r) => setTimeout(r, 1100));
  assert.throws(() => broker.adoptExternal(res.leaseId, "x", "agent.abvp"), /unknown or expired/);
  const next = (await broker.reserveExternal("agent.other", "someone", 60)) as { leaseId: string };
  assert.ok(next.leaseId, "and the browser is available again");
});

test("a targets.list failure does not strand a reservation the caller never received", async () => {
  let calls = 0;
  const broker = new BrowserLeaseBroker({
    list: async () => {
      calls++;
      throw new Error("cdp unreachable");
    },
    create: async () => ({ id: "t1", url: "about:blank" }),
    close: async () => undefined,
  } as never);
  await assert.rejects(() => broker.reserveExternal("agent.abvp", "abvp:1", 600, true), /cdp unreachable/);
  assert.equal(calls, 1);
  // The broker must be free: the caller got no leaseId and cannot release one.
  await assert.rejects(() => broker.reserveExternal("agent.abvp", "abvp:2", 600, true), /cdp unreachable/);
});


test("a second concurrent adopter of one grant is refused with a named reason", async () => {
  const broker = brokerWith([{ id: "t0", url: "about:blank" }]);
  const res = (await broker.reserveExternal("agent.abvp", "abvp:1", 600, true)) as { leaseId: string };
  broker.adoptExternal(res.leaseId, `browserctl-agent:${process.pid}`, "agent.abvp");
  const created = await broker.__targetsForTest_create("https://advertising.amazon.com/bv");
  await broker.registerExternalTarget(res.leaseId, created.id);

  // The first adopter is LIVE and holds a registered target. A second must not get in, or it
  // would overwrite the surface record and the first's release would close the second's tab.
  assert.throws(
    () => broker.adoptExternal(res.leaseId, "browserctl-agent:200", "agent.abvp"),
    /already has a live adopter/,
  );

  // Sequential re-adoption after the first releases is still allowed — that is the MFA flow.
  await broker.release(res.leaseId, true, created.id);
  const again = broker.adoptExternal(res.leaseId, "browserctl-agent:200", "agent.abvp");
  assert.equal((again as { leaseId: string }).leaseId, res.leaseId);
});

// --- F2: a leaked adopter record must not lock the grant out for the rest of the run ------------

/** A pid that is certainly not running: spawn a shell, read its own pid, let it exit. */
function deadPid(): number {
  const r = spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" });
  const pid = Number(r.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0, "could not obtain a reaped pid");
  return pid;
}

test("a granted record whose ADOPTER died without releasing is reclaimed, not locked out", async () => {
  const broker = brokerWith([{ id: "t0", url: "about:blank" }]);
  const res = (await broker.reserveExternal("agent.abvp", `abvp-refresh:${process.pid}:run-1`, 600, true)) as { leaseId: string };
  const gone = deadPid();
  broker.adoptExternal(res.leaseId, `browserctl-agent:${gone}`, "agent.abvp");
  const created = await broker.__targetsForTest_create("https://advertising.amazon.com/bv");
  await broker.registerExternalTarget(res.leaseId, created.id);

  // The scenario: the download harness times out and its browserctl child is SIGKILLed without
  // running its release finally. The record's `owner` is the HOLDER (alive, and renewing), so
  // before F2 nothing could reclaim it and every later adopt in the run was refused.
  const again = broker.adoptExternal(res.leaseId, `browserctl-agent:${process.pid}`, "agent.abvp");
  assert.equal((again as { leaseId: string }).leaseId, res.leaseId);
});

test("a granted record whose HOLDER pid is gone is reclaimable regardless of owner prefix", async () => {
  const broker = brokerWith([{ id: "t0", url: "about:blank" }]);
  const gone = deadPid();
  // `abvp-refresh:<pid>:<run_id>` matched no owner shape the reclaim logic understood, so a
  // holder that had died was invisible to it.
  const res = (await broker.reserveExternal("agent.abvp", `abvp-refresh:${gone}:run-1`, 600, true)) as { leaseId: string };

  // The dead holder's grant is dropped on the next sweep, so nothing can adopt it any more...
  assert.throws(() => broker.adoptExternal(res.leaseId, `browserctl-agent:${process.pid}`, "agent.abvp"), /unknown or expired/);
  // ...and the browser is free again rather than held for the grant's full TTL. Before F2 the
  // `abvp-refresh:<pid>:<run_id>` shape matched no reclaim rule at all.
  const next = (await broker.reserveExternal("agent.other", `someone:${process.pid}`, 600)) as { leaseId: string };
  assert.ok(next.leaseId, "a dead holder must not hold the browser for its full TTL");
});

test("a REGISTERED record whose holder pid is gone is reclaimed too", async () => {
  const broker = brokerWith([{ id: "t0", url: "about:blank" }]);
  // Register while the holder is alive, then make the record look like a dead holder's.
  const res = (await broker.reserveExternal("agent.abvp", `abvp-refresh:${process.pid}:run-1`, 600, true)) as { leaseId: string };
  broker.adoptExternal(res.leaseId, `browserctl-agent:${process.pid}`, "agent.abvp");
  const created = await broker.__targetsForTest_create("https://advertising.amazon.com/bv");
  await broker.registerExternalTarget(res.leaseId, created.id);
  const record = broker.snapshot().find((r) => r.surface === "agent.abvp")!;
  assert.equal(record.adopterOwner, `browserctl-agent:${process.pid}`, "the adopter identity must be on the record");

  await broker.releaseGrant(res.leaseId);
  const after = broker.snapshot().find((r) => r.surface === "agent.abvp");
  assert.equal(after?.leaseId ?? null, null, "release-grant drops the record's lease");
});

test("an owner carrying no pid is never treated as dead", async () => {
  const broker = brokerWith([{ id: "t0", url: "about:blank" }]);
  const res = (await broker.reserveExternal("agent.abvp", "human:yanqing", 600, true)) as { leaseId: string };
  // Still there: a pid-less owner cannot be probed, so it must be left alone rather than reclaimed.
  const adopted = broker.adoptExternal(res.leaseId, `browserctl-agent:${process.pid}`, "agent.abvp");
  assert.equal((adopted as { leaseId: string }).leaseId, res.leaseId);
});

test("a reservation whose owner label carries a live pid survives dead-owner reclaim; a bare ordinal does not", async () => {
  const live = brokerWith([]);
  const ok = (await live.reserveExternal("agent.selftest", `startup-selftest:${process.pid}:2`, 60)) as { leaseId: string };
  await live.observeTargets();
  assert.doesNotThrow(() => live.adoptExternal(ok.leaseId, `browserctl-agent:${process.pid}`, "agent.selftest"));

  const stale = brokerWith([]);
  const bad = (await stale.reserveExternal("agent.selftest", "startup-selftest:2", 60)) as { leaseId: string };
  await stale.observeTargets();
  assert.throws(() => stale.adoptExternal(bad.leaseId, `browserctl-agent:${process.pid}`, "agent.selftest"), /unknown or expired external reservation/);
});
