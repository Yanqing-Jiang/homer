#!/usr/bin/env node
/**
 * Import smoke test — verifies all swarm job modules can be loaded
 * without crashing. Run after build, before restart.
 *
 * Usage: node scripts/smoke-test.mjs
 */

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const modules = [
  "dist/scheduler/job-outputs.js",
  "dist/scheduler/shared-context.js",
  "dist/executors/model-swarm.js",
  "dist/executors/gemini.js",
  "dist/scheduler/jobs/ideas-explore.js",
  "dist/scheduler/jobs/nightly-memory.js",
  "dist/scheduler/jobs/learning-engine.js",
  "dist/scheduler/jobs/homer-improvements.js",
  "dist/scheduler/jobs/session-harvester.js",
  "dist/scheduler/jobs/memory-embeddings.js",
  "dist/cli-sessions/importer.js",
  "dist/cli-sessions/parsers.js",
  "dist/cli-sessions/summarizer.js",
];

let failed = 0;

for (const mod of modules) {
  const fullPath = resolve(root, mod);
  try {
    await import(fullPath);
    console.log(`  OK  ${mod}`);
  } catch (err) {
    console.error(`  FAIL  ${mod}: ${err.message}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n${failed} module(s) failed to import. Fix before deploying.`);
  process.exit(1);
} else {
  console.log(`\nAll ${modules.length} modules imported successfully.`);
}
