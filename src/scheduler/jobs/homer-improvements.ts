/**
 * HOMER Improvements — LLM-driven codebase analysis + executable plan generation.
 *
 * Reads ACTUAL source code (~80K chars), checks build health, queries failure history.
 * LLM decides what to improve, rates risk, writes implementation plan.
 * Risk ≤ 7: output triggers isPlanRequiringApproval() → Telegram → executePlan()
 * Risk > 7: saved as idea file for human review
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { z } from "zod";
import { executeGeminiAPI } from "../../executors/gemini.js";
import { parseSwarmJSON } from "../../executors/model-swarm.js";
import { buildSchedulerContext } from "../shared-context.js";
import { loadIdeasFromDir, saveIdeaFile, type ParsedIdea } from "../../ideas/parser.js";
import { logger } from "../../utils/logger.js";
import type Database from "better-sqlite3";

const HOMER_DIR = "/Users/yj/homer";
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

export async function runHomerImprovements(db?: Database.Database): Promise<{
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

    let schedulerContext: string;
    try {
      schedulerContext = await buildSchedulerContext({ dailyLogDays: 3 });
    } catch {
      schedulerContext = "Context unavailable";
    }

    const prompt = `Analyze the Homer codebase and suggest exactly 1 improvement.

## Current Build Status
Build ${buildHealth.passes ? "PASSES" : "FAILS"}
${buildHealth.output}

## Recent Failures (last 7 days)
${recentFailures}

## Source Code (actual files)
${sourceContext}

## Complete File Listing
${fileListing}

## Yanqing's Current Priorities
${schedulerContext.slice(0, 15000)}

## Existing Ideas (avoid duplicates)
${existingTitles.slice(0, 50).map(t => "- " + t).join("\n")}

## Your Task

YOU decide what matters most based on:
- Build health (if broken, fix that first)
- Recent failure patterns (if something keeps failing, fix it)
- Code quality issues in the actual source
- Missing capabilities for Yanqing's goals
- Dead code, error handling gaps, performance issues

For your suggestion, provide:
1. **What** to change (specific files and functions)
2. **Why** it matters (connect to a real problem or goal)
3. **How** to implement it (specific enough that another LLM could execute it)
4. **Risk assessment** — your honest judgment on a 1-10 scale. Consider: how many files change, does it touch core scheduler/state, could it break existing jobs, is it easily reversible?

## Output Format

Return ONLY a JSON object:
{
  "title": "Short descriptive title",
  "description": "2-3 sentence description connecting to real impact",
  "implementation_plan": "Step-by-step implementation with specific file paths, function names, and code changes",
  "files_affected": ["src/path/to/file.ts"],
  "risk_score": 1-10,
  "risk_explanation": "Why this risk level — be honest",
  "estimated_effort_minutes": 5-60,
  "category": "reliability|performance|feature|code-quality|build-fix"
}

One improvement only. Make it good.`;

    const result = await executeGeminiAPI(prompt, {
      model: "pro3",
      useGrounding: false,
      systemPrompt: schedulerContext.slice(0, 30000),
      temperature: 0.4,
      responseMimeType: "application/json",
      reasoningEffort: "high",
    });

    if (result.exitCode !== 0) {
      return { success: false, output: "", error: `Gemini Pro API error: ${result.output}` };
    }

    let improvement: z.infer<typeof ImprovementSchema>;
    try {
      improvement = parseSwarmJSON(result.output, ImprovementSchema);
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      logger.error({ error: msg }, "Failed to parse homer improvement");
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

    // Route based on LLM risk score
    if (improvement.risk_score <= 7) {
      // Output triggers isPlanRequiringApproval() in index.ts
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
      context: `${improvement.implementation_plan}\n\nRisk: ${improvement.risk_score}/10 — ${improvement.risk_explanation}`,
      tags: ["homer-improvement", `risk-${improvement.risk_score}`],
      timestamp,
    };

    saveIdeaFile(parsed);

    const output = `Generated improvement "${improvement.title}" (risk ${improvement.risk_score}/10 — saved as idea for review) (${result.inputTokens ?? "?"} in / ${result.outputTokens ?? "?"} out tokens)`;
    logger.info({ id, title: improvement.title, risk: improvement.risk_score }, "Wrote high-risk homer improvement as idea");

    return { success: true, output };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Homer improvements failed");
    return { success: false, output: "", error: msg };
  }
}
