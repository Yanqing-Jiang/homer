import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { PATHS } from "../config/paths.js";
import { handle as handleMemoryTool } from "../mcp/tools/memory.js";
import type { ToolDeps } from "../mcp/tools/types.js";
import { MemoryIndexer } from "../memory/indexer.js";

interface GoldenCase {
  query: string;
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

function loadGoldens(): GoldenCase[] {
  const dir = dirname(fileURLToPath(import.meta.url));
  const path = resolve(dir, "ranking-eval-golden.json");
  return JSON.parse(readFileSync(path, "utf-8")) as GoldenCase[];
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
  const label = process.argv.find(a => a.startsWith("--label="))?.slice("--label=".length) ?? "ranking-eval";
  const goldens = loadGoldens();
  const db = new Database(PATHS.db);
  const indexer = new MemoryIndexer(PATHS.db);
  const deps = makeDeps(db, indexer);
  let hitsAt5 = 0;

  console.log(`# ${label}`);
  console.log(`goldens=${goldens.length}`);

  try {
    for (const [idx, golden] of goldens.entries()) {
      const ranked = await search(deps, golden.query);
      const hitIndex = ranked.findIndex(result => matchesExpected(result, golden.expected));
      const rank = hitIndex >= 0 ? hitIndex + 1 : null;
      if (rank !== null && rank <= 5) hitsAt5++;
      const top = ranked[0];
      const topId = top ? idOf(top) ?? "n/a" : "none";
      const topType = top?.type ?? "none";
      const rankText = rank === null ? ">20" : String(rank);
      console.log(`${idx + 1}. rank=${rankText} expected=${golden.expected.table}:${golden.expected.id ?? golden.expected.substring ?? "n/a"} top=${topType}:${topId} query=${JSON.stringify(golden.query)}`);
    }

    const pct = goldens.length === 0 ? 0 : hitsAt5 / goldens.length;
    console.log(`summary hit@5=${hitsAt5}/${goldens.length} (${(pct * 100).toFixed(1)}%)`);
  } finally {
    indexer.close();
    db.close();
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
