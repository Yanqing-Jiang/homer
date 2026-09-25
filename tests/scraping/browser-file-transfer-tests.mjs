import { test } from "node:test";
import assert from "node:assert/strict";
import { stageUploadArgs } from "../../bin/browser-file-transfer.mjs";

test("local browser upload arguments stay local", async () => {
  const args = ["upload", "input[type=file]", "/a/mac/path"];
  assert.equal(await stageUploadArgs(args, { AGENT_BROWSER_SESSION: "homer-12345678" }), args);
});

test("remote upload refuses a session browserctl does not own, before contacting the host", async () => {
  // Synthetic host name: the session check must fail before any SSH connection is attempted.
  const env = { HOMER_BROWSER_REMOTE_HOST: "browser-host.invalid", AGENT_BROWSER_SESSION: "not-a-homer-session" };
  await assert.rejects(stageUploadArgs(["upload", "input[type=file]", "/a/mac/path"], env), /browserctl-owned session/);
});

// The real SSH round trip lives in the private overlay (tests/private/scraping/browser-file-transfer-live-tests.mjs).
