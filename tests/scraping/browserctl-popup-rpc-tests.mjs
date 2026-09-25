import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createSocketServer } from "node:net";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";

test("interactive RPC selects only owned popup and preserves successful close while restoring root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "popup-rpc-"));
  const socketPath = join(dir, "broker.sock"), binary = join(dir, "agent-browser.mjs");
  let marker, rootLive = false, popupLive = true, commandCount = 0;
  let sessionName, corruptOnStatus = 0;
  let port;
  const endpoint = () => `http://127.0.0.1:${port}`;
  const upgraded = new Set();
  const targetInfos = () => [
    ...(rootLive ? [{ targetId: "root", type: "page", url: marker }] : []),
    ...(popupLive ? [{ targetId: "own", type: "page", url: "https://login.test/", openerId: "root" }] : []),
    { targetId: "foreign-root", type: "page", url: "https://other.test/" },
    { targetId: "foreign-popup", type: "page", url: "https://other.test/login", openerId: "foreign-root" },
  ];
  const http = createServer(async (req, res) => {
    if (req.url === "/marker") {
      let body = ""; for await (const chunk of req) body += chunk;
      marker = body; rootLive = true; res.end("ok"); return;
    }
    if (req.url === "/close-popup") { popupLive = false; commandCount++; res.end("ok"); return; }
    if (req.url === "/command") { commandCount++; res.end("ok"); return; }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/json/version") res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/mock` }));
    else res.end(JSON.stringify(targetInfos().map(row => ({ id: row.targetId, type: row.type, url: row.url }))));
  });
  http.on("upgrade", (req, socket) => {
    upgraded.add(socket); socket.once("close", () => upgraded.delete(socket));
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.once("data", () => {
      const body = Buffer.from(JSON.stringify({ id: 1, result: { targetInfos: targetInfos() } }));
      const header = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
      socket.write(Buffer.concat([header, body]));
    });
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  port = http.address().port;
  const broker = createSocketServer(client => client.once("data", data => {
    const request = JSON.parse(String(data));
    if (request.verb === "status" && corruptOnStatus > 0 && --corruptOnStatus === 0) {
      writeFileSync(join(dir, `${sessionName}.target`), JSON.stringify({ targetId: "foreign-popup", pinned: true }));
    }
    const lease = { leaseId: "lease", targetId: "root", surface: "agent.popup", owner: request.owner ?? "", adopterOwner: `browserctl-agent:${child?.pid}`, generation: 1, leaseExpiresAt: Date.now() + 60_000 };
    const result = request.verb === "capabilities" ? { instances: ["interactive"] }
      : request.verb === "status" ? { state: "ready", instance: "interactive", cdpEndpoint: endpoint(), leases: [lease, { leaseId: "foreign", targetId: "foreign-root", surface: "agent.other", owner: "other", generation: 1, leaseExpiresAt: Date.now() + 60_000 }], reservations: [] }
      : { leaseId: "lease", targetId: "root", generation: 1, instance: "interactive", cdpEndpoint: endpoint() };
    client.end(JSON.stringify({ ok: true, result }) + "\n");
  }));
  await new Promise(resolve => broker.listen(socketPath, resolve));
  await writeFile(binary, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const a=process.argv.slice(2), s=a[a.indexOf('--session')+1], file=process.env.AGENT_BROWSER_SOCKET_DIR+'/'+s+'.target';
if(a.includes('open')) { await fetch(${JSON.stringify(endpoint() + "/marker")},{method:'POST',body:a.at(-1)}); writeFileSync(file,JSON.stringify({targetId:'root',pinned:true})); }
else if(a.includes('tab')) { writeFileSync(file,JSON.stringify({targetId:a.at(-1),pinned:true})); }
else if(a.includes('click')) { await fetch(${JSON.stringify(endpoint() + "/close-popup")}); console.log('auth complete'); }
else if(a.includes('get')) { await fetch(${JSON.stringify(endpoint() + "/command")}); console.log('ok'); }
`, { mode: 0o700 });
  let child;
  try {
    child = spawn(process.execPath, ["bin/browserctl", "agent", "agent.popup", "--instance", "interactive", "--rpc"], { env: { ...process.env, HOMER_BROWSER_CONTROL_SOCKET: socketPath, HOMER_AGENT_BROWSER_BIN: binary, AGENT_BROWSER_SOCKET_DIR: dir, HOMER_BROWSER_GRANT: "" }, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
    const lines = readline.createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    const next = async () => JSON.parse((await Promise.race([
      iterator.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`RPC timed out; stderr: ${stderr}`)), 5_000)),
    ])).value);
    const ready = await next();
    assert.equal(ready.ready, true, stderr);
    sessionName = ready.session;
    const rpc = async (id, args) => { child.stdin.write(JSON.stringify({ id, args }) + "\n"); return await next(); };
    const listed = await rpc(1, ["popup", "list"]);
    assert.equal(listed.ok, true, stderr);
    assert.deepEqual(listed.popups.map(row => row.id), ["own"]);
    assert.equal((await rpc(2, ["popup", "select", "foreign-popup"])).ok, false);
    assert.equal((await rpc(3, ["popup", "select", "own"])).ok, true, stderr);
    const action = await rpc(4, ["click", "@e1"]);
    assert.equal(action.ok, true, stderr);
    assert.equal(action.stdout.trim(), "auth complete");
    assert.equal(action.restoredRoot, true);
    assert.equal(commandCount, 1, "successful auth command ran exactly once");
    assert.equal((await rpc(5, ["popup", "list"])).selectedTargetId, "root");
    popupLive = true;
    assert.equal((await rpc(6, ["popup", "select", "own"])).ok, true);
    corruptOnStatus = 2; // initial admission passes; final check after preparation catches drift.
    const refused = await rpc(7, ["get", "url"]);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /binding changed before command/);
    assert.equal(commandCount, 1, "late binding loss blocks dispatch");
    assert.equal((await rpc(8, ["popup", "list"])).selectedTargetId, "root");
    child.kill("SIGKILL");
    await new Promise(resolve => child.once("close", resolve));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const socket of upgraded) socket.destroy();
    await new Promise(resolve => broker.close(resolve));
    await new Promise(resolve => http.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
