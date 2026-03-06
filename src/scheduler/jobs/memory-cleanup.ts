/**
 * Weekly Memory Cleanup — Gemini Flash API handler
 *
 * Reviews preferences.md, tools.md, work.md, and life.md with full Yanqing context,
 * recent daily logs, and cross-file awareness. The AI's judgment is the quality gate —
 * not rigid size floors or header checks.
 *
 * Each file is processed in its own Gemini call with rich context (soul, identity,
 * weekly activity, cross-reference of all files) as system prompt.
 *
 * Safety: backup before write, 10% sanity floor (catches API errors), per-file isolation.
 */

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { executeClaudeCommand } from "../../executors/claude.js";
import { logger } from "../../utils/logger.js";
import { getMemoryIndexer } from "../../memory/indexer.js";
import { buildSchedulerContext } from "../shared-context.js";
import { StateManager } from "../../state/manager.js";
import { PATHS } from "../../config/paths.js";

const DB_PATH = PATHS.db;

const FILES_TO_CLEAN = [
  { name: "preferences.md", path: PATHS.preferences },
  { name: "tools.md", path: PATHS.tools },
  { name: "work.md", path: PATHS.work },
  { name: "life.md", path: PATHS.life },
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
 * Sanity check — only catches catastrophic failures, not judgment calls.
 * The AI's understanding of Yanqing IS the quality gate.
 */
function sanityCheck(
  original: string,
  cleaned: string,
  _fileName: string
): { valid: boolean; reason?: string } {
  // Empty output → API error, not a judgment call
  if (!cleaned.trim()) {
    return { valid: false, reason: "Empty output (likely API error)" };
  }

  // Less than 10% of original → truncation or error, not judgment
  const ratio = cleaned.length / original.length;
  if (ratio < 0.1) {
    return {
      valid: false,
      reason: `Output is only ${Math.round(ratio * 100)}% of original — likely truncation or API error, not judgment`,
    };
  }

  return { valid: true };
}

/**
 * Build the cleanup prompt for a specific file.
 */
function buildCleanupPrompt(fileName: string, fileContent: string, date: string): string {
  const lineCount = fileContent.split("\n").length;

  return `You've been with Yanqing all week. You know what he did, what he cares about, where he's headed.

Now clean up **${fileName}** (${lineCount} lines). Today is ${date}.

## How to decide

For each piece of content, ask yourself:
- Would Yanqing want this 3 months from now?
- Would it help Homer (his AI system) serve him better?
- Does it capture a decision, relationship, pattern, or preference?

If YES → keep it with fidelity. Don't paraphrase what's already well-written.
If NO → let it go, or compress to one line capturing WHAT happened and WHY it mattered.

## Guidelines (not rules)

- Merge duplicates — if the same topic appears in multiple sections, combine into one authoritative version
- Preserve people, configs, architecture decisions, preferences, relationship context
- Dated implementation details older than 2 weeks are candidates for compression (keep the decision, drop the step-by-step)
- Recent activity (last 2 weeks) gets more leeway — it might still be in-flight
- No size target. The file could grow if it needs structure, or shrink 80% if it's mostly dated noise. Your judgment IS the quality gate.
- Do NOT invent new information — only reorganize, compress, or remove existing content
- Keep document structure clean — consistent header levels, no orphaned sections

## Output format

<cleaned>
(full cleaned file content in markdown — this replaces the entire file)
</cleaned>

<changelog>
(bullet list: what was kept/summarized/merged/removed and why)
</changelog>

## File to clean: ${fileName}

${fileContent}`;
}

/**
 * Snapshot a file to memory_file_snapshots before cleaning.
 */
function snapshotFileToDb(sm: StateManager, fileName: string, content: string): void {
  try {
    sm.snapshotMemoryFile(fileName, content, "pre-cleanup");
    logger.debug({ fileName }, "Snapshotted memory file to DB before cleanup");
  } catch (error) {
    logger.warn({ error, fileName }, "Failed to snapshot memory file to DB");
    throw error;
  }
}

interface FileResult {
  fileName: string;
  success: boolean;
  originalLines: number;
  cleanedLines: number;
  changelog: string;
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

  // Process each file independently
  for (const file of FILES_TO_CLEAN) {
    const fileContent = allFileContents.get(file.name);
    if (!fileContent) {
      results.push({
        fileName: file.name,
        success: false,
        originalLines: 0,
        cleanedLines: 0,
        changelog: "",
        error: "File not found",
      });
      continue;
    }

    const originalLines = fileContent.split("\n").length;

    // 1. Snapshot to DB (replaces .bak.md files)
    try {
      snapshotFileToDb(sm, file.name, fileContent);
    } catch (backupErr) {
      const msg = backupErr instanceof Error ? backupErr.message : String(backupErr);
      results.push({
        fileName: file.name,
        success: false,
        originalLines,
        cleanedLines: 0,
        changelog: "",
        error: `Snapshot failed: ${msg}`,
      });
      continue;
    }

    // 2. Build prompt and call Gemini
    const prompt = buildCleanupPrompt(file.name, fileContent, date);

    logger.info({ file: file.name, originalLines, sizeKB: Math.round(fileContent.length / 1024) }, "Cleaning memory file");

    try {
      const result = await executeClaudeCommand(
        agentContext + "\n\n---\n\n" + prompt,
        {
          cwd: process.env.HOME ?? "/Users/yj",
          model: "sonnet",
          timeout: 180_000,
        },
      );

      if (result.exitCode !== 0) {
        results.push({
          fileName: file.name,
          success: false,
          originalLines,
          cleanedLines: 0,
          changelog: "",
          error: `Claude Sonnet error: ${result.output}`,
        });
        continue;
      }

      // 3. Parse response
      const cleanedMatch = result.output.match(/<cleaned>([\s\S]*?)<\/cleaned>/);
      const changelogMatch = result.output.match(/<changelog>([\s\S]*?)<\/changelog>/);

      if (!cleanedMatch?.[1]) {
        results.push({
          fileName: file.name,
          success: false,
          originalLines,
          cleanedLines: 0,
          changelog: "",
          error: "Failed to parse <cleaned> from response",
        });
        continue;
      }

      const cleaned = cleanedMatch[1].trim();
      const changelog = changelogMatch?.[1]?.trim() ?? "(no changelog)";
      const cleanedLines = cleaned.split("\n").length;

      // 4. Sanity check (catches API errors, not judgment calls)
      const check = sanityCheck(fileContent, cleaned, file.name);
      if (!check.valid) {
        logger.warn({ file: file.name, reason: check.reason }, "Sanity check failed, keeping original");
        results.push({
          fileName: file.name,
          success: false,
          originalLines,
          cleanedLines,
          changelog,
          error: `Sanity check: ${check.reason}`,
        });
        continue;
      }

      // 5. Write cleaned file
      await writeFile(file.path, cleaned + "\n", "utf-8");

      const pctChange = Math.round((1 - cleanedLines / originalLines) * 100);
      logger.info(
        { file: file.name, originalLines, cleanedLines, pctChange, duration: result.duration },
        "Memory file cleaned"
      );

      results.push({
        fileName: file.name,
        success: true,
        originalLines,
        cleanedLines,
        changelog,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ error: msg, file: file.name }, "Cleanup failed for file");
      results.push({
        fileName: file.name,
        success: false,
        originalLines,
        cleanedLines: 0,
        changelog: "",
        error: msg,
      });
    }
  }

  // Reindex all memory files after cleanup
  try {
    const indexer = getMemoryIndexer();
    await indexer.indexAllMemoryFiles();
    logger.info("Memory files reindexed after cleanup");
  } catch (indexErr) {
    logger.warn({ error: indexErr }, "Failed to reindex memory files after cleanup");
  }

  // Build summary output
  const successCount = results.filter((r) => r.success).length;
  const totalFiles = results.length;
  const anySuccess = successCount > 0;

  const lines: string[] = [`Weekly Memory Cleanup (${totalFiles} files)`, "─────────────────────"];

  for (const r of results) {
    if (r.success) {
      const pct = Math.round((1 - r.cleanedLines / r.originalLines) * 100);
      lines.push(`${r.fileName}: ${r.originalLines} → ${r.cleanedLines} lines (-${pct}%)`);
      // Add changelog bullets indented
      for (const entry of r.changelog.split("\n").filter((l) => l.trim().startsWith("-"))) {
        lines.push(`  ${entry.trim()}`);
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
