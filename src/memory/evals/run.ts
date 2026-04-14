/**
 * Recall-quality eval — run hybrid search against a fixed set of golden queries
 * and score each by whether the top-1 result lands on the expected file with
 * sufficient similarity and contains at least one expected substring.
 *
 * Run via: npm run eval:memory
 *
 * Output: a per-query pass/fail line + an aggregate pass rate. Designed to be
 * invoked nightly so regressions show up before they corrupt user intuition.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { MemoryIndexer } from "../indexer.js";
import { PATHS } from "../../config/paths.js";

interface GoldenCase {
  id: string;
  query: string;
  context: "work" | "general";
  expectedFile: string;
  minScore: number;
  shouldContainAny: string[];
  notes?: string;
}

interface CaseResult {
  id: string;
  pass: boolean;
  reason: string;
  topHit?: { filePath: string; score?: number; rank: number; contentPreview: string };
}

async function main(): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const goldensPath = join(__dirname, "recall-goldens.json");
  const cases = JSON.parse(readFileSync(goldensPath, "utf-8")) as GoldenCase[];

  const indexer = new MemoryIndexer(PATHS.db);

  const results: CaseResult[] = [];
  for (const c of cases) {
    try {
      const hits = await indexer.hybridSearch(c.query, 5, c.context);
      const top = hits[0];
      if (!top) {
        results.push({ id: c.id, pass: false, reason: "no results returned" });
        continue;
      }

      const score = (top as { score?: number }).score ?? 0;
      const fileMatch = top.filePath.endsWith(`/${c.expectedFile}`);
      const scoreMatch = score >= c.minScore;
      const lcContent = top.content.toLowerCase();
      const substringMatch = c.shouldContainAny.some(s => lcContent.includes(s.toLowerCase()));

      const pass = fileMatch && scoreMatch && substringMatch;
      const failReasons: string[] = [];
      if (!fileMatch) failReasons.push(`file=${top.filePath} expected=${c.expectedFile}`);
      if (!scoreMatch) failReasons.push(`score=${score.toFixed(3)} < ${c.minScore}`);
      if (!substringMatch) failReasons.push(`no expected substring matched`);

      results.push({
        id: c.id,
        pass,
        reason: pass ? "ok" : failReasons.join("; "),
        topHit: { filePath: top.filePath, score, rank: top.rank, contentPreview: top.content.slice(0, 120) },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ id: c.id, pass: false, reason: `exception: ${msg}` });
    }
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;
  const passRate = results.length > 0 ? (passed / results.length) * 100 : 0;

  console.log("\n── Memory recall eval ──");
  for (const r of results) {
    const icon = r.pass ? "✓" : "✗";
    const top = r.topHit ? ` [${r.topHit.filePath} score=${r.topHit.score?.toFixed(3) ?? "n/a"}]` : "";
    console.log(`${icon} ${r.id}${top}  — ${r.reason}`);
  }
  console.log(`\nPass rate: ${passed}/${results.length} (${passRate.toFixed(1)}%)`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Eval failed to start:", err);
  process.exit(2);
});
