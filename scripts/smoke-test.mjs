#!/usr/bin/env node
/**
 * Import smoke test — verifies all swarm job modules can be loaded
 * without crashing. Run after build, before restart.
 *
 * Usage: node scripts/smoke-test.mjs
 */

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { existsSync, readFileSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const modules = [
  "dist/scheduler/job-outputs.js",
  "dist/scheduler/shared-context.js",
  "dist/executors/model-swarm.js",
  "dist/executors/gemini.js",
  "dist/scheduler/jobs/ideas-explore.js",
  "dist/scheduler/jobs/nightly-memory.js",
  "dist/scheduler/jobs/session-harvester.js",
  "dist/scheduler/jobs/memory-embeddings.js",
  "dist/scheduler/jobs/memory-reindex.js",
  "dist/cli-sessions/importer.js",
  "dist/cli-sessions/parsers.js",
  "dist/cli-sessions/summarizer.js",
  "dist/scheduler/jobs/outcome-tracker.js",
  "dist/scheduler/jobs/preference-updater.js",
  "dist/preferences/engine.js",
  "dist/outcomes/hooks.js",
  "dist/telephony/constants.js",
  "dist/telephony/emergency-sms.js",
  "dist/telephony/call-summary.js",
  "dist/telephony/sms-inbound.js",
  "dist/telephony/server.js",
  "dist/bot/handlers/call-followup.js",
  "dist/bot/handlers/sms-reply.js",
  "dist/scraping/scrape-store.js",
  "dist/feedback/events.js",
];

// Modules contributed by the private overlay (see src/private-overlay.ts).
try {
  const manifestPath = resolve(process.env.HOMER_PRIVATE_ROOT || resolve(root, "..", "homer-private"), "homer-overlay.json");
  if (process.env.HOMER_PRIVATE_ROOT !== "" && existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const rel of manifest.smokeModules ?? []) modules.push(`dist/private/${rel}`);
    console.log(`  (overlay) ${manifestPath}: ${manifest.smokeModules?.length ?? 0} module(s)`);
  }
} catch (err) {
  console.error(`  FAIL  private overlay manifest: ${err.message}`);
  process.exit(1);
}

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
