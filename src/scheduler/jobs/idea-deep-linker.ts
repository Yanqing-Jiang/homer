/**
 * Idea Deep-Linker — Single-pass Codex 5.4 HIGH reasoning
 *
 * Replaces synthesizer Pass 1 (scoring) and Pass 3 (enrichment) for all sources.
 * Reads 3 days of session summaries + all draft ideas + unprocessed scrapes +
 * permanent memory files in a single large-context Codex call.
 *
 * Schedule: 1:00am daily (after idea-ingest at midnight)
 */

import { readFileSync, existsSync } from "fs";
import { z } from "zod";
import { executeCodexCLI } from "../../executors/codex-cli.js";
import { parseSwarmJSON } from "../../executors/model-swarm.js";
import { getUnprocessedScrapes, markProcessed, scoreAndEnrichScrape, type StoredScrape } from "../../scraping/scrape-store.js";
import * as ideaDao from "../../ideas/dao.js";
import type { ParsedIdea } from "../../ideas/parser.js";
import { loadRecentMdFiles } from "./idea-synthesizer.js";
import { logger } from "../../utils/logger.js";
import { storeJobArtifact } from "./artifact-store.js";
import { PATHS } from "../../config/paths.js";
import type { StateManager } from "../../state/manager.js";

// ============================================
// SCHEMAS
// ============================================

const DeepLinkResultSchema = z.object({
  scrape_id: z.string(),
  score: z.number().min(0).max(10),
  dimensions: z.array(z.string()),
  title: z.string().min(5).max(120),
  session_connections: z.array(z.string()).max(3),
  cross_links: z.array(z.object({
    target: z.string(),
    relationship: z.string(),
    strength: z.number().min(0).max(1),
  })).max(5),
  enrichment: z.object({
    deep_dive: z.object({
      core_claim: z.string(),
      evidence: z.string(),
      risks: z.array(z.string()).max(3),
      validation_path: z.string(),
    }),
    deep_links: z.array(z.object({
      target: z.string(),
      relationship: z.string(),
      strength: z.number().min(0).max(1),
    })).max(5),
    homer_improvement: z.object({
      relevant: z.boolean(),
      summary: z.string(),
      area: z.enum(["idea-pipeline", "morning-brief", "scheduler", "career-os", "mahoraga", "content-pipeline", "new-mcp", "none"]),
      priority: z.enum(["high", "medium", "low"]),
      plan: z.array(z.object({
        step: z.number(),
        action: z.string(),
        file: z.string(),
        effort: z.enum(["S", "M", "L"]),
      })).max(5),
    }),
  }),
  action: z.enum(["promote", "enrich", "archive", "skip"]),
});

const DeepLinkerOutputSchema = z.object({
  results: z.array(DeepLinkResultSchema),
  stats: z.object({
    scrapes_analyzed: z.number(),
    scored_above_5: z.number(),
    session_connections_found: z.number(),
    cross_links_found: z.number(),
  }),
});

type DeepLinkerOutput = z.infer<typeof DeepLinkerOutputSchema>;

// ============================================
// HELPERS
// ============================================

function loadFileIfExists(path: string, maxChars?: number): string {
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf-8");
  return maxChars ? content.slice(0, maxChars) : content;
}

function formatScrapesCompact(scrapes: StoredScrape[]): string {
  return scrapes.map((s, i) => {
    const meta = s.metadata ? JSON.parse(s.metadata) : {};
    return `[${i + 1}] ID: ${s.id} | Source: ${s.source} | ${s.title || "(no title)"}
URL: ${s.url || "N/A"} | Author: ${s.author || "N/A"}${meta.stars ? ` | Stars: ${meta.stars}` : ""}
${(s.raw_content || "").slice(0, 1500)}`;
  }).join("\n---\n");
}

function formatIdeasCompact(ideas: ParsedIdea[]): string {
  return ideas.map(i => {
    const tags = i.tags?.join(",") ?? "";
    const enriched = i.enrichment ? " [enriched]" : "";
    return `- ${i.id}: ${i.title} [${tags}]${enriched} (${i.status})`;
  }).join("\n");
}

// ============================================
// MAIN
// ============================================

export async function runIdeaDeepLinker(stateManager: StateManager, jobRunId?: number): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  const db = stateManager.getDb();

  try {
    // 1. Load unprocessed scrapes (last 48h)
    const unprocessed = getUnprocessedScrapes(db, 48);
    if (unprocessed.length === 0) {
      return { success: true, output: "No unprocessed scrapes for deep-linking" };
    }

    logger.info({ count: unprocessed.length }, "Starting idea deep-linker");

    // 2. Load 3 days of session summaries
    const sessions = stateManager.getRecentSessions(3, { activeOnly: true, excludeSubAgents: true });
    const sessionBlocks: string[] = [];
    const byDate = new Map<string, string[]>();

    for (const s of sessions) {
      const ts = s.startedAt ?? s.createdAt;
      const day = ts.slice(0, 10);
      const time = ts.slice(11, 16) || "00:00";
      const agent = s.agent ?? "unknown";
      const title = s.title ?? "untitled";
      const summary = s.summary ?? "";

      if (!byDate.has(day)) byDate.set(day, []);
      byDate.get(day)!.push(`[${time}] ${agent}: ${title}\n${summary}`);
    }

    for (const [day, entries] of byDate) {
      sessionBlocks.push(`### ${day}\n${entries.join("\n\n")}`);
    }

    // 3. Load all draft/review ideas for cross-linking
    const existingIdeas = ideaDao.getAllIdeas(db, { status: "draft" });
    const reviewIdeas = ideaDao.getAllIdeas(db, { status: "review" });
    const allActiveIdeas = [...existingIdeas, ...reviewIdeas];

    // 4. Load permanent memory files
    const meMd = loadFileIfExists(PATHS.me);
    const workMd = loadFileIfExists(PATHS.work);
    const prefsMd = loadFileIfExists(PATHS.preferences, 3000);
    const toolsMd = loadFileIfExists(PATHS.tools, 3000);
    const denyHistory = loadFileIfExists(PATHS.denyHistory, 3000);

    // 5. Load recent agent outputs (raw, not pre-digested — Codex has the context for it)
    const recentOutputs = loadRecentMdFiles(7, 12000, 1200);

    // 6. Build the unified prompt
    const prompt = `You are Homer's idea deep-linker. Analyze unprocessed scrapes against Yanqing's recent sessions, existing ideas, and permanent memory. Score, enrich, and cross-link each scrape in a SINGLE pass.

## Yanqing's Identity & Goals
${meMd.slice(0, 4000)}

## Active Work & Projects
${workMd.slice(0, 4000)}

## Preferences
${prefsMd}

## Homer Architecture & Tools
${toolsMd}

## Deny History (skip these topics)
${denyHistory}

## Recent Session Summaries (Last 3 Days)
${sessionBlocks.join("\n\n") || "(no recent sessions)"}

## Recent Agent Outputs (Last 7 Days)
${recentOutputs || "(none)"}

## Existing Draft/Review Ideas (for cross-linking and dedup)
${formatIdeasCompact(allActiveIdeas)}

## Unprocessed Scrapes to Analyze
${formatScrapesCompact(unprocessed)}

## Instructions

For EACH scrape above, produce:

1. **Score** (0-10): How relevant is this to Yanqing's active goals/projects?
   - 8-10: Directly connects to an active project or stated goal
   - 5-7: Relevant to interests but not immediately actionable
   - 0-4: Tangential or off-topic

2. **Dimensions**: Tag with preference dimensions (e.g., "topic:ai-agents", "source:github-trending", "project:mahoraga")

3. **Title**: A specific, actionable title (10-120 chars). Not generic.

4. **Session Connections**: Check the last 3 days of sessions. Did Yanqing discuss anything related? Be specific — cite the session date/title. Empty array if no connection.

5. **Cross-Links**: Link to existing draft/review ideas that are complementary, conflicting, or duplicative. Reference by idea ID. Empty array if none.

6. **Enrichment**: For scrapes scoring 5+, provide:
   - deep_dive: core claim, evidence, risks, fastest validation path
   - deep_links: connections to Homer projects (Career OS, MAHORAGA, Shadow Data Pulse, PICE, ProfitSphere, openclaw, Homer subsystems)
   - homer_improvement: is this actionable for Homer? If yes, specify area, priority, and 1-3 step plan with file paths

7. **Action**: What should happen?
   - "promote": Score 7+, create/enhance idea
   - "enrich": Score 5-7, add enrichment but keep as draft
   - "archive": Score <3 or matches deny history
   - "skip": Score 3-5, not worth processing yet

## Output

Return ONLY a JSON object (no markdown fences):
{
  "results": [{
    "scrape_id": "...",
    "score": 8.5,
    "dimensions": ["topic:X"],
    "title": "Specific actionable title",
    "session_connections": ["Mar 11 session on X discussed same pattern"],
    "cross_links": [{"target": "tweet_123", "relationship": "complementary", "strength": 0.8}],
    "enrichment": {
      "deep_dive": {"core_claim": "...", "evidence": "...", "risks": ["..."], "validation_path": "..."},
      "deep_links": [{"target": "MAHORAGA", "relationship": "accelerates", "strength": 0.9}],
      "homer_improvement": {"relevant": true, "summary": "...", "area": "scheduler", "priority": "high", "plan": [{"step": 1, "action": "...", "file": "src/...", "effort": "S"}]}
    },
    "action": "promote"
  }],
  "stats": {
    "scrapes_analyzed": N,
    "scored_above_5": N,
    "session_connections_found": N,
    "cross_links_found": N
  }
}`;

    logger.info({
      promptLength: prompt.length,
      scrapeCount: unprocessed.length,
      sessionCount: sessions.length,
      ideaCount: allActiveIdeas.length,
    }, "Running idea deep-linker via Codex HIGH");

    // 7. Execute Codex
    const result = await executeCodexCLI(
      prompt + "\n\nReturn ONLY valid JSON, no markdown fences.",
      {
        cwd: process.env.HOME ?? "/Users/yj",
        model: "gpt-5.4",
        reasoningEffort: "high",
        timeout: 1200_000, // 20 minutes
      },
    );

    if (result.exitCode !== 0 || !result.output) {
      logger.error({ exitCode: result.exitCode, output: result.output?.slice(0, 300) }, "Codex deep-linker failed");
      return { success: false, output: "", error: `Codex exited ${result.exitCode}` };
    }

    // 8. Parse output
    let parsed: DeepLinkerOutput;
    try {
      parsed = parseSwarmJSON(result.output, DeepLinkerOutputSchema);
    } catch (err) {
      logger.error({ error: err, outputLen: result.output.length }, "Failed to parse deep-linker output");
      return { success: false, output: "", error: `Parse failed: ${err}` };
    }

    // 9. Apply results — pre-score for synthesizer, don't create ideas directly
    let prescored = 0;
    let archived = 0;
    let skipped = 0;

    for (const r of parsed.results) {
      if (r.action === "archive" || r.action === "skip") {
        // Fully mark as processed — synthesizer won't see these
        markProcessed(db, r.scrape_id, undefined, r.score);
        if (r.action === "archive") archived++;
        else skipped++;
        continue;
      }

      // For promote/enrich: store score + enrichment in metadata but leave unprocessed.
      // The synthesizer will pick these up, skip Pass 1 (already scored) and
      // Pass 3 (already enriched), and only run Pass 2 cross-source synthesis.
      scoreAndEnrichScrape(db, r.scrape_id, r.score, {
        title: r.title,
        dimensions: r.dimensions,
        session_connections: r.session_connections,
        cross_links: r.cross_links,
        enrichment: r.enrichment,
        action: r.action,
      });
      prescored++;
    }

    // Store artifact
    if (jobRunId) {
      storeJobArtifact(db, jobRunId, "idea-deep-linker", "results", "json",
        JSON.stringify(parsed), { prescored, archived, skipped });
    }

    const parts: string[] = [];
    parts.push(`${unprocessed.length} scrapes analyzed`);
    if (prescored > 0) parts.push(`${prescored} pre-scored for synthesizer`);
    if (archived > 0) parts.push(`${archived} archived`);
    if (skipped > 0) parts.push(`${skipped} skipped`);
    if (parsed.stats.session_connections_found > 0) {
      parts.push(`${parsed.stats.session_connections_found} session connections`);
    }
    if (parsed.stats.cross_links_found > 0) {
      parts.push(`${parsed.stats.cross_links_found} cross-links`);
    }

    const output = `Deep-linker: ${parts.join(", ")}`;
    logger.info({ output }, "Idea deep-linker complete");
    return { success: true, output };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Idea deep-linker failed");
    return { success: false, output: "", error: msg };
  }
}
