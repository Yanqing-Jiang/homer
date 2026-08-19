#!/usr/bin/env node

import { PATHS } from "../config/paths.js";
import { ingestWorkOpencodeBlob } from "../cli-sessions/work-opencode-ingest.js";
import { StateManager } from "../state/manager.js";

const blobIndex = process.argv.indexOf("--blob");
const blobName = blobIndex >= 0 ? process.argv[blobIndex + 1] : undefined;
if (!blobName) {
  console.error("Usage: npm run opencode:ingest-work -- --blob <blob-name>");
  process.exit(1);
}

const stateManager = new StateManager(PATHS.db);
try {
  const result = await ingestWorkOpencodeBlob(stateManager.getDb(), blobName);
  console.log(JSON.stringify(result));
} finally {
  stateManager.close();
}
