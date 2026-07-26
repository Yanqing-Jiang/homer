// Run: npx tsx src/scripts/ranking-eval.ts [--goldens=<file>] [--db=<path>] [--json=<out>] [--label=<name>]
// --db lets the eval run against a backup copy so unified search's claim
// reinforcement (utility_score writes) never touches the live DB.
import Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { PATHS } from "../config/paths.js";
import { handle as handleMemoryTool } from "../mcp/tools/memory.js";
import type { ToolDeps } from "../mcp/tools/types.js";
import { MemoryIndexer } from "../memory/indexer.js";

interface GoldenCase {
  query: string;
  category?: string;
  notes?: string;
  expected: {
    table: string;
    id?: string;
    substring?: string;
  };
}

interface RankedResult {
  type?: string;
  normalizedRank?: number;
  [key: string]: unknown;
}

interface SearchPayload {
  ranked?: RankedResult[];
}

function argOf(name: string): string | undefined {
  return process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function loadGoldens(file: string): GoldenCase[] {
  const dir = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(resolve(dir, file), "utf-8")) as GoldenCase[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function summarize(result: RankedResult): Record<string, unknown> {
  const pick = (k: string): string | undefined => (typeof result[k] === "string" ? (result[k] as string) : undefined);
  const label = pick("title") ?? pick("content") ?? pick("summary") ?? pick("diagnosis") ?? null;
  return {
    type: result.type ?? null,
    id: idOf(result) ?? null,
    normalizedRank: result.normalizedRank ?? null,
    label: label === null ? null : label.replace(/\s+/g, " ").slice(0, 200),
  };
}

function makeDeps(db: Database.Database, indexer: MemoryIndexer): ToolDeps {
  return {
    getSharedStateManager: () => ({ getDb: () => db }) as ToolDeps["getSharedStateManager"] extends () => infer T ? T : never,
    indexer,
    getAzureBlob: async () => {
      throw new Error("Azure Blob is not needed for ranking eval");
    },
    canonicalMemory: {} as ToolDeps["canonicalMemory"],
  };
}

function idOf(result: RankedResult): string | undefined {
  const id = result.id ?? result.videoId ?? result.contentHash;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

function matchesExpected(result: RankedResult, expected: GoldenCase["expected"]): boolean {
  if (result.type !== expected.table) return false;
  if (expected.id && idOf(result) === expected.id) return true;
  if (expected.substring) {
    return JSON.stringify(result).toLowerCase().includes(expected.substring.toLowerCase());
  }
  return false;
}

async function search(deps: ToolDeps, query: string): Promise<RankedResult[]> {
  const result = await handleMemoryTool("memory_search", { query, limit: 20, mode: "unified" }, deps);
  const text = result?.content[0]?.text;
  if (!text) throw new Error(`memory_search returned no text for query: ${query}`);
  const payload = JSON.parse(text) as SearchPayload;
  return payload.ranked ?? [];
}

async function main(): Promise<void> {
  const label = argOf("label") ?? "ranking-eval";
  const goldensFile = argOf("goldens") ?? "ranking-eval-golden.json";
  const dbPath = argOf("db") ?? PATHS.db;
  const jsonOut = argOf("json");
  const goldens = loadGoldens(goldensFile);
  const db = new Database(dbPath, { readonly: false });
  const indexer = new MemoryIndexer(dbPath);
  const deps = makeDeps(db, indexer);
  const cases: Array<Record<string, unknown>> = [];
  const latencies: number[] = [];
  let hitsAt5 = 0;

  console.log(`# ${label}`);
  console.log(`goldens=${goldens.length} file=${goldensFile} db=${dbPath}`);

  try {
    for (const [idx, golden] of goldens.entries()) {
      const started = performance.now();
      const ranked = await search(deps, golden.query);
      const latencyMs = Math.round((performance.now() - started) * 100) / 100;
      latencies.push(latencyMs);
      const hitIndex = ranked.findIndex(result => matchesExpected(result, golden.expected));
      const rank = hitIndex >= 0 ? hitIndex + 1 : null;
      if (rank !== null && rank <= 5) hitsAt5++;
      const top = ranked[0];
      const topId = top ? idOf(top) ?? "n/a" : "none";
      const topType = top?.type ?? "none";
      const rankText = rank === null ? ">20" : String(rank);
      cases.push({
        query: golden.query,
        category: golden.category ?? null,
        notes: golden.notes ?? null,
        expected: golden.expected,
        rank,
        hitAt5: rank !== null && rank <= 5,
        latencyMs,
        totalRanked: ranked.length,
        top5: ranked.slice(0, 5).map(summarize),
      });
      console.log(`${idx + 1}. rank=${rankText} lat=${latencyMs}ms expected=${golden.expected.table}:${golden.expected.id ?? golden.expected.substring ?? "n/a"} top=${topType}:${topId} query=${JSON.stringify(golden.query)}`);
    }

    const pct = goldens.length === 0 ? 0 : hitsAt5 / goldens.length;
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const byCategory: Record<string, { hitAt5: number; total: number }> = {};
    for (const c of cases) {
      const key = (c.category as string | null) ?? "uncategorized";
      byCategory[key] ??= { hitAt5: 0, total: 0 };
      byCategory[key].total++;
      if (c.hitAt5) byCategory[key].hitAt5++;
    }
    console.log(`summary hit@5=${hitsAt5}/${goldens.length} (${(pct * 100).toFixed(1)}%) p50=${p50}ms p95=${p95}ms`);
    for (const [key, v] of Object.entries(byCategory)) {
      console.log(`  ${key}: hit@5=${v.hitAt5}/${v.total} (${((v.hitAt5 / v.total) * 100).toFixed(1)}%)`);
    }

    if (jsonOut) {
      writeFileSync(jsonOut, JSON.stringify({
        label,
        generatedAt: new Date().toISOString(),
        goldensFile,
        dbPath,
        goldenCount: goldens.length,
        hitAt5: hitsAt5,
        hitAt5Pct: Math.round(pct * 1000) / 10,
        byCategory,
        latency: { p50Ms: p50, p95Ms: p95, maxMs: sorted[sorted.length - 1] ?? 0, minMs: sorted[0] ?? 0 },
        cases,
      }, null, 2));
      console.log(`wrote ${jsonOut}`);
    }
  } finally {
    indexer.close();
    db.close();
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
