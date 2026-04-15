/**
 * Weekly Memory Cleanup — Claude Opus 1M handler
 *
 * Reviews preferences.md, tools.md, and work.md with full Yanqing context,
 * recent daily logs, and cross-file awareness. The AI's judgment is the quality gate —
 * not rigid size floors or header checks.
 *
 * Each file is processed in its own Claude Opus call with rich context (soul, identity,
 * weekly activity, cross-reference of all files) as system prompt.
 *
 * Safety: backup before write, 10% sanity floor (catches API errors), per-file isolation.
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { executeClaudeCommand } from "../../executors/claude.js";
import { redactForLLM } from "../../memory/secret-filter.js";
import { logger } from "../../utils/logger.js";
// getMemoryIndexer and getCanonicalMemoryService no longer needed —
// cleanup now stages proposals via claims pipeline (HITL-gated)
import { buildSchedulerContext } from "../shared-context.js";
import { StateManager } from "../../state/manager.js";
import { PATHS } from "../../config/paths.js";

const DB_PATH = PATHS.db;

const FILES_TO_CLEAN = [
  { name: "preferences.md", path: PATHS.preferences },
  { name: "tools.md", path: PATHS.tools },
  { name: "work.md", path: PATHS.work },
] as const;

function getTodayDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function readFileIfExists(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  return readFile(path, "utf-8");
}

/**
 * Build a structural cross-reference of all files being cleaned:
 * name, size, and top-level headers. Helps the AI deduplicate across files.
 */
function buildCrossReference(allFiles: Map<string, string>): string {
  const sections: string[] = [];

  for (const [name, content] of allFiles) {
    const lines = content.split("\n");
    const headers = lines.filter((l) => /^#{1,2}\s/.test(l));
    const sizeKB = Math.round(content.length / 1024);

    sections.push(
      `**${name}** (${lines.length} lines, ${sizeKB}KB)\n` +
        headers.map((h) => `  ${h}`).join("\n")
    );
  }

  return sections.join("\n\n");
}

/**
 * Build the cleanup agent context using the shared builder + cleanup-specific cross-reference.
 */
async function buildAgentContext(allFileContents: Map<string, string>): Promise<string> {
  const crossRef = buildCrossReference(allFileContents);

  const extraSections = `# Files Being Cleaned (Cross-Reference)

These are all the files you'll be cleaning. Use this to spot duplicates across files
and understand where information lives:

${crossRef}

You know Yanqing deeply — his identity, career, tools, system architecture, life context,
and what he did this week. Use this full understanding to make high-fidelity decisions
about what matters in his memory files.`;

  return buildSchedulerContext({
    dailyLogDays: 7,
    dailyLogMaxLines: 200,
    includePreferences: true,
    extraSections,
  });
}

/**
 * Build the surgical cleanup prompt for a specific file.
 *
 * Phase 1.3: emits a JSON array of `update` / `delete` / `noop` actions. Each
 * action must include enough surrounding context in `old_text` to match
 * unambiguously in the file. Each action lands as its own HITL claim.
 */
function buildCleanupPrompt(fileName: string, fileContent: string, date: string): string {
  const lineCount = fileContent.split("\n").length;

  return `You've been with Yanqing all week. You know what he did, what he cares about, where he's headed.

Now review **${fileName}** (${lineCount} lines). Today is ${date}.

## Your job

Emit a list of SURGICAL cleanup actions. You do NOT rewrite the file — you
propose specific edits that Yanqing will review one by one on Telegram.

For each piece of content that should change, ask:
- Would Yanqing want this 3 months from now?
- Would it help Homer (his AI system) serve him better?
- Does it capture a decision, relationship, pattern, or preference?

If YES and it's well-written → leave it alone.
If NO or it's cluttered → propose a \`delete\` or \`update\` action.

## Action types

- \`update\` — rewrite a block (merge duplicates, compress dated implementation detail, fix drift). Provide \`old_text\` and \`new_text\`.
- \`delete\` — remove stale or irrelevant content. Provide \`old_text\` only.
- \`noop\` — skip (used when the file is already clean). Return an empty list instead.

## Critical rules — read carefully

1. \`old_text\` MUST match exactly ONE location in the file. Include 2-3 lines of surrounding context above and below if the target text alone is not unique. If you cannot make it unique, skip the action.
2. Keep each \`old_text\` small (~3-15 lines). Do not propose large multi-section rewrites.
3. Do NOT invent new information. \`new_text\` must be a faithful compression / merge / rephrase of existing content only.
4. \`new_text\` for an \`update\` must preserve every important fact in \`old_text\` (dates, names, configs, decisions).
5. Actions are applied independently. Assume each action sees the ORIGINAL file state, not the state after earlier actions. Do not chain edits that depend on each other.
6. Prefer fewer, higher-value actions. A maximum of 12 actions per file. If the file is already clean, return an empty list.

## Output format

Return EXACTLY a fenced JSON block and nothing else between tags. No prose.

<actions>
[
  {
    "action": "update",
    "old_text": "exact verbatim text from the file including 2-3 lines of surrounding context",
    "new_text": "replacement text",
    "reason": "why this change"
  },
  {
    "action": "delete",
    "old_text": "exact verbatim text from the file",
    "reason": "why this is stale / not worth keeping"
  }
]
</actions>

## File: ${fileName}

${fileContent}`;
}

/**
 * Parse the LLM's JSON action list from the <actions>…</actions> block.
 * Tolerant of surrounding prose and whitespace; rejects anything that isn't a JSON array.
 */
interface CleanupAction {
  action: "update" | "delete" | "noop";
  old_text: string;
  new_text?: string;
  reason?: string;
}

function parseCleanupActions(raw: string): CleanupAction[] {
  const match = raw.match(/<actions>([\s\S]*?)<\/actions>/);
  if (!match?.[1]) return [];
  const jsonBody = match[1].trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
  if (!jsonBody || jsonBody === "[]") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBody);
  } catch (err) {
    logger.warn({ err, preview: jsonBody.slice(0, 200) }, "parseCleanupActions: JSON parse failed");
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const valid: CleanupAction[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const action = rec.action;
    const oldText = rec.old_text;
    const newText = rec.new_text;
    const reason = rec.reason;
    if (action !== "update" && action !== "delete" && action !== "noop") continue;
    if (typeof oldText !== "string" || oldText.trim().length === 0) continue;
    if (action === "update" && (typeof newText !== "string" || newText.trim().length === 0)) continue;
    valid.push({
      action,
      old_text: oldText,
      new_text: typeof newText === "string" ? newText : undefined,
      reason: typeof reason === "string" ? reason : undefined,
    });
  }
  return valid;
}

// memory_file_snapshots removed in migration 072 — git handles version control

interface FileResult {
  fileName: string;
  success: boolean;
  originalLines: number;
  actionsProposed: number;
  actionsStaged: number;
  actionsRejected: number;
  rejectionReasons: string[];
  error?: string;
}

export async function runWeeklyMemoryCleanup(stateManager?: StateManager): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  const date = getTodayDateString();
  logger.info({ date }, "Starting weekly memory cleanup");

  const sm = stateManager ?? new StateManager(DB_PATH);
  const ownedSm = !stateManager;

  try {

  // Pre-read all file contents for cross-reference
  const allFileContents = new Map<string, string>();
  for (const file of FILES_TO_CLEAN) {
    const content = await readFileIfExists(file.path);
    if (content) {
      allFileContents.set(file.name, content);
    }
  }

  // Build agent context with all file contents for cross-reference
  let agentContext: string;
  try {
    agentContext = await buildAgentContext(allFileContents);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "Failed to build agent context");
    return { success: false, output: "", error: msg };
  }

  const results: FileResult[] = [];
  const { insertCandidate } = await import("../../memory/claims.js");

  // Process each file independently
  for (const file of FILES_TO_CLEAN) {
    const fileContent = allFileContents.get(file.name);
    if (!fileContent) {
      results.push({
        fileName: file.name,
        success: false,
        originalLines: 0,
        actionsProposed: 0,
        actionsStaged: 0,
        actionsRejected: 0,
        rejectionReasons: [],
        error: "File not found",
      });
      continue;
    }

    const originalLines = fileContent.split("\n").length;

    // Build prompt and call Claude Opus
    const prompt = buildCleanupPrompt(file.name, fileContent, date);

    logger.info({ file: file.name, originalLines, sizeKB: Math.round(fileContent.length / 1024) }, "Reviewing memory file for cleanup");

    try {
      // Phase 0.6: redact secrets in memory-file content + agent context before LLM call.
      const safePrompt = redactForLLM(agentContext + "\n\n---\n\n" + prompt, "memory-cleanup");

      const result = await executeClaudeCommand(
        safePrompt,
        {
          cwd: process.env.HOME ?? "/Users/yj",
          model: "opus[1m]",
          timeout: 600_000, // 10 min per file — large context
        },
      );

      if (result.exitCode !== 0) {
        results.push({
          fileName: file.name,
          success: false,
          originalLines,
          actionsProposed: 0,
          actionsStaged: 0,
          actionsRejected: 0,
          rejectionReasons: [],
          error: `Claude Opus error: ${result.output.slice(0, 200)}`,
        });
        continue;
      }

      const actions = parseCleanupActions(result.output);
      if (actions.length === 0) {
        logger.info({ file: file.name }, "No cleanup actions proposed (file already clean or parse empty)");
        results.push({
          fileName: file.name,
          success: true,
          originalLines,
          actionsProposed: 0,
          actionsStaged: 0,
          actionsRejected: 0,
          rejectionReasons: [],
        });
        continue;
      }

      // Phase 1.3: each action becomes its own HITL claim. Ambiguous anchors are
      // rejected up-front so we don't queue a claim we know won't apply.
      const targetFile = file.name.replace(".md", "") as "preferences" | "tools" | "work";
      let staged = 0;
      let rejected = 0;
      const rejectionReasons: string[] = [];

      for (const action of actions) {
        if (action.action === "noop") continue;

        const firstIdx = fileContent.indexOf(action.old_text);
        if (firstIdx === -1) {
          rejected += 1;
          rejectionReasons.push(`not-found: ${action.old_text.slice(0, 40).replace(/\s+/g, " ")}…`);
          continue;
        }
        // Step by 1 (not old_text.length) so overlapping duplicate anchors are caught.
        const nextIdx = fileContent.indexOf(action.old_text, firstIdx + 1);
        if (nextIdx !== -1) {
          rejected += 1;
          rejectionReasons.push(`ambiguous: ${action.old_text.slice(0, 40).replace(/\s+/g, " ")}…`);
          continue;
        }

        const claimType = action.action === "delete" ? "remove" : "replace";
        const reason = action.reason?.trim() || "(no reason provided)";
        const claimContent = action.action === "delete"
          ? [
              `CLEANUP (${file.name}) — DELETE`,
              "",
              `Reason: ${reason}`,
              "",
              "--- Text to Remove ---",
              action.old_text,
            ].join("\n")
          : [
              `CLEANUP (${file.name}) — UPDATE`,
              "",
              `Reason: ${reason}`,
              "",
              "--- Old Text ---",
              action.old_text,
              "--- New Text ---",
              action.new_text ?? "",
            ].join("\n");

        try {
          const claimId = insertCandidate(sm.getDb(), {
            content: claimContent,
            targetFile,
            section: "cleanup",
            claimType,
            confidence: 0.85,
            originChannel: "weekly-consolidation",
          });
          if (claimId) {
            staged += 1;
          } else {
            // Duplicate hash — already staged in a prior run
            rejected += 1;
            rejectionReasons.push("duplicate-of-prior-claim");
          }
        } catch (claimErr) {
          rejected += 1;
          rejectionReasons.push(`claim-insert-failed: ${(claimErr as Error).message.slice(0, 40)}`);
        }
      }

      logger.info(
        { file: file.name, proposed: actions.length, staged, rejected, duration: result.duration },
        "Cleanup proposals staged as replace/remove claims",
      );

      results.push({
        fileName: file.name,
        success: true,
        originalLines,
        actionsProposed: actions.length,
        actionsStaged: staged,
        actionsRejected: rejected,
        rejectionReasons,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ error: msg, file: file.name }, "Cleanup failed for file");
      results.push({
        fileName: file.name,
        success: false,
        originalLines,
        actionsProposed: 0,
        actionsStaged: 0,
        actionsRejected: 0,
        rejectionReasons: [],
        error: msg,
      });
    }
  }

  // Build summary output
  const successCount = results.filter((r) => r.success).length;
  const totalFiles = results.length;
  const anySuccess = successCount > 0;
  const totalStaged = results.reduce((sum, r) => sum + r.actionsStaged, 0);

  const lines: string[] = [
    `Weekly Memory Cleanup (${totalFiles} files, ${totalStaged} claims staged)`,
    "─────────────────────",
  ];

  for (const r of results) {
    if (r.success) {
      lines.push(
        `${r.fileName}: ${r.actionsProposed} proposed → ${r.actionsStaged} staged, ${r.actionsRejected} rejected`,
      );
      if (r.rejectionReasons.length > 0) {
        for (const reason of r.rejectionReasons.slice(0, 5)) {
          lines.push(`  - ${reason}`);
        }
        if (r.rejectionReasons.length > 5) {
          lines.push(`  - (+${r.rejectionReasons.length - 5} more rejected)`);
        }
      }
    } else {
      lines.push(`${r.fileName}: SKIPPED — ${r.error}`);
    }
  }

  const output = lines.join("\n");

  return {
    success: anySuccess,
    output,
    error: anySuccess ? undefined : "All files failed cleanup",
  };

  } finally {
    if (ownedSm) {
      sm.close();
    }
  }
}
