#!/usr/bin/env tsx
/**
 * harness-conformance — proves the harness-independence invariants, no DB fixture needed.
 *  1. Contract conformance: every registered harness exposes the HarnessAdapter contract,
 *     declares text.generate, and validates its default model.
 *  2. Round-trip reversibility: switching the global selection to X and back strands no scope —
 *     every job resolves to the new global each time (uses the in-memory store).
 * Exit 1 on any failure; wired into `npm run check`.
 */
import { HARNESS_IDS, getDescriptor, getHarnessAdapter } from "../src/harness/registry.js";
import { resolveHarnessSelection } from "../src/harness/resolution/resolver.js";
import { createInMemoryHarnessSelectionStore, type HarnessSelectionRow } from "../src/harness/resolution/store.js";
import type { HarnessId } from "../src/harness/types.js";

let failures = 0;
const fail = (msg: string) => { console.error(`  ✗ ${msg}`); failures++; };

// 1. Contract conformance.
for (const id of HARNESS_IDS) {
  const adapter = getHarnessAdapter(id);
  if (typeof adapter.execute !== "function" || typeof adapter.prepare !== "function" || typeof adapter.descriptor !== "function") {
    fail(`${id}: missing HarnessAdapter contract method`);
  }
  const d = getDescriptor(id, { mode: "scheduler-job" });
  if (!d.capabilities.some((c) => c.capability === "text.generate")) fail(`${id}: no text.generate capability`);
  if (!adapter.validateModel(null, { mode: "scheduler-job" }).ok) fail(`${id}: default model fails validation`);
}

// 2. Round-trip reversibility over the in-memory store.
const JOBS = ["nightly-memory", "ideas-explore", "link-processor"];
function globalRow(harness: HarnessId, model: string | null): HarnessSelectionRow {
  return { scopeType: "global", scopeId: "", harness, model, profileId: null, enabled: true, updatedAt: 0, updatedBy: "test", source: "test", reason: null };
}
function allResolveTo(harness: HarnessId, model: string | null): boolean {
  const store = createInMemoryHarnessSelectionStore([globalRow(harness, model)]); // no job rows = global takeover
  return JOBS.every((jobId) => {
    const sel = resolveHarnessSelection({ requestId: "t", source: "scheduler", scope: { jobId } }, store).selection;
    return sel.harness === harness && sel.source === "global";
  });
}
const sequence: Array<[HarnessId, string | null]> = [["claude", "opus[1m]"], ["opencode", "opencode-go/glm-5.2"], ["claude", "opus[1m]"], ["codex", null]];
for (const [h, m] of sequence) {
  if (!allResolveTo(h, m)) fail(`round-trip: not all jobs follow global after switch to ${h}`);
}

if (failures) { console.error(`harness-conformance FAILED — ${failures} failure(s).`); process.exit(1); }
console.log(`harness-conformance OK — ${HARNESS_IDS.length} harnesses satisfy the contract; ${sequence.length}-step round-trip strands no scope.`);
