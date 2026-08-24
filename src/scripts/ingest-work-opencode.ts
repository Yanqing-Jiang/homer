#!/usr/bin/env node
/**
 * Ingest a work-laptop OpenCode extract into homer.db.
 *
 *   npm run opencode:ingest-work -- --blob opencode-session-logs.jsonl [--dry-run] [--summaries raw|template|llm] [--rewrite-summaries]
 *   npm run opencode:ingest-work -- --file /path/to/extract.jsonl   [--dry-run] [--summaries raw|template|llm] [--rewrite-summaries]
 *
 * Prints one JSON result line and writes the same result to ~/homer/output/work-ingest/.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { PATHS } from "../config/paths.js";
import { ingestWorkOpencodeBlob, ingestWorkOpencodeFile } from "../cli-sessions/work-opencode-ingest.js";
import { StateManager } from "../state/manager.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const blobName = arg("--blob");
const filePath = arg("--file");
const dryRun = process.argv.includes("--dry-run");
const summaries = arg("--summaries") ?? "raw";
const rewriteSummaries = process.argv.includes("--rewrite-summaries");
if ((!blobName && !filePath) || (blobName && filePath) || !["raw", "template", "llm"].includes(summaries)) {
  console.error("Usage: npm run opencode:ingest-work -- (--blob <name> | --file <path>) [--dry-run] [--summaries raw|template|llm] [--rewrite-summaries]");
  process.exit(1);
}

const stateManager = new StateManager(PATHS.db);
try {
  const options = { dryRun, rewriteSummaries, summaryMode: summaries as "raw" | "template" | "llm" };
  const result = blobName
    ? await ingestWorkOpencodeBlob(stateManager.getDb(), blobName, options)
    : await ingestWorkOpencodeFile(stateManager.getDb(), filePath as string, options);
  const line = JSON.stringify(result);
  console.log(line);
  if (!dryRun) {
    const outDir = join(process.env.HOME ?? "", "homer", "output", "work-ingest");
    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
    writeFileSync(join(outDir, `ingest-${stamp}.json`), line + "\n");
  }
} finally {
  stateManager.close();
}
