import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stageUploadArgs, cleanupUploads } from "../../bin/browser-file-transfer.mjs";

const exec = promisify(execFile);

test("local browser upload arguments stay local", async () => {
  const args = ["upload", "input[type=file]", "/a/mac/path"];
  assert.equal(await stageUploadArgs(args, { AGENT_BROWSER_SESSION: "homer-12345678" }), args);
});

test("remote upload stages bytes on browser host and cleans its session directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "homer-upload-"));
  const env = { HOMER_BROWSER_REMOTE_HOST: "browser-host", AGENT_BROWSER_SESSION: "homer-aabbccdd" };
  try {
    const source = join(directory, "resume with spaces.pdf");
    await writeFile(source, "upload-transfer-canary\n");
    const [verb, selector, remote] = await stageUploadArgs(["upload", "input[type=file]", source], env);
    assert.equal(verb, "upload");
    assert.equal(selector, "input[type=file]");
    assert.match(remote, /^\/home\/[^/]+\/homer-browser\/uploads\/homer-aabbccdd\/[a-f0-9-]+\/resume with spaces\.pdf$/);
    const { stdout } = await exec("/usr/bin/ssh", ["browser-host", `cat -- '${remote}'`]);
    assert.equal(stdout, "upload-transfer-canary\n");
    await cleanupUploads(env);
    await assert.rejects(exec("/usr/bin/ssh", ["browser-host", `test -e '${remote}'`]));
  } finally {
    await cleanupUploads(env);
    await rm(directory, { recursive: true, force: true });
  }
});
