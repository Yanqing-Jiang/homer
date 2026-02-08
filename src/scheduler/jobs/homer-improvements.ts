/**
 * HOMER Improvements — Single Gemini Pro API call
 *
 * Replaces the Claude-based homer-improvements scheduler job.
 * Analyzes the Homer codebase and suggests 1-2 high-impact, low-effort improvements.
 * Uses Gemini Pro for deeper reasoning, writes results as idea files.
 */

import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { z } from "zod";
import { executeGeminiAPI } from "../../executors/gemini.js";
import { parseSwarmJSON } from "../../executors/model-swarm.js";
import { buildSchedulerContext } from "../shared-context.js";
import { loadIdeasFromDir, saveIdeaFile, type ParsedIdea } from "../../ideas/parser.js";
import { logger } from "../../utils/logger.js";

const ARCHITECTURE_MD = "/Users/yj/homer/architecture.md";

// ============================================
// SCHEMAS
// ============================================

const ImprovementSchema = z.object({
  title: z.string().min(5),
  content: z.string().min(30),
  context: z.string(),
  impact: z.enum(["high", "medium"]),
  effort: z.enum(["low", "medium"]),
});

const ImprovementsArraySchema = z.array(ImprovementSchema);

// ============================================
// MAIN
// ============================================

export async function runHomerImprovements(): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  try {
    // Gather context
    const architectureMd = existsSync(ARCHITECTURE_MD)
      ? readFileSync(ARCHITECTURE_MD, "utf-8")
      : "(architecture.md not found)";

    // Get source file listing
    let fileListing = "";
    try {
      fileListing = execSync("find /Users/yj/homer/src -name '*.ts' | sort", {
        encoding: "utf-8",
        timeout: 10_000,
      }).trim();
    } catch {
      fileListing = "(file listing unavailable)";
    }

    // Load existing idea titles for dedup
    const existingIdeas = loadIdeasFromDir();
    const existingTitles = existingIdeas.map((i) => i.title.toLowerCase());

    // Build scheduler context (includes goals from me.md)
    let schedulerContext: string;
    try {
      schedulerContext = await buildSchedulerContext({ dailyLogDays: 3 });
    } catch {
      schedulerContext = "Context unavailable";
    }

    const prompt = `Analyze the HOMER codebase and suggest 1-2 high-impact, low-effort improvements.

## Architecture

${architectureMd.slice(0, 8000)}

## Source Files

${fileListing}

## Existing Ideas (avoid duplicates)

${existingTitles.slice(0, 50).map((t) => `- ${t}`).join("\n")}

## Instructions

Focus on:
1. **Reliability** — error handling gaps, race conditions, missing retries
2. **Performance** — unnecessary API calls, slow paths, missing caches
3. **Features** — small additions that would multiply HOMER's usefulness
4. **Code quality** — dead code, over-complexity, missing types
5. **Goal alignment** — does HOMER's architecture actually serve Yanqing's priorities?
   - Is the quant trading integration (MAHORAGA) well-supported by Homer?
   - Is the career OS / job hunt pipeline reliable?
   - Are content creation tools connected to the automation layer?
   - What capability gap would give the biggest leverage for Yanqing's current goals?

For each improvement:
- Explain WHAT to change and WHERE (specific files)
- Explain WHY it matters (connect to Yanqing's goals)
- Rate impact (high/medium) and effort (low/medium)

## Output Format

Return ONLY a JSON array:
[{"title": "Short improvement title", "content": "Detailed description with file paths", "context": "Why this matters for Yanqing", "impact": "high"|"medium", "effort": "low"|"medium"}]

Maximum 2 improvements. Quality over quantity.`;

    const result = await executeGeminiAPI(prompt, {
      model: "pro3",
      useGrounding: false,
      systemPrompt: schedulerContext.slice(0, 30000),
      maxTokens: 4096,
      temperature: 0.4,
    });

    if (result.exitCode !== 0) {
      return { success: false, output: "", error: `Gemini Pro API error: ${result.output}` };
    }

    // Parse and validate
    let improvements: z.infer<typeof ImprovementsArraySchema>;
    try {
      improvements = parseSwarmJSON(result.output, ImprovementsArraySchema);
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      logger.error({ error: msg }, "Failed to parse homer improvements");
      return { success: false, output: "", error: `Parse failed: ${msg}` };
    }

    if (improvements.length === 0) {
      return { success: true, output: "No improvements suggested this run" };
    }

    // Dedup against existing ideas
    const deduped = improvements.filter((imp) => {
      const titleLower = imp.title.toLowerCase();
      return !existingTitles.some((t) => {
        // Simple word overlap check
        const impWords = new Set(titleLower.split(/\s+/));
        const existWords = new Set(t.split(/\s+/));
        const overlap = [...impWords].filter((w) => existWords.has(w)).length;
        return overlap >= 3;
      });
    });

    // Write idea files
    const now = new Date();
    const timestamp = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 16)}`;
    let written = 0;

    for (const imp of deduped) {
      const slug = imp.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);
      const id = `homer_${now.toISOString().slice(5, 10).replace("-", "")}_${slug}`;

      const parsed: ParsedIdea = {
        id,
        title: imp.title,
        status: "draft",
        source: "homer-analysis",
        content: imp.content,
        context: `${imp.context}\n\nImpact: ${imp.impact}, Effort: ${imp.effort}`,
        tags: ["homer-improvement", `impact-${imp.impact}`, `effort-${imp.effort}`],
        timestamp,
      };

      saveIdeaFile(parsed);
      written++;
      logger.info({ id, title: imp.title, impact: imp.impact, effort: imp.effort }, "Wrote homer improvement idea");
    }

    const output = written > 0
      ? `Generated ${improvements.length} improvement(s), wrote ${written} after dedup (${result.inputTokens ?? "?"} in / ${result.outputTokens ?? "?"} out tokens)`
      : `Generated ${improvements.length} improvement(s) but all were duplicates of existing ideas`;

    return { success: true, output };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Homer improvements failed");
    return { success: false, output: "", error: msg };
  }
}
