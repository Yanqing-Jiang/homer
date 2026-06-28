#!/usr/bin/env tsx
/**
 * harness-lint — enforcement gate for harness independence.
 *
 * Fails (exit 1) when a NEW file outside the executor/harness layer imports a CONCRETE harness
 * executor (executeClaudeCommand, executeCodexCLI, …). Downstream code must depend on the
 * harness CONTRACT (src/harness/registry resolver), never a concrete harness.
 *
 * It does NOT fail on the known cutover-pending callers below — Push 1/2 deliberately left those
 * in place; the cutover migrates them onto the resolver. The baseline shrinks as the cutover
 * proceeds; an entry that disappears is progress (report-only), an entry that APPEARS is a
 * regression (hard fail).
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const CONCRETE = /\b(executeClaudeCommand|executeCodexCLI|executeOpenCodeCLI|executeKimiCLI|executeGeminiCLIDirect|executeGeminiAPI)\b/;

/** Allowed to reference concrete executors: the wrapper layer and the adapters. */
const ALLOWED_PREFIX = ["executors/", "harness/"];

/**
 * Remaining concrete-executor callers. New entries are a hard fail. After the 2026-06-28 cutover
 * the feature callers were migrated onto the resolver (src/harness/dispatch.ts); what remains here
 * are the two multi-executor DISPATCH TABLES — the scheduler and the queue worker — which map an
 * already-resolved ExecutorKind to its concrete executor. They are the execution-primitive layer
 * (the same role the harness adapters play) and are intentionally concrete.
 * DEBT: route both through the harness adapters so even these drop to 0. Upgrade when the queue
 * worker carries capability requirements / needs the negotiator.
 */
const BASELINE = new Set<string>([
  "queue/worker.ts",
  "scheduler/executor.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const current = new Set<string>();
for (const file of walk(SRC)) {
  const rel = relative(SRC, file);
  if (ALLOWED_PREFIX.some((p) => rel.startsWith(p))) continue;
  if (CONCRETE.test(readFileSync(file, "utf-8"))) current.add(rel);
}

const added = [...current].filter((f) => !BASELINE.has(f)).sort();
const removed = [...BASELINE].filter((f) => !current.has(f)).sort();

if (removed.length) {
  console.log(`harness-lint: progress — ${removed.length} baseline caller(s) migrated off concrete executors:`);
  for (const r of removed) console.log(`  ✓ ${r}`);
}

if (added.length) {
  console.error(`harness-lint FAILED — ${added.length} NEW direct concrete-harness caller(s) outside the executor/harness layer.`);
  console.error("Depend on the harness contract (resolveHarnessSelection + registry), not executeXCommand:");
  for (const a of added) console.error(`  ✗ ${a}`);
  console.error("If this is intentional, justify it and add to the BASELINE in scripts/harness-lint.ts.");
  process.exit(1);
}

console.log(`harness-lint OK — no new concrete-harness callers (${current.size} baseline-pending, ${removed.length} migrated).`);
