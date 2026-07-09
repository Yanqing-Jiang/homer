#!/usr/bin/env node
// Retroactively reclassify imported sessions that the (fixed) sub-agent filter
// would now skip: codex exec one-shots (rollout session_meta source="exec") and
// sessions whose first substantive user message matches SUB_AGENT_PATTERNS.
// Dry-run by default; --apply sets searchable=0, processed_for_promotion=1.
import Database from "better-sqlite3";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";

// Mirrors src/cli-sessions/importer.ts ("Context:\n" removed — false positives
// on real plan-mode sessions).
const SUB_AGENT_PATTERNS = [
  "OUTPUT INSTRUCTIONS",
  "RESEARCH_ONLY_PREFIX",
  "Write full analysis/results to:",
  "Return ONLY a brief summary",
];

const SCAFFOLDING_PREFIXES = [
  "<permissions instructions>",
  "<apps_instructions>",
  "<user_instructions>",
  "<environment_context>",
  "# AGENTS.md instructions",
];

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dbPathArg = args.find((arg) => arg !== "--apply");
const dbPath = dbPathArg?.replace(/^~(?=\/|$)/, homedir()) ?? `${homedir()}/homer/data/homer.db`;

function firstSubstantiveUserMessage(messagesJson) {
  try {
    const messages = JSON.parse(messagesJson);
    if (!Array.isArray(messages)) return "";
    for (const message of messages) {
      if (message?.role !== "user" || typeof message?.content !== "string") continue;
      const trimmed = message.content.trimStart();
      if (SCAFFOLDING_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) continue;
      return message.content;
    }
    return "";
  } catch {
    return "";
  }
}

function isExecRollout(filePath) {
  if (!filePath || !existsSync(filePath)) return false;
  try {
    const firstLine = readFileSync(filePath, "utf-8").split("\n").find((l) => l.trim());
    if (!firstLine) return false;
    const entry = JSON.parse(firstLine);
    if (entry.type !== "session_meta") return false;
    const payload = entry.payload || entry;
    return payload.source === "exec" || payload.originator === "codex_exec";
  } catch {
    return false;
  }
}

const db = new Database(dbPath, apply ? undefined : { readonly: true });

const rows = db.prepare(`
  SELECT s.id, s.agent, s.title, s.started_at, st.messages_json, ci.native_file_path
  FROM session_summaries s
  LEFT JOIN session_transcripts st ON st.content_hash = s.content_hash
  LEFT JOIN cli_session_index ci ON ci.content_hash = s.content_hash
  WHERE COALESCE(s.searchable, 1) = 1
`).all();

const matches = [];
for (const row of rows) {
  let reason = null;
  if (row.agent === "codex" && isExecRollout(row.native_file_path)) {
    reason = "codex-exec";
  } else if (row.messages_json && (row.agent === "codex" || row.agent === "opencode")) {
    // claude rows come from history.jsonl (interactive prompts only) — a
    // pattern hit there is a real session quoting the template, not a sub-agent.
    const firstUser = firstSubstantiveUserMessage(row.messages_json);
    if (SUB_AGENT_PATTERNS.some((pattern) => firstUser.includes(pattern))) {
      reason = "prompt-pattern";
    }
  }
  if (reason) matches.push({ ...row, reason });
}

const byReason = {};
for (const m of matches) byReason[m.reason] = (byReason[m.reason] ?? 0) + 1;

console.log(`${apply ? "APPLY" : "DRY RUN"} retro sub-agent cleanup`);
console.log(`DB: ${dbPath}`);
console.log(`Scanned: ${rows.length} | Matched: ${matches.length}`, byReason);
console.log("Sample titles:");
for (const row of matches.slice(0, 15)) {
  console.log(`- [${row.reason}] [${row.agent}] ${(row.title ?? "(untitled)").slice(0, 80)}`);
}

if (apply && matches.length > 0) {
  const update = db.prepare(`
    UPDATE session_summaries
    SET searchable = 0,
        processed_for_promotion = 1
    WHERE id = ?
  `);
  const updateMany = db.transaction((items) => {
    for (const row of items) update.run(row.id);
  });
  updateMany(matches);
  console.log(`Updated sessions: ${matches.length}`);
}

db.close();
