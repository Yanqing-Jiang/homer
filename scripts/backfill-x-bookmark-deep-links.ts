#!/usr/bin/env npx tsx
/**
 * One-time backfill: populate ideas.enrichment for the latest surviving X bookmarks.
 *
 * Default target set:
 * - Surviving ideas linked to the most recent x-bookmark scrape window
 * - Falls back to the 4 most recent x-bookmarks without enrichment
 *
 * Run:
 *   npx tsx scripts/backfill-x-bookmark-deep-links.ts
 *   npx tsx scripts/backfill-x-bookmark-deep-links.ts tweet_123 tweet_456
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import Database from "better-sqlite3";
import { z } from "zod";
import { runMigrations } from "../src/state/migrations/index.js";
import { PATHS } from "../src/config/paths.js";
import { executeGeminiCLIDirect, GEMINI_CLI_PRO_MODEL } from "../src/executors/gemini-cli.js";
import { parseSwarmJSON } from "../src/executors/model-swarm.js";
import * as ideaDao from "../src/ideas/dao.js";
import type { ParsedIdea } from "../src/ideas/parser.js";

const REPORT_DIR = join(PATHS.homerRoot, "output", "codex");

const EnrichmentSchema = z.object({
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
    user_context: z.string(),
    plan: z.array(z.object({
      step: z.number(),
      action: z.string(),
      file: z.string(),
      effort: z.enum(["S", "M", "L"]),
    })).max(5),
    automation_potential: z.string(),
  }),
});

type IdeaEnrichment = z.infer<typeof EnrichmentSchema>;

function loadFileIfExists(path: string, maxChars?: number): string {
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf-8");
  return maxChars ? content.slice(0, maxChars) : content;
}

function loadRecentMdFiles(maxDays = 7, maxTotalChars = 4000, perFileCap = 700): string {
  const searchDirs = [
    join(PATHS.homerRoot, "output", "claude"),
    join(PATHS.homerRoot, "output", "codex"),
    join(PATHS.homerRoot, "output", "gemini"),
    join(PATHS.homerRoot, "output", "opus"),
    join(PATHS.homerRoot, "output", "kimi"),
    join(PATHS.homerRoot, "output", "swarm"),
    PATHS.plans,
  ];

  const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
  const entries: Array<{ path: string; mtime: number }> = [];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".md")) continue;
        const full = join(dir, name);
        try {
          const st = statSync(full);
          if (st.mtimeMs >= cutoff) entries.push({ path: full, mtime: st.mtimeMs });
        } catch {
          // Ignore unreadable files in scratch output directories.
        }
      }
    } catch {
      // Ignore missing or unreadable directories.
    }
  }

  entries.sort((a, b) => b.mtime - a.mtime);

  const parts: string[] = [];
  let total = 0;
  for (const entry of entries) {
    if (total >= maxTotalChars) break;
    try {
      const raw = readFileSync(entry.path, "utf-8").slice(0, perFileCap);
      const name = entry.path.split("/").slice(-2).join("/");
      const snippet = `### ${name}\n${raw}`;
      parts.push(snippet);
      total += snippet.length;
    } catch {
      // Ignore unreadable files.
    }
  }

  return parts.join("\n\n---\n\n");
}

async function enrichIdea(
  idea: ParsedIdea,
  context: {
    meMd: string;
    workMd: string;
    existingIdeaTitles: string;
    recentOutputs: string;
  },
): Promise<IdeaEnrichment | null> {
  const prompt = `You are Homer enriching one raw X bookmark idea for Yanqing. Return ONLY a JSON object, no markdown.

## Yanqing's Profile (me.md)
${context.meMd.slice(0, 2500)}

## Active Work (work.md)
${context.workMd.slice(0, 2500)}

## Existing Idea Titles (for deep link matching)
${context.existingIdeaTitles.slice(0, 1800)}

## Recent Agent Outputs & Plans (last 7 days)
${context.recentOutputs || "(none)"}

## Homer Architecture
Subsystems: idea-pipeline, morning-brief, scheduler, career-os, mahoraga, content-pipeline, new-mcp
Active projects: Homer Career OS, MAHORAGA, Shadow Data Pulse, PICE, ProfitSphere

## Idea to Enrich
Title: ${idea.title}
Source: ${idea.source}
Tags: ${idea.tags.join(", ")}
Link: ${idea.link || "(none)"}
Context: ${idea.context || "(none)"}
Content: ${idea.content}

## Output JSON Schema
{
  "deep_dive": {
    "core_claim": "What this bookmark is actually saying in 1-2 sentences",
    "evidence": "Concrete signals from the tweet or linked content",
    "risks": ["Risk 1", "Risk 2"],
    "validation_path": "Fastest way Yanqing could test or apply it"
  },
  "deep_links": [
    {"target": "project or existing idea name", "relationship": "accelerates|enables|replaces|feeds into|conflicts with|already explored", "strength": 0.0}
  ],
  "homer_improvement": {
    "relevant": true,
    "summary": "One-line Homer action this suggests",
    "area": "idea-pipeline|morning-brief|scheduler|career-os|mahoraga|content-pipeline|new-mcp|none",
    "priority": "high|medium|low",
    "user_context": "Why this fits Yanqing specifically",
    "plan": [
      {"step": 1, "action": "specific action", "file": "path or skill name", "effort": "S|M|L"}
    ],
    "automation_potential": "What Homer could do autonomously with this"
  }
}

Rules:
- deep_links must reference real active projects or existing idea titles from the provided context
- Return an empty deep_links array if no link is strong enough
- Set homer_improvement.relevant = false when the bookmark is interesting but does not imply a concrete Homer action
- Be specific and concrete; avoid generic product-speak`;

  try {
    const result = await executeGeminiCLIDirect(
      `${prompt}\n\nReturn ONLY a valid JSON object, no markdown fences.`,
      { model: GEMINI_CLI_PRO_MODEL, timeout: 300_000 },
    );

    if (result.exitCode !== 0 || !result.output?.trim()) {
      return null;
    }

    return parseSwarmJSON(result.output, EnrichmentSchema);
  } catch {
    return null;
  }
}

function resolveTargetIds(db: Database.Database, explicitIds: string[]): string[] {
  if (explicitIds.length > 0) return explicitIds;

  const latest = db.prepare(`
    SELECT max(scraped_at) AS scraped_at
    FROM scrapes
    WHERE source = 'x-bookmark'
  `).get() as { scraped_at?: string };

  if (latest.scraped_at) {
    const rows = db.prepare(`
      SELECT DISTINCT i.id
      FROM scrapes s
      JOIN ideas i ON i.link = s.url
      WHERE s.source = 'x-bookmark'
        AND s.scraped_at >= datetime(?, '-5 minutes')
        AND s.scraped_at <= datetime(?, '+1 minute')
        AND i.source = 'x-bookmarks'
        AND i.enrichment IS NULL
      ORDER BY s.scraped_at DESC, i.created_at DESC
    `).all(latest.scraped_at, latest.scraped_at) as Array<{ id: string }>;

    if (rows.length > 0) {
      return rows.map((row) => row.id);
    }
  }

  const fallback = db.prepare(`
    SELECT id
    FROM ideas
    WHERE source = 'x-bookmarks' AND enrichment IS NULL
    ORDER BY created_at DESC
    LIMIT 4
  `).all() as Array<{ id: string }>;

  return fallback.map((row) => row.id);
}

function formatReportEntry(idea: ParsedIdea, enrichment: IdeaEnrichment): string {
  const links = enrichment.deep_links.length > 0
    ? enrichment.deep_links.map((link) => `- ${link.target} | ${link.relationship} | strength=${link.strength}`).join("\n")
    : "- (none)";
  const plan = enrichment.homer_improvement.plan.length > 0
    ? enrichment.homer_improvement.plan.map((step) => `- ${step.step}. ${step.action} [${step.file}] (${step.effort})`).join("\n")
    : "- (none)";

  return `## ${idea.title}

- Idea ID: ${idea.id}
- Link: ${idea.link || "(none)"}
- Core claim: ${enrichment.deep_dive.core_claim}
- Evidence: ${enrichment.deep_dive.evidence}
- Validation path: ${enrichment.deep_dive.validation_path}

### Deep Links
${links}

### Homer Improvement
- Relevant: ${enrichment.homer_improvement.relevant}
- Summary: ${enrichment.homer_improvement.summary}
- Area: ${enrichment.homer_improvement.area}
- Priority: ${enrichment.homer_improvement.priority}
- User context: ${enrichment.homer_improvement.user_context}
- Automation potential: ${enrichment.homer_improvement.automation_potential}

### Plan
${plan}
`;
}

async function main() {
  const db = new Database(PATHS.db);
  db.pragma("journal_mode = WAL");
  runMigrations(db);

  const explicitIds = process.argv.slice(2);
  const targetIds = resolveTargetIds(db, explicitIds);

  if (targetIds.length === 0) {
    console.log("No target X bookmark ideas found.");
    db.close();
    return;
  }

  const existingIdeas = ideaDao.getAllIdeas(db);
  const context = {
    meMd: loadFileIfExists(PATHS.me, 3000),
    workMd: loadFileIfExists(PATHS.work, 3000),
    existingIdeaTitles: existingIdeas.slice(0, 150).map((idea) => idea.title).join("\n"),
    recentOutputs: loadRecentMdFiles(),
  };

  const reportSections: string[] = [];
  let updated = 0;
  let failed = 0;
  let skipped = 0;

  console.log(`Backfilling deep links for ${targetIds.length} X bookmark ideas`);

  for (const targetId of targetIds) {
    const idea = ideaDao.getIdea(db, targetId);
    if (!idea) {
      console.warn(`SKIP ${targetId}: idea not found`);
      skipped++;
      continue;
    }
    if (idea.enrichment) {
      console.warn(`SKIP ${targetId}: enrichment already present`);
      skipped++;
      continue;
    }

    console.log(`Enriching ${idea.id}: ${idea.title}`);
    const enrichment = await enrichIdea(idea, context);
    if (!enrichment) {
      console.warn(`FAIL ${idea.id}: enrichment generation failed`);
      failed++;
      continue;
    }

    const saved = ideaDao.updateIdea(db, idea.id, {
      enrichment: JSON.stringify(enrichment),
    });

    if (!saved) {
      console.warn(`FAIL ${idea.id}: DAO update failed`);
      failed++;
      continue;
    }

    updated++;
    reportSections.push(formatReportEntry(saved, enrichment));
  }

  let reportPath = "";
  if (reportSections.length > 0) {
    if (!existsSync(REPORT_DIR)) {
      mkdirSync(REPORT_DIR, { recursive: true });
    }
    const stamp = new Date().toISOString().replace(/[:-]/g, "").slice(0, 13);
    reportPath = join(REPORT_DIR, `x-bookmark-deep-link-backfill-${stamp}.md`);
    const report = `# X Bookmark Deep-Link Backfill

- Generated: ${new Date().toISOString()}
- Targets requested: ${targetIds.length}
- Updated: ${updated}
- Failed: ${failed}
- Skipped: ${skipped}

${reportSections.join("\n\n")}
`;
    writeFileSync(reportPath, report, "utf-8");
  }

  console.log("");
  console.log(`Updated: ${updated}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped: ${skipped}`);
  if (reportPath) {
    console.log(`Report: ${reportPath}`);
  }

  db.close();
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
