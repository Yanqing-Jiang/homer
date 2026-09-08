import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createSocketServer } from "node:net";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

for (const mode of ["pinned", "absent", "unpinned", "wrong-target"]) test(`browserctl binding ${mode}: verify ownership, workflow env and setup cleanup`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ctl-binding-"));
  const socketPath = join(dir, "broker.sock"), binary = join(dir, "fake.mjs");
  let marker, released, registered;
  const http = createServer(async (req, res) => {
    if (req.url === "/marker") {
      let body = ""; for await (const chunk of req) body += chunk; marker = body;
      res.end("ok"); return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify([{ id: "other", type: "page", url: "about:blank#other" }, ...(marker ? [{ id: "own", type: "page", url: marker }] : [])]));
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  const port = http.address().port;
  const server = createSocketServer(client => client.once("data", data => {
    const request = JSON.parse(String(data));
    if (request.verb === "register-external-target") registered = request;
    if (request.verb === "release") released = request;
    client.end(JSON.stringify({ ok: true, result: { leaseId: "lease", baselineTargetIds: [], cdpEndpoint: `http://127.0.0.1:${port}`, instance: "downloads" } }) + "\n");
  }));
  await new Promise(resolve => server.listen(socketPath, resolve));
  await writeFile(binary, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args=process.argv.slice(2), session=args[args.indexOf('--session')+1];
// The marker is created with a pinned \`open\`; \`tab new\` on a fresh daemon leaked a second page.
if(args.includes('open')) {
  if(args.includes('tab') || !args.includes('--pin-tab') || args[args.indexOf('--cdp')+1] !== ${JSON.stringify(String(port))}) process.exit(9);
  await fetch('http://127.0.0.1:${port}/marker',{method:'POST',body:args.at(-1)});
  if(${JSON.stringify(mode)} !== 'absent') writeFileSync(process.env.AGENT_BROWSER_SOCKET_DIR+'/'+session+'.target',JSON.stringify({targetId:${JSON.stringify(mode === "wrong-target" ? "other" : "own")},pinned:${mode !== "unpinned"}}));
} else if(args.includes('get')) console.log(JSON.stringify({cdp:process.env.AGENT_BROWSER_CDP,pin:process.env.AGENT_BROWSER_PIN_TAB,session:process.env.AGENT_BROWSER_SESSION,surface:process.env.HOMER_BROWSER_SURFACE,target:process.env.HOMER_BROWSER_TARGET_ID}));
`, { mode: 0o700 });
  try {
    // The workflow resolves the enforcement launcher through browserctl's injected PATH.
    const child = spawn(process.execPath, ["bin/browserctl", "agent", "agent.fixture", "--", "agent-browser", "get", "url"], { env: { ...process.env, HOMER_BROWSER_CONTROL_SOCKET: socketPath, HOMER_AGENT_BROWSER_BIN: binary, AGENT_BROWSER_SOCKET_DIR: dir, HOMER_BROWSER_GRANT: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    const code = await new Promise(resolve => child.once("close", resolve));
    assert.equal(released?.targetId, "own", "cleanup must never close the sibling's target");
    assert.equal(released?.closeTarget, true);
    if (mode === "pinned") {
      assert.equal(code, 0, stderr); assert.equal(registered.targetId, "own");
      const env = JSON.parse(stdout);
      assert.equal(env.cdp, String(port)); assert.equal(env.pin, "1"); assert.match(env.session, /^homer-/); assert.equal(env.surface, "agent.fixture"); assert.equal(env.target, "own");
    } else { assert.equal(code, 1); assert.equal(registered, undefined); }
  } finally {
    await new Promise(resolve => server.close(resolve)); await new Promise(resolve => http.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
