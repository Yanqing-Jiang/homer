/**
 * Architecture Updater — Nightly Codex agent that rewrites architecture.md
 * to reflect the current state of the Homer codebase.
 *
 * Reads live filesystem + source to gather facts (migration count, handler count,
 * job count, src dirs, table count, etc.) then runs Codex to rewrite the file.
 * No dates appended. No progress sections. Just accurate current architecture.
 */

import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { executeResolvedHarness } from "../../harness/dispatch.js";
import { logger } from "../../utils/logger.js";
import { PATHS } from "../../config/paths.js";

const HOMER_DIR = PATHS.homerRoot;
const ARCH_FILE = PATHS.architectureMd;
const CODEX_OUTPUT_DIR = join(HOMER_DIR, "output/codex");

// Key source files for Codex to understand current architecture
const KEY_FILES = [
  "src/index.ts",
  "src/scheduler/internal-handlers.ts",
  "src/scheduler/types.ts",
  "src/scheduler/executor.ts",
  "src/mcp/index.ts",
  "src/state/manager.ts",
  "src/executors/codex-cli.ts",
  "src/executors/claude.ts",
  "src/executors/opencode-cli.ts",
  "src/executors/fallback-orchestrator.ts",
  "src/config/paths.ts",
];

const MAX_FILE_CHARS = 6_000;
const MAX_TOTAL_CHARS = 60_000;

function gatherKeyFiles(): string {
  let out = "";
  let total = 0;
  for (const rel of KEY_FILES) {
    const full = join(HOMER_DIR, rel);
    if (!existsSync(full)) continue;
    const content = readFileSync(full, "utf-8");
    const chunk = content.length > MAX_FILE_CHARS ? content.slice(0, MAX_FILE_CHARS) + "\n...(truncated)" : content;
    if (total + chunk.length > MAX_TOTAL_CHARS) break;
    out += `\n\n### ${rel}\n\`\`\`typescript\n${chunk}\n\`\`\``;
    total += chunk.length;
  }
  return out;
}

function countMigrations(): number {
  const dir = join(HOMER_DIR, "src/state/migrations");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter(f => /^\d+.*\.ts$/.test(f)).length;
}

function countSrcDirs(): string[] {
  const src = join(HOMER_DIR, "src");
  if (!existsSync(src)) return [];
  return readdirSync(src, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
}

function countScheduledJobs(scheduleContent: string): number {
  try {
    const data = JSON.parse(scheduleContent);
    return Array.isArray(data.jobs) ? data.jobs.filter((j: { enabled?: boolean }) => j.enabled !== false).length : 0;
  } catch {
    return 0;
  }
}

function countInternalHandlers(handlersContent: string): number {
  const matches = handlersContent.match(/case "[\w_]+"/g) ?? [];
  return matches.length;
}

function getSqliteTableCount(): number {
  try {
    const result = execSync(
      `sqlite3 "${HOMER_DIR}/data/homer.db" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';"`,
      { encoding: "utf-8", timeout: 5_000 }
    ).trim();
    return parseInt(result, 10) || 0;
  } catch {
    return 0;
  }
}

function getFileListing(): string {
  try {
    return execSync(`find ${HOMER_DIR}/src -maxdepth 2 -name '*.ts' | sort`, {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim().split("\n").slice(0, 200).join("\n");
  } catch {
    return "(unavailable)";
  }
}

export async function runArchitectureUpdater(): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  try {
    // Gather live facts
    const currentArch = existsSync(ARCH_FILE)
      ? readFileSync(ARCH_FILE, "utf-8")
      : "(not found)";

    const scheduleContent = existsSync("/Users/yj/memory/schedule.json")
      ? readFileSync("/Users/yj/memory/schedule.json", "utf-8")
      : "{}";

    const handlersContent = existsSync(join(HOMER_DIR, "src/scheduler/internal-handlers.ts"))
      ? readFileSync(join(HOMER_DIR, "src/scheduler/internal-handlers.ts"), "utf-8")
      : "";

    const migrations = countMigrations();
    const srcDirs = countSrcDirs();
    const scheduledJobs = countScheduledJobs(scheduleContent);
    const internalHandlers = countInternalHandlers(handlersContent);
    const sqliteTables = getSqliteTableCount();
    const keyFilesContext = gatherKeyFiles();
    const fileListing = getFileListing();

    const ts = new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
    const outputPath = join(CODEX_OUTPUT_DIR, `architecture-updater-${ts}.md`);
    mkdirSync(CODEX_OUTPUT_DIR, { recursive: true });

    const prompt = `You are updating the Homer AI system's architecture.md to reflect current reality.

## RULES
1. Rewrite architecture.md completely. Do NOT add dates, version history entries, or progress notes.
2. Keep all factual sections updated with the numbers below — do NOT invent numbers.
3. Preserve the document structure and headers from the current file. Update content within sections.
4. Remove anything that is stale or contradicted by the live facts below.
5. Write the final updated content to: ${ARCH_FILE}
6. Also write your full output to: ${outputPath}

## LIVE FACTS (verified from filesystem/DB right now)
- Migrations: ${migrations}
- SQLite tables: ${sqliteTables}
- Scheduled jobs (enabled): ${scheduledJobs}
- Internal handlers: ${internalHandlers}
- Src directories (${srcDirs.length}): ${srcDirs.join(", ")}

## CURRENT architecture.md
\`\`\`markdown
${currentArch.slice(0, 40000)}
\`\`\`

## KEY SOURCE FILES (for accuracy checking)
${keyFilesContext}

## FILE LISTING (src/)
\`\`\`
${fileListing}
\`\`\`

## SCHEDULE (~/memory/schedule.json) — first 3000 chars
\`\`\`json
${scheduleContent.slice(0, 3000)}
\`\`\`

## YOUR TASK
1. Read all context above.
2. Identify what is stale or wrong in architecture.md.
3. Rewrite the file with accurate current information.
4. Write the updated content directly to: ${ARCH_FILE}
5. Also write to output file: ${outputPath}

Return a 2-sentence summary of what changed.`;

    logger.info("[ArchitectureUpdater] Running architecture analysis (Codex)");

    // DELIBERATE PIN: architecture analysis is an event-triggered, quality-critical deep-reasoning
    // task that rewrites architecture.md. It is NOT in schedule.json, so it can't be managed from
    // the Jobs tab — a seeded DB row would be an un-clearable hidden pin. We pin Codex/gpt-5.5
    // explicitly (visible, behavior-neutral) instead. This is the one job intentionally immune to
    // switch-all. DEBT: if architecture-updater becomes schedulable/UI-visible, replace this pin
    // with a seeded job row so switch-all can move it.
    const result = await executeResolvedHarness({
      source: "scheduler",
      mode: "scheduler-job",
      prompt,
      explicit: { harness: "codex", model: "gpt-5.5" },
      baselineProfile: {
        cwdOverride: HOMER_DIR,
        timeoutOverride: 1_200_000, // 20 min
        executorOptions: { codex: { reasoningEffort: "high" } },
      },
      requiredCapabilities: [
        { capability: "code.edit", required: true, reason: "rewrite architecture.md" },
        { capability: "tools.files.write", required: true, reason: "write architecture.md / output" },
        { capability: "tools.shell", required: true, reason: "inspect repo state" },
      ],
    });

    if (!result.output && !existsSync(ARCH_FILE)) {
      return { success: false, output: "", error: "Harness produced no output and architecture.md not found" };
    }

    // If the harness wrote to the output file, read it back for logging
    let summary = result.output?.slice(0, 500) ?? "Completed";
    if (existsSync(outputPath)) {
      const out = readFileSync(outputPath, "utf-8");
      summary = out.slice(0, 300);
      logger.info({ path: outputPath }, "[ArchitectureUpdater] Output file written");
    }

    logger.info("[ArchitectureUpdater] architecture.md updated");
    return { success: true, output: `architecture.md updated. ${summary}` };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "[ArchitectureUpdater] Failed");
    return { success: false, output: "", error: msg };
  }
}
