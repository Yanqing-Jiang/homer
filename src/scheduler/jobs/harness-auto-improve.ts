/**
 * Harness Auto-Improve — Proposer Job
 *
 * Reads execution traces, eval scores, and the active harness version
 * for a target job (starting with idea-synthesizer), then proposes
 * ONE prompt diff for human approval.
 *
 * Schedule: Weekly (Sunday night)
 * Output: Markdown artifact with proposed change + rationale
 *
 * This job does NOT apply changes. It writes a proposal artifact
 * that requires human approval before any prompt file is modified.
 */

// @ts-ignore
import type Database from "better-sqlite3";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { executeCodexCLI } from "../../executors/codex-cli.js";
import { getActiveVersion, getRecentScores, getVersionHistory } from "../../harness/manager.js";
import { getTraceStats } from "../../executors/trace-writer.js";
import { SKILL_PATHS, getPrompts } from "./prompts/idea-synthesizer.js";
import { logger } from "../../utils/logger.js";
import { PATHS } from "../../config/paths.js";
import { storeJobArtifact } from "./artifact-store.js";

const PROPOSALS_DIR = join(PATHS.homerRoot, "output/auto-improve/idea-synthesizer");

interface ProposerResult {
  success: boolean;
  output: string;
  error?: string;
}

export async function runHarnessAutoImprove(
  db: Database.Database,
  jobRunId?: number,
  _signal?: AbortSignal,
): Promise<ProposerResult> {
  try {
    const targetJobId = "idea-synthesizer";

    // ── 1. Gather data ──

    const activeVersion = getActiveVersion(db, targetJobId);
    if (!activeVersion) {
      return { success: true, output: "No active harness version for idea-synthesizer yet. Skipping." };
    }

    const critiqueScores = getRecentScores(db, targetJobId, "critique_pass_rate", 14);
    const yieldScores = getRecentScores(db, targetJobId, "packet_yield", 14);
    const throughputScores = getRecentScores(db, targetJobId, "pipeline_throughput", 14);
    const traceStats = getTraceStats(db, 14);
    const versionHistory = getVersionHistory(db, targetJobId, 5);

    // Need at least 3 data points to make a meaningful proposal
    if (critiqueScores.length < 3 && yieldScores.length < 3) {
      return {
        success: true,
        output: `Insufficient data: ${critiqueScores.length} critique scores, ${yieldScores.length} yield scores. Need at least 3 of either. Skipping.`,
      };
    }

    // ── 2. Load current prompts ──

    const prompts = getPrompts();
    const promptSections = Object.entries(prompts)
      .map(([name, content]) => `### ${name}\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\``)
      .join("\n\n");

    // ── 3. Build analysis payload ──

    const avgCritique = critiqueScores.length > 0
      ? critiqueScores.reduce((s, r) => s + r.scoreValue, 0) / critiqueScores.length
      : null;
    const avgYield = yieldScores.length > 0
      ? yieldScores.reduce((s, r) => s + r.scoreValue, 0) / yieldScores.length
      : null;
    const avgThroughput = throughputScores.length > 0
      ? throughputScores.reduce((s, r) => s + r.scoreValue, 0) / throughputScores.length
      : null;

    // Get recent step traces for the target job
    let stepTraces = "";
    try {
      const rows = db.prepare(`
        SELECT step_name, success, duration_ms, error_summary, created_at
        FROM execution_traces
        WHERE job_id = ? AND trace_kind = 'step' AND created_at > datetime('now', '-14 days')
        ORDER BY created_at DESC
        LIMIT 50
      `).all(targetJobId) as Array<{
        step_name: string; success: number; duration_ms: number;
        error_summary: string | null; created_at: string;
      }>;
      if (rows.length > 0) {
        stepTraces = rows.map(r =>
          `${r.created_at} | ${r.step_name} | ${r.success ? "OK" : "FAIL"} | ${r.duration_ms}ms${r.error_summary ? ` | ${r.error_summary}` : ""}`
        ).join("\n");
      }
    } catch { /* table may not have step traces yet */ }

    const analysisPayload = `## Current Performance (last 14 days)
- Critique pass rate: ${avgCritique !== null ? `${(avgCritique * 100).toFixed(1)}%` : "no data"} (${critiqueScores.length} runs)
- Packet yield per run: ${avgYield !== null ? avgYield.toFixed(1) : "no data"} (${yieldScores.length} runs)
- Pipeline throughput: ${avgThroughput !== null ? `${(avgThroughput * 100).toFixed(1)}%` : "no data"} (${throughputScores.length} runs)

## Score Trend
${critiqueScores.map(s => `${s.scoredAt} critique_pass_rate=${s.scoreValue.toFixed(3)}`).join("\n")}
${yieldScores.map(s => `${s.scoredAt} packet_yield=${s.scoreValue.toFixed(1)}`).join("\n")}

## Executor Stats (14 days)
${traceStats.map(s => `${s.executor}: ${s.successes}/${s.total} success, avg ${s.avg_duration_ms}ms`).join("\n")}

## Step-Level Traces
${stepTraces || "(no step traces yet)"}

## Active Harness Version
Version: ${activeVersion.version}
Prompt manifest: ${JSON.stringify(activeVersion.promptManifest)}
Source hash: ${activeVersion.sourceHash}

## Version History
${versionHistory.map(v => `v${v.version} (${v.status}) by ${v.createdBy}`).join("\n")}

## Current Prompt Sections
${promptSections}`;

    // ── 4. Ask proposer model for ONE change ──

    const proposerPrompt = `You are a prompt optimization agent for Homer's idea-synthesizer pipeline.

Your job: analyze the performance data below and propose EXACTLY ONE targeted change to improve the pipeline's output quality.

RULES:
- Propose changes ONLY to the prompt text in the skill files (score, synthesize, critique, enrich)
- Do NOT propose changes to TypeScript code, database schemas, or job configuration
- Propose exactly ONE change — not multiple
- Be specific: show the exact text to add, remove, or modify
- Explain your reasoning based on the data
- Estimate the expected improvement

${analysisPayload}

Respond with this exact structure:

## Target Section
(which prompt: score | synthesize | critique | enrich)

## Problem Identified
(what pattern in the data suggests this change)

## Proposed Change
(exact diff: what to remove/add in the prompt)

## Expected Impact
(which score should improve and by roughly how much)

## Risk Assessment
(what could go wrong, what to monitor)`;

    const result = await executeCodexCLI(proposerPrompt, {
      cwd: PATHS.homerRoot,
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    if (result.exitCode !== 0 || !result.output.trim()) {
      return {
        success: false,
        output: "Proposer failed to generate a proposal",
        error: result.output.slice(0, 500),
      };
    }

    // ── 5. Write proposal artifact ──

    mkdirSync(PROPOSALS_DIR, { recursive: true });
    const timestamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
    const proposalPath = join(PROPOSALS_DIR, `proposal-${timestamp}.md`);

    const proposalContent = `# Harness Auto-Improve Proposal
**Generated:** ${new Date().toISOString()}
**Target Job:** ${targetJobId}
**Active Harness Version:** v${activeVersion.version}
**Status:** PENDING APPROVAL

---

${result.output}

---

## Performance Snapshot
- Critique pass rate: ${avgCritique !== null ? `${(avgCritique * 100).toFixed(1)}%` : "n/a"}
- Packet yield: ${avgYield !== null ? avgYield.toFixed(1) : "n/a"}
- Pipeline throughput: ${avgThroughput !== null ? `${(avgThroughput * 100).toFixed(1)}%` : "n/a"}
- Data points: ${critiqueScores.length + yieldScores.length + throughputScores.length}

## Approval
To apply this change, edit the relevant skill file at:
${Object.entries(SKILL_PATHS).map(([name, path]) => `- ${name}: \`${path}\``).join("\n")}

Then restart the daemon. The next pipeline run will register the new harness version automatically.
`;

    writeFileSync(proposalPath, proposalContent);

    // Store as job artifact
    if (jobRunId) {
      storeJobArtifact(db, jobRunId, "harness-auto-improve", "proposal", "markdown",
        proposalContent, {
          targetJob: targetJobId,
          harnessVersion: activeVersion.version,
          avgCritiquePassRate: avgCritique,
          avgPacketYield: avgYield,
        });
    }

    logger.info({ path: proposalPath, targetJob: targetJobId }, "Auto-improve proposal generated");

    return {
      success: true,
      output: `Proposal written to ${proposalPath}. Avg critique pass: ${avgCritique !== null ? (avgCritique * 100).toFixed(1) + "%" : "n/a"}, yield: ${avgYield !== null ? avgYield.toFixed(1) : "n/a"}`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Harness auto-improve failed");
    return { success: false, output: "", error: msg };
  }
}
