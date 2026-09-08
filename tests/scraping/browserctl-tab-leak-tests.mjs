import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createSocketServer } from "node:net";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

/**
 * Regression for the unmarked about:blank leak (2026-09-07: 7 orphans on the interactive Chrome).
 *
 * A fresh agent-browser daemon attached over --cdp creates its own about:blank page on connect.
 * The wrapper then ran `tab new <marker>`, which created a SECOND page; the connect page was
 * never bound, never registered and never released, so every lease left one plain about:blank.
 * The fake binary below models that daemon behaviour; the fake broker models the real one
 * closely enough to close exactly the registered target on release.
 */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "ctl-leak-"));
  const socketPath = join(dir, "broker.sock"), binary = join(dir, "fake.mjs");
  const pages = new Map([["user-1", "https://example.test/login"], ["user-2", "about:blank"]]);
  let next = 0;
  const events = [];
  const http = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/fake/connect") { const id = `p${++next}`; pages.set(id, "about:blank"); res.end(id); return; }
    if (url.pathname === "/fake/new") { const id = `p${++next}`; pages.set(id, url.searchParams.get("url")); res.end(id); return; }
    if (url.pathname === "/fake/open") { pages.set(url.searchParams.get("id"), url.searchParams.get("url")); res.end("ok"); return; }
    if (url.pathname.startsWith("/json/close/")) { pages.delete(url.pathname.slice("/json/close/".length)); res.end("Target is closing"); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify([...pages].map(([id, pageUrl]) => ({ id, type: "page", url: pageUrl }))));
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  const port = http.address().port;
  const server = createSocketServer(client => client.once("data", async data => {
    const request = JSON.parse(String(data));
    events.push(request.verb);
    if (request.verb === "release" && request.closeTarget && request.targetId) pages.delete(request.targetId);
    const result = request.verb === "capabilities" ? { instances: ["downloads", "interactive"] }
      : { leaseId: "lease", baselineTargetIds: [...pages.keys()], cdpEndpoint: `http://127.0.0.1:${port}`, instance: "interactive" };
    client.end(JSON.stringify({ ok: true, result }) + "\n");
  }));
  await new Promise(resolve => server.listen(socketPath, resolve));
  // agent-browser 0.37 over --cdp: a fresh session's daemon creates a connect page before running
  // the first command. `open` navigates that page; `tab new` creates another one.
  await writeFile(binary, `#!/usr/bin/env node
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2), session = args.includes('--session') ? args[args.indexOf('--session') + 1] : process.env.AGENT_BROWSER_SESSION;
const base = 'http://127.0.0.1:${port}';
const state = process.env.AGENT_BROWSER_SOCKET_DIR + '/' + session + '.fake';
if (args.includes('close')) process.exit(0);
let current = existsSync(state) ? readFileSync(state, 'utf8') : null;
if (!current) { current = await (await fetch(base + '/fake/connect')).text(); writeFileSync(state, current); }
const bind = (id) => writeFileSync(process.env.AGENT_BROWSER_SOCKET_DIR + '/' + session + '.target', JSON.stringify({ targetId: id, pinned: args.includes('--pin-tab') }));
if (args.includes('open')) { await fetch(base + '/fake/open?id=' + current + '&url=' + encodeURIComponent(args.at(-1))); bind(current); }
else if (args.includes('tab') && args[args.indexOf('tab') + 1] === 'new') { const id = await (await fetch(base + '/fake/new?url=' + encodeURIComponent(args.at(-1)))).text(); writeFileSync(state, id); bind(id); }
else if (args.includes('get')) console.log(process.env.HOMER_BROWSER_TARGET_ID);
`, { mode: 0o700 });
  const run = (workflow) => new Promise(resolve => {
    const child = spawn(process.execPath, ["bin/browserctl", "agent", "agent.leak", "--instance", "interactive", "--", ...workflow], { env: { ...process.env, HOMER_BROWSER_CONTROL_SOCKET: socketPath, HOMER_AGENT_BROWSER_BIN: binary, AGENT_BROWSER_SOCKET_DIR: dir, HOMER_BROWSER_GRANT: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
  const close = async () => {
    await new Promise(resolve => server.close(resolve)); await new Promise(resolve => http.close(resolve));
    await rm(dir, { recursive: true, force: true });
  };
  return { pages, events, run, close };
}

test("repeated leases leave the page set exactly as they found it", async () => {
  const { pages, run, close } = await fixture();
  try {
    const before = new Map(pages);
    for (let i = 0; i < 3; i++) {
      const result = await run(["agent-browser", "get", "url"]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^p\d+\n$/, "the workflow drove the page the wrapper created");
      assert.deepEqual([...pages], [...before], `lease ${i + 1} must not leave a page behind`);
    }
  } finally { await close(); }
});

test("a failing workflow still releases and closes only the marker page", async () => {
  const { pages, events, run, close } = await fixture();
  try {
    const before = new Map(pages);
    const result = await run(["/bin/sh", "-c", "exit 7"]);
    assert.equal(result.code, 7);
    assert.deepEqual([...pages], [...before]);
    assert.equal(events.filter(verb => verb === "release").length, 1);
    assert.equal(pages.get("user-1"), "https://example.test/login", "unrelated user tabs are untouched");
    assert.equal(pages.get("user-2"), "about:blank", "an unrelated blank is not the wrapper's to close");
  } finally { await close(); }
});

test("the marker page is the daemon's own connect page, never a pre-existing tab", async () => {
  const { pages, run, close } = await fixture();
  try {
    const result = await run(["/bin/sh", "-c", "echo $HOMER_BROWSER_TARGET_ID"]);
    assert.equal(result.code, 0, result.stderr);
    const seen = result.stdout.trim();
    assert.match(seen, /^p\d+$/, "target id came from the fake daemon's connect page, not user-1/user-2");
    assert.equal(pages.has(seen), false, "the marker page was closed on release");
  } finally { await close(); }
});
