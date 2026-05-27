/**
 * Scrape backend smoke test — destructive-cleanup gate.
 *
 * Asserts numeric invariants for the agent-browser scrape executor before any
 * opencli-removal cleanup happens. Exits non-zero if any invariant fails.
 *
 * Invariants (from migration plan reviewed by codex 2026-05-26):
 *   - Twitter bookmarks: ≥6 unique IDs, no duplicate URLs
 *   - Twitter article (a known live tweet): ≥1000 chars content
 *   - Medium feed: ≥5 articles with title+url
 *
 * Run: npx tsx src/scripts/scrape-smoke.ts
 */

import {
  fetchTwitterBookmarks,
  fetchTwitterArticle,
  fetchMediumFeed,
  fetchLinkedInTimeline,
  isScrapeBackendHealthy,
} from "../executors/agent-browser-scrape.js";

const REFERENCE_TWEET_ID = "2059290330567172321"; // HuangMing FDE article — long known-good

interface Probe {
  name: string;
  fn: () => Promise<{ pass: boolean; detail: string }>;
}

const probes: Probe[] = [
  {
    name: "backend health",
    fn: async () => {
      const ok = await isScrapeBackendHealthy();
      return { pass: ok, detail: ok ? "agent-browser + CDP responsive" : "agent-browser eval ping failed" };
    },
  },
  {
    name: "twitter bookmarks ≥6 unique IDs, no dup URLs",
    fn: async () => {
      const r = await fetchTwitterBookmarks(10);
      if (r.status !== "ok" || !r.data) {
        return { pass: false, detail: `status=${r.status}, error=${r.error ?? ""}` };
      }
      const ids = new Set(r.data.map((b) => b.id));
      const urls = new Set(r.data.map((b) => b.url));
      const passUnique = ids.size === r.data.length && urls.size === r.data.length;
      const passCount = r.data.length >= 6;
      return {
        pass: passUnique && passCount,
        detail: `n=${r.data.length}, uniqueIds=${ids.size}, uniqueUrls=${urls.size}, duration=${r.duration}ms`,
      };
    },
  },
  {
    name: "twitter article ≥1000 chars content",
    fn: async () => {
      const r = await fetchTwitterArticle(REFERENCE_TWEET_ID);
      if (r.status !== "ok" || !r.data) {
        return { pass: false, detail: `status=${r.status}, error=${r.error ?? ""}` };
      }
      const len = r.data.content?.length ?? 0;
      return { pass: len >= 1000, detail: `author=${r.data.author}, chars=${len}, duration=${r.duration}ms` };
    },
  },
  {
    name: "medium feed ≥5 articles with title+url",
    fn: async () => {
      const r = await fetchMediumFeed(10);
      if (r.status !== "ok" || !r.data) {
        return { pass: false, detail: `status=${r.status}, error=${r.error ?? ""}` };
      }
      const valid = r.data.filter((p) => p.title && p.url);
      return {
        pass: valid.length >= 5,
        detail: `n=${valid.length}/${r.data.length}, duration=${r.duration}ms`,
      };
    },
  },
  {
    // Wrapper-shape probe only — does NOT exercise the full LLM call (costs tokens).
    // Forces timeout=2s and asserts the envelope is well-formed.
    name: "linkedin wrapper returns well-formed envelope",
    fn: async () => {
      const r = await fetchLinkedInTimeline(5, { timeout: 2_000 });
      const required = ["status", "rawOutput", "exitCode", "duration", "retryable", "needsAuth", "needsExtension"] as const;
      const missing = required.filter((k) => !(k in r));
      // We expect this to fail (timeout/parse_error) — the test is just that the envelope is shaped right.
      const validStatuses = ["ok", "empty", "timeout", "auth", "parse_error", "backend_error", "cdp_unavailable", "selector_empty"];
      const ok = missing.length === 0 && validStatuses.includes(r.status);
      return {
        pass: ok,
        detail: `status=${r.status}, missing=[${missing.join(",")}], duration=${r.duration}ms (intentionally aborted to skip LLM cost)`,
      };
    },
  },
];

async function main() {
  console.log("[scrape-smoke] running invariant checks…\n");
  let failed = 0;
  for (const p of probes) {
    process.stdout.write(`  ${p.name} … `);
    try {
      const { pass, detail } = await p.fn();
      if (pass) {
        console.log(`✓  (${detail})`);
      } else {
        console.log(`✗  ${detail}`);
        failed++;
      }
    } catch (err) {
      console.log(`✗  threw: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
  console.log("");
  if (failed === 0) {
    console.log(`[scrape-smoke] ALL ${probes.length} PROBES PASSED — destructive cleanup gate OPEN`);
    process.exit(0);
  } else {
    console.log(`[scrape-smoke] ${failed}/${probes.length} probes FAILED — gate CLOSED, do not uninstall opencli yet`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[scrape-smoke] fatal:", err);
  process.exit(2);
});
