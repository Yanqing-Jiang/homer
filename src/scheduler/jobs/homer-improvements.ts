/**
 * HOMER Improvements — Dual-model codebase analysis + executable plan generation.
 *
 * Runs Gemini 3.1 Pro (opencode build agent) + Codex (gpt-5.3-codex xhigh) in parallel.
 * Each writes a .md analysis file to ~/homer/output/{gemini,codex}/.
 * Gemini 3.1 Pro consolidates both into a single improvement idea.
 *
 * Prompt priority: critical issues/fixes → impactful optimizations → Yanqing's goals.
 * Archived ideas (feedback.md) are injected to avoid repeat suggestions.
 * Output: 1 idea/plan per day. Risk ≤ 7 → executable plan. Risk > 7 → idea file.
 */

import { readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { z } from "zod";
import { executeClaudeCommand } from "../../executors/claude.js";
import { executeCodexCLI } from "../../executors/codex-cli.js";
import { executeGeminiAPI } from "../../executors/gemini.js";
import { parseSwarmJSON } from "../../executors/model-swarm.js";
import { buildSchedulerContext } from "../shared-context.js";
import { loadIdeasFromDir, saveIdeaFile, type ParsedIdea } from "../../ideas/parser.js";
import { logger } from "../../utils/logger.js";
import type Database from "better-sqlite3";
import { trackImprovement } from "../../outcomes/hooks.js";
import { storeJobArtifact } from "./artifact-store.js";
import { PATHS } from "../../config/paths.js";

const HOMER_DIR = "/Users/yj/homer";
const GEMINI_OUTPUT_DIR = "/Users/yj/homer/output/gemini";
const CODEX_OUTPUT_DIR = "/Users/yj/homer/output/codex";
const MAX_SOURCE_CHARS = 80_000;

// Priority files to read — core modules that improvements would target
const PRIORITY_FILES = [
  "src/scheduler/index.ts",
  "src/scheduler/executor.ts",
  "src/scheduler/internal-handlers.ts",
  "src/scheduler/failure-takeover.ts",
  "src/scheduler/plan-executor.ts",
  "src/bot/handlers/approval.ts",
  "src/bot/handlers/commands.ts",
  "src/executors/claude.ts",
  "src/executors/gemini.ts",
  "src/executors/opencode-cli.ts",
  "src/executors/model-swarm.ts",
  "src/mcp/index.ts",
  "src/state/manager.ts",
];

const ImprovementSchema = z.object({
  title: z.string().min(5),
  description: z.string().min(30),
  implementation_plan: z.string().min(50),
  files_affected: z.array(z.string()).min(1),
  risk_score: z.number().min(1).max(10),
  risk_explanation: z.string(),
  estimated_effort_minutes: z.number().optional(),
  category: z.string().optional(),
});

function gatherSourceContext(): string {
  let context = "";
  let totalChars = 0;

  for (const file of PRIORITY_FILES) {
    const fullPath = join(HOMER_DIR, file);
    if (!existsSync(fullPath)) continue;

    const content = readFileSync(fullPath, "utf-8");
    if (totalChars + content.length > MAX_SOURCE_CHARS) {
      const budget = Math.max(3000, MAX_SOURCE_CHARS - totalChars);
      context += `\n\n### ${file} (truncated to ${budget} chars)\n\`\`\`typescript\n${content.slice(0, budget)}\n...\n\`\`\``;
      totalChars += budget;
      if (totalChars >= MAX_SOURCE_CHARS) break;
    } else {
      context += `\n\n### ${file}\n\`\`\`typescript\n${content}\n\`\`\``;
      totalChars += content.length;
    }
  }

  return context;
}

function getBuildHealth(): { passes: boolean; output: string } {
  try {
    const output = execSync("npm run build 2>&1", {
      cwd: HOMER_DIR,
      timeout: 60_000,
      encoding: "utf-8",
    });
    return { passes: true, output: output.slice(-2000) };
  } catch (err) {
    const output = err instanceof Error && "stdout" in err
      ? String((err as { stdout: unknown }).stdout).slice(-2000)
      : "Build failed";
    return { passes: false, output };
  }
}

function getRecentFailures(db: Database.Database): string {
  try {
    const rows = db.prepare(`
      SELECT job_id, error, created_at
      FROM scheduled_job_runs
      WHERE success = 0 AND created_at > datetime('now', '-7 days')
      ORDER BY created_at DESC LIMIT 10
    `).all() as Array<{ job_id: string; error: string; created_at: string }>;
    if (rows.length === 0) return "No failures in last 7 days";
    return rows.map(r => `- ${r.job_id} (${r.created_at}): ${(r.error || "").slice(0, 200)}`).join("\n");
  } catch {
    return "(query failed)";
  }
}

/** Extract archived idea titles from feedback.md to avoid repeating them */
function getArchivedTitles(): string[] {
  const feedbackPath = PATHS.feedback;
  if (!existsSync(feedbackPath)) return [];
  try {
    const content = readFileSync(feedbackPath, "utf-8");
    const archived: string[] = [];
    for (const line of content.split("\n")) {
      // Match: ### [DATE] Archive - TITLE
      const m = line.match(/^###\s+\[.+?\]\s+Archive\s+-\s+(.+)/);
      if (m?.[1]) archived.push(m[1].trim());
    }
    return archived;
  } catch {
    return [];
  }
}

function buildSharedPrompt(params: {
  buildHealth: { passes: boolean; output: string };
  recentFailures: string;
  sourceContext: string;
  fileListing: string;
  schedulerContext: string;
  existingTitles: string[];
  archivedTitles: string[];
  outputPath: string;
  agentLabel: string;
}): string {
  const {
    buildHealth, recentFailures, sourceContext, fileListing,
    schedulerContext, existingTitles, archivedTitles, outputPath, agentLabel,
  } = params;

  return `You are ${agentLabel}, analyzing the Homer AI assistant codebase to propose exactly ONE improvement.

## CRITICAL RULES — READ FIRST
1. DO NOT modify any files in the codebase. This is analysis only.
2. You MUST write your full analysis and recommendation to: ${outputPath}
3. Do not suggest anything from the "Already Archived" list below — Yanqing explicitly rejected those.
4. Suggest exactly 1 improvement. Make it count.

## Priority Order (address the highest-priority issue found)
1. **Critical issues / build failures** — if the build is broken or a job keeps crashing, fix that first
2. **Reliability gaps** — recurring failures, missing error handling, race conditions
3. **High-impact optimizations** — things that directly benefit Yanqing's daily workflow (job hunt, memory, ideas)
4. **Code quality** — dead code, missing abstractions, technical debt worth addressing now

## Current Build Status
Build ${buildHealth.passes ? "PASSES ✓" : "FAILS ✗"}
${buildHealth.output}

## Recent Job Failures (last 7 days)
${recentFailures}

## Yanqing's Current Priorities
${schedulerContext.slice(0, 15000)}

## Already Archived (DO NOT suggest these — Yanqing rejected them)
${archivedTitles.slice(0, 40).map(t => "- " + t).join("\n") || "(none)"}

## Existing Ideas (avoid duplicates)
${existingTitles.slice(0, 50).map(t => "- " + t).join("\n")}

## Source Code (actual files)
${sourceContext}

## Complete File Listing
${fileListing}

## Your Task

Analyze the code above and identify the single most impactful improvement. Consider:
- What is actively broken or causing failures right now?
- What would save Yanqing the most time or frustration?
- What technical debt is silently causing problems?

## Output File Format

Write the following to ${outputPath} (create any missing directories):

\`\`\`markdown
# Homer Improvement Analysis — ${agentLabel}

## Recommended Improvement
**Title:** <short descriptive title>
**Category:** reliability|performance|feature|code-quality|build-fix
**Risk:** <1-10> — <honest explanation>
**Files Affected:** <comma-separated list>
**Estimated Effort:** <N> minutes

## Why This Matters
<2-3 sentences connecting to a real problem or Yanqing's goals>

## Implementation Plan
<Step-by-step, specific enough for another LLM to execute. Include exact file paths, function names, and the key code changes needed.>

## JSON Block (for consolidation)
\`\`\`json
{
  "title": "<title>",
  "description": "<2-3 sentence description>",
  "implementation_plan": "<step-by-step details>",
  "files_affected": ["src/path/to/file.ts"],
  "risk_score": <1-10>,
  "risk_explanation": "<honest risk assessment>",
  "estimated_effort_minutes": <number>,
  "category": "reliability|performance|feature|code-quality|build-fix"
}
\`\`\`
\`\`\`

After writing the file, respond with a 2-sentence summary of your recommendation.`;
}

export async function runHomerImprovements(db?: Database.Database, jobRunId?: number): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  try {
    const sourceContext = gatherSourceContext();
    const buildHealth = getBuildHealth();
    const recentFailures = db ? getRecentFailures(db) : "(no DB available)";

    let fileListing = "";
    try {
      fileListing = execSync("find /Users/yj/homer/src -name '*.ts' | sort", {
        encoding: "utf-8",
        timeout: 10_000,
      }).trim();
    } catch {
      fileListing = "(file listing unavailable)";
    }

    const existingIdeas = loadIdeasFromDir();
    const existingTitles = existingIdeas.map(i => i.title.toLowerCase());
    const archivedTitles = getArchivedTitles();

    let schedulerContext: string;
    try {
      schedulerContext = await buildSchedulerContext({ dailyLogDays: 3 });
    } catch {
      schedulerContext = "Context unavailable";
    }

    // Timestamped output file paths — include seconds to avoid stale-file race if job reruns
    const ts = new Date().toISOString().slice(0, 19).replace("T", "-").replace(/:/g, "");
    const geminiOutputPath = `${GEMINI_OUTPUT_DIR}/homer-improvements-${ts}.md`;
    const codexOutputPath = `${CODEX_OUTPUT_DIR}/homer-improvements-${ts}.md`;

    mkdirSync(GEMINI_OUTPUT_DIR, { recursive: true });
    mkdirSync(CODEX_OUTPUT_DIR, { recursive: true });

    const sharedParams = {
      buildHealth, recentFailures, sourceContext, fileListing,
      schedulerContext, existingTitles, archivedTitles,
    };

    const geminiPrompt = buildSharedPrompt({
      ...sharedParams,
      outputPath: geminiOutputPath,
      agentLabel: "Sonnet (architectural analysis)",
    });

    const codexPrompt = buildSharedPrompt({
      ...sharedParams,
      outputPath: codexOutputPath,
      agentLabel: "Codex (deep code analysis)",
    });

    logger.info("Running homer-improvements: Sonnet (Claude Code) + Codex in parallel");

    // Fan-out: run both agents in parallel
    const [geminiResult, codexResult] = await Promise.allSettled([
      executeClaudeCommand(geminiPrompt, {
        cwd: HOMER_DIR,
        model: "sonnet",
        timeout: 900_000, // 15 min
      }),
      executeCodexCLI(codexPrompt, {
        cwd: HOMER_DIR,
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
        timeout: 1_200_000, // 20 min
      }),
    ]);

    // Read whichever .md files were actually written
    const outputs: Array<{ agent: string; content: string }> = [];

    if (existsSync(geminiOutputPath)) {
      outputs.push({ agent: "Sonnet", content: readFileSync(geminiOutputPath, "utf-8") });
      logger.info({ path: geminiOutputPath }, "Gemini output written");
    } else {
      const err = geminiResult.status === "rejected" ? geminiResult.reason : "file not written";
      logger.warn({ error: String(err) }, "Gemini 3.1 Pro did not produce output file");
    }

    if (existsSync(codexOutputPath)) {
      outputs.push({ agent: "Codex", content: readFileSync(codexOutputPath, "utf-8") });
      logger.info({ path: codexOutputPath }, "Codex output written");
    } else {
      const err = codexResult.status === "rejected" ? codexResult.reason : "file not written";
      logger.warn({ error: String(err) }, "Codex did not produce output file");
    }

    if (outputs.length === 0) {
      return { success: false, output: "", error: "Both agents failed to produce output files" };
    }

    // Consolidate via Gemini 3.1 Pro API
    const consolidationPrompt = `You are consolidating two codebase improvement analyses into a single best recommendation.

${outputs.map(o => `## ${o.agent} Analysis\n\n${o.content.slice(0, 20000)}`).join("\n\n---\n\n")}

## Your Task

Review both analyses above. Pick the single most impactful improvement, or synthesize the best elements if they complement each other.

Return ONLY a JSON object (no markdown, no explanation):
{
  "title": "Short descriptive title",
  "description": "2-3 sentence description connecting to real impact",
  "implementation_plan": "Step-by-step implementation with specific file paths, function names, and code changes",
  "files_affected": ["src/path/to/file.ts"],
  "risk_score": 1-10,
  "risk_explanation": "Why this risk level — be honest",
  "estimated_effort_minutes": 5-60,
  "category": "reliability|performance|feature|code-quality|build-fix"
}`;

    const consolidation = await executeGeminiAPI(consolidationPrompt, {
      model: "pro31",  // gemini-3.1-pro-preview — falls back to flash3 if unavailable
      temperature: 0.2,
      maxTokens: 4096,
    });

    if (!consolidation.output) {
      return { success: false, output: "", error: "Consolidation API returned empty response" };
    }

    // Store consolidation artifact
    if (db && jobRunId) {
      storeJobArtifact(db, jobRunId, "homer-improvements", "consolidation", "json",
        consolidation.output, { inputTokens: consolidation.inputTokens, outputTokens: consolidation.outputTokens });
    }

    let improvement: z.infer<typeof ImprovementSchema>;
    try {
      improvement = parseSwarmJSON(consolidation.output, ImprovementSchema);
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      logger.error({ error: msg, raw: consolidation.output.slice(0, 500) }, "Failed to parse consolidated improvement");
      return { success: false, output: "", error: `Parse failed: ${msg}` };
    }

    // Dedup check
    const titleLower = improvement.title.toLowerCase();
    const isDuplicate = existingTitles.some(t => {
      const impWords = new Set(titleLower.split(/\s+/));
      const existWords = new Set(t.split(/\s+/));
      const overlap = [...impWords].filter(w => existWords.has(w)).length;
      return overlap >= 3;
    });

    if (isDuplicate) {
      return { success: true, output: `Suggested "${improvement.title}" but it's a duplicate of an existing idea` };
    }

    // Route based on risk score
    if (improvement.risk_score <= 7) {
      const planText = `## Implementation Plan

### ${improvement.title}

**Risk:** ${improvement.risk_score}/10 — ${improvement.risk_explanation}
**Category:** ${improvement.category || "improvement"}
**Files:** ${improvement.files_affected.join(", ")}
**Effort:** ~${improvement.estimated_effort_minutes || "?"} minutes

### Description
${improvement.description}

### Step 1: Implementation Details
${improvement.implementation_plan}

### Files to Modify
${improvement.files_affected.map(f => `- \`${f}\``).join("\n")}
`;

      logger.info(
        { title: improvement.title, risk: improvement.risk_score, files: improvement.files_affected },
        "Generated executable improvement plan"
      );

      // Track outcome for executable plans too
      const planId = `homer_plan_${new Date().toISOString().slice(5, 10).replace("-", "")}_${improvement.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}`;
      try {
        if (db) trackImprovement(db, planId, improvement.title);
      } catch { /* best-effort */ }

      return { success: true, output: planText };
    }

    // Risk > 7: save as idea file for human review
    const now = new Date();
    const timestamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;
    const slug = improvement.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    const id = `homer_${now.toISOString().slice(5, 10).replace("-", "")}_${slug}`;

    const parsed: ParsedIdea = {
      id,
      title: improvement.title,
      status: "draft",
      source: "homer-analysis",
      content: improvement.description,
      context: `${improvement.implementation_plan}\n\nRisk: ${improvement.risk_score}/10 — ${improvement.risk_explanation}\n\nAnalysis files:\n- ${geminiOutputPath}\n- ${codexOutputPath}`,
      tags: ["homer-improvement", `risk-${improvement.risk_score}`],
      timestamp,
    };

    saveIdeaFile(parsed);

    try {
      if (db) trackImprovement(db, id, improvement.title);
    } catch { /* outcome tracking best-effort */ }

    const output = `Generated improvement "${improvement.title}" (risk ${improvement.risk_score}/10 — saved as idea)`;
    logger.info({ id, title: improvement.title, risk: improvement.risk_score }, "Wrote high-risk homer improvement as idea");

    return { success: true, output };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Homer improvements failed");
    return { success: false, output: "", error: msg };
  }
}
