/**
 * Multi-Model Idea Analysis
 *
 * Spawns 3 agents in parallel (opus + 2x gemini flash), each writing to a .md file.
 * After completion, gathers the files and assembles a final discussion document.
 * Token-efficient: agents write to disk, main process reads files — no large
 * outputs flowing through memory or consolidation APIs.
 */

import { mkdirSync, existsSync } from "fs";
import { writeFile, readFile } from "fs/promises";
import { join } from "path";
import { executeOpenCodeCLI } from "../executors/opencode-cli.js";
import { GEMINI_CLI_FLASH_MODEL } from "../executors/gemini-cli.js";
import { buildCondensedContext } from "../scheduler/shared-context.js";
import { chunkMessage } from "../utils/chunker.js";
import { logger } from "../utils/logger.js";
import { PATHS } from "../config/paths.js";

const OUTPUT_DIR = `${PATHS.homerRoot}/output/ideas`;
const ARCHITECTURE_MD = PATHS.architectureMd;
const MAX_ARCH_CHARS = 6000;

export interface AnalysisIdea {
  id: string;
  title: string;
  content: string;
  context?: string;
  link?: string;
  source: string;
  tags?: string[];
  notes?: string;
}

interface AgentOutcome {
  label: string;
  file: string;
  success: boolean;
  summary: string;
  duration: number;
}

/**
 * Run multi-model analysis on an idea and deliver results via Telegram.
 * Each agent writes its output to a .md file. We gather files at the end.
 */
export async function analyzeIdea(
  idea: AnalysisIdea,
  notify: (text: string, parseMode?: string) => Promise<void>
): Promise<void> {
  const startTime = Date.now();
  logger.info({ ideaId: idea.id, title: idea.title }, "Starting idea analysis");

  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Load context
  const [condensedContext, architectureMd] = await Promise.all([
    buildCondensedContext(),
    loadArchitecture(),
  ]);

  const ideaBlock = buildIdeaBlock(idea);
  const ts = new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");

  // File paths for each agent
  const opusFile = join(OUTPUT_DIR, `opus-${idea.id}-${ts}.md`);
  const archFile = join(OUTPUT_DIR, `arch-${idea.id}-${ts}.md`);
  const researchFile = join(OUTPUT_DIR, `research-${idea.id}-${ts}.md`);

  const outputInstructions = (filepath: string) =>
    `\n\nOUTPUT INSTRUCTIONS:\n1. Write your full analysis to: ${filepath}\n2. Return ONLY a 3-5 sentence summary with key findings.`;

  // Spawn 3 agents in parallel
  const [opusResult, archResult, researchResult] = await Promise.allSettled([
    // Opus: strategic reasoning
    runOpusAgent(ideaBlock, condensedContext, architectureMd, outputInstructions(opusFile)),

    // Gemini Flash #1: architecture integration
    runFlashArchAgent(ideaBlock, condensedContext, architectureMd, outputInstructions(archFile)),

    // Gemini Flash #2: web research
    runFlashResearchAgent(ideaBlock, condensedContext, outputInstructions(researchFile)),
  ]);

  // Gather outcomes
  const outcomes: AgentOutcome[] = [
    settledToOutcome("opus-strategy", opusFile, opusResult),
    settledToOutcome("flash-architecture", archFile, archResult),
    settledToOutcome("flash-research", researchFile, researchResult),
  ];

  const succeeded = outcomes.filter(o => o.success);
  const failed = outcomes.filter(o => !o.success);

  logger.info(
    { ideaId: idea.id, succeeded: succeeded.length, failed: failed.length, duration: Date.now() - startTime },
    "All agents completed"
  );

  if (succeeded.length === 0) {
    await notify(`❌ Analysis failed — all agents failed for "${idea.title}". Try again later.`);
    return;
  }

  // Read agent output files
  const agentSections: string[] = [];
  for (const o of outcomes) {
    const content = await readFileSafe(o.file);
    const status = o.success ? "✅" : "❌";
    const header = `## ${o.label} ${status} (${Math.round(o.duration / 1000)}s)`;
    if (content) {
      agentSections.push(`${header}\n\n${content}`);
    } else if (o.success) {
      // Agent succeeded but didn't write file — use summary from stdout
      agentSections.push(`${header}\n\n${o.summary}`);
    } else {
      agentSections.push(`${header}\n\n*Agent failed: ${o.summary}*`);
    }
  }

  // Assemble final discussion document
  const discussionDoc = `# Idea Discussion: ${idea.title}

**Idea ID:** ${idea.id}
**Analyzed:** ${new Date().toISOString()}
**Agents:** ${outcomes.map(o => `${o.label} (${o.success ? "✅" : "❌"})`).join(", ")}

---

${agentSections.join("\n\n---\n\n")}

---

## Idea Details
${ideaBlock}
`;

  const finalPath = join(OUTPUT_DIR, `discuss-${idea.id}-${ts}.md`);
  await writeFile(finalPath, discussionDoc, "utf-8");

  logger.info({ ideaId: idea.id, finalPath, duration: Date.now() - startTime }, "Analysis complete");

  // Send to Telegram — agent summaries + file reference
  const summaryLines = outcomes.map(o => {
    const icon = o.success ? "✅" : "❌";
    return `${icon} ${o.label}: ${o.summary.slice(0, 300)}`;
  });

  const telegramMsg = `🔬 Analysis: ${idea.title}\n\n${summaryLines.join("\n\n")}`;
  const chunks = chunkMessage(telegramMsg);

  for (const chunk of chunks) {
    await notify(chunk);
  }

  await notify(`📁 Full analysis: ${finalPath}`);
}

// ============================================
// AGENT RUNNERS
// ============================================

async function runOpusAgent(
  ideaBlock: string,
  condensedContext: string,
  architectureMd: string,
  outputInstructions: string
): Promise<{ summary: string; duration: number }> {
  const startTime = Date.now();
  const prompt = `You are analyzing an idea for Yanqing.

## Context
${condensedContext}

## Architecture (excerpt)
${architectureMd.slice(0, 3000)}

## Idea
${ideaBlock}

## Your Task
Analyze this idea across 4 dimensions:
1. **Strategic Fit** — How well does this align with Yanqing's current goals and projects? Is this the right time?
2. **Risk Analysis** — What could go wrong? Technical risk, time sink risk, opportunity cost.
3. **Execution Approach** — If we proceed, what's the smartest path? MVP scope, key milestones.
4. **Opportunity Cost** — What else could this time be spent on? Is this higher leverage than alternatives?

Be direct and opinionated. Give a clear recommendation: pursue, defer, or drop.
${outputInstructions}`;

  const context = `${condensedContext}\n\n## Architecture\n${architectureMd}`;
  const result = await executeOpenCodeCLI(prompt, context, {
    model: "github-copilot/claude-opus-4.6",
    timeout: 300_000,
  });

  if (result.exitCode !== 0) {
    throw new Error(result.output.slice(0, 500));
  }

  return { summary: result.output.slice(0, 1000), duration: Date.now() - startTime };
}

async function runFlashArchAgent(
  ideaBlock: string,
  condensedContext: string,
  architectureMd: string,
  outputInstructions: string
): Promise<{ summary: string; duration: number }> {
  const startTime = Date.now();
  const context = `${condensedContext}\n\n## Architecture\n${architectureMd}`;
  const prompt = `Analyze this idea from a Homer architecture perspective:

## Idea
${ideaBlock}

## Your Task
Focus on these 4 dimensions:
1. **Integration Points** — Where does this connect to Homer's existing systems? Which modules, schedulers, MCP tools?
2. **Technical Feasibility** — Can Homer's current stack handle this? What's missing?
3. **Efficiency Gains** — Does this reduce manual work or create compounding value?
4. **Implementation Sketch** — Outline specific files to modify/create, key functions, and estimated complexity (small/medium/large).

Reference specific file paths and module names from the architecture.
${outputInstructions}`;

  const result = await executeOpenCodeCLI(prompt, context, {
    model: `google/${GEMINI_CLI_FLASH_MODEL}`,
    timeout: 180_000,
  });

  if (result.exitCode !== 0) {
    throw new Error(result.output.slice(0, 500));
  }

  return { summary: result.output.slice(0, 1000), duration: Date.now() - startTime };
}

async function runFlashResearchAgent(
  ideaBlock: string,
  condensedContext: string,
  outputInstructions: string
): Promise<{ summary: string; duration: number }> {
  const startTime = Date.now();
  const prompt = `Research this idea for Yanqing:

## Idea
${ideaBlock}

## Your Task
Use web search to investigate these 4 dimensions:
1. **Prior Art** — What similar projects, tools, or products exist? How do they compare?
2. **Market Context** — Is there demand, competition, or a gap this fills?
3. **Creative Angles** — What unexpected approaches or combinations could make this more interesting?
4. **Key Resources** — Find relevant repos, articles, APIs, or tools that would accelerate execution.

Provide specific URLs and names, not vague references.
${outputInstructions}`;

  const result = await executeOpenCodeCLI(prompt, condensedContext, {
    model: `google/${GEMINI_CLI_FLASH_MODEL}`,
    timeout: 180_000,
  });

  if (result.exitCode !== 0) {
    throw new Error(result.output.slice(0, 500));
  }

  return { summary: result.output.slice(0, 1000), duration: Date.now() - startTime };
}

// ============================================
// HELPERS
// ============================================

function loadArchitecture(): string {
  try {
    if (!existsSync(ARCHITECTURE_MD)) return "(architecture.md not found)";
    const { readFileSync } = require("fs");
    const content = readFileSync(ARCHITECTURE_MD, "utf-8") as string;
    return content.slice(0, MAX_ARCH_CHARS);
  } catch {
    return "(failed to read architecture.md)";
  }
}

function buildIdeaBlock(idea: AnalysisIdea): string {
  const parts = [`**Title:** ${idea.title}`];
  parts.push(`**Source:** ${idea.source}`);
  if (idea.tags?.length) parts.push(`**Tags:** ${idea.tags.join(", ")}`);
  if (idea.link) parts.push(`**Link:** ${idea.link}`);
  parts.push(`\n${idea.content}`);
  if (idea.context) parts.push(`\n**Context:** ${idea.context}`);
  if (idea.notes) parts.push(`\n**Notes:** ${idea.notes}`);
  return parts.join("\n");
}

function settledToOutcome(
  label: string,
  file: string,
  result: PromiseSettledResult<{ summary: string; duration: number }>
): AgentOutcome {
  if (result.status === "fulfilled") {
    return {
      label,
      file,
      success: true,
      summary: result.value.summary,
      duration: result.value.duration,
    };
  }
  const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
  return {
    label,
    file,
    success: false,
    summary: msg.slice(0, 500),
    duration: 0,
  };
}

async function readFileSafe(filepath: string): Promise<string | null> {
  try {
    if (!existsSync(filepath)) return null;
    return await readFile(filepath, "utf-8");
  } catch {
    return null;
  }
}
