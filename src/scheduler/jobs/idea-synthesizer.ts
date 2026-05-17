import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
// @ts-ignore
import type Database from "better-sqlite3";
import { executeCodexCLI } from "../../executors/codex-cli.js";
import { parseSwarmJSON } from "../../executors/model-swarm.js";
import { redactForLLM } from "../../memory/secret-filter.js";
import {
  getUnprocessedScrapes,
  getScrapesForStep,
  updatePipelineStep,
  incrementPipelineAttempt,
  isStepExhausted,
  markScrapeTerminal,
  getPipelineState,
  getClusterMembers,
  type PipelineAttemptName,
  type StoredScrape,
} from "../../scraping/scrape-store.js";
import { createFingerprint, fingerprintSimilarity } from "../../ideas/fingerprint.js";
import * as ideaDao from "../../ideas/dao.js";
import type { SmartSaveResult } from "../../ideas/smart-save.js";
import * as packetDao from "../../ideas/source-packets.js";
import { formatForPrompt as getPreferenceContext } from "../../preferences/engine.js";
import { buildCondensedContext } from "../shared-context.js";
import { logger } from "../../utils/logger.js";
import { storeJobArtifact } from "./artifact-store.js";
import { deepFetchScrapes } from "../../scraping/deep-fetch.js";
import { writeStepTrace } from "../../executors/trace-writer.js";
import { getPromptManifest, getManifestHash, getSourceHash } from "./prompts/idea-synthesizer.js";
import { registerVersion, writeEvalScore } from "../../harness/manager.js";

const CLUSTER_SIMILARITY_THRESHOLD = 0.3; // Related (lower than dedup's 0.8)
const NEAR_DUPLICATE_THRESHOLD = 0.75;    // Near-duplicate scrapes to skip
const MAX_CLUSTER_SIZE = 3;
const STEP_TIMEOUT = 180_000; // 3 min per step (Codex CLI cold-start + reasoning is slower than Claude)

const SKILL_SCORE = join(process.env.HOME ?? "/Users/yj", ".claude/skills/idea-score/SKILLS.md");
const SKILL_SYNTHESIZE = join(process.env.HOME ?? "/Users/yj", ".claude/skills/idea-synthesize/SKILLS.md");
const SKILL_CRITIQUE = join(process.env.HOME ?? "/Users/yj", ".claude/skills/idea-critique/SKILLS.md");
const SKILL_ENRICH = join(process.env.HOME ?? "/Users/yj", ".claude/skills/idea-enrich/SKILLS.md");

const TriageSchema = z.object({
  passed: z.boolean(),
  reason: z.string(),
  summary: z.string(),
  dimensions: z.array(z.string()),
});

const IDEA_TYPES = [
  "life-lesson",
  "career-truth",
  "ai-trend-deepdive",
  "tool-discovery",
  "first-principle-reframe",
  "operator-pattern",
] as const;
export type IdeaType = (typeof IDEA_TYPES)[number];

const CandidateSchema = z.object({
  title: z.string().min(5).max(150),
  content: z.string().min(50),
  relevance: z.string(),
  confidence: z.number().min(0).max(1),
  tags: z.array(z.string()),
  link: z.string().optional().default(""),
  source: z.string(),
  ideaType: z.enum(IDEA_TYPES).optional(),
  depth: z.enum(["deep", "light"]).optional(),
  whyNow: z.string().optional(),
  questionToCarry: z.string().optional(),
  readingTimeMinutes: z.number().int().min(1).max(8).optional(),
  routeSignals: z.array(z.string()).optional().default([]),
  lang: z.enum(["en", "zh", "mixed"]).optional(),
  sourcesLang: z.array(z.enum(["en", "zh"])).optional().default([]),
});

const CritiqueSchema = z.object({
  passed: z.boolean(),
  reason: z.string(),
  strengths: z.array(z.string()).optional().default([]),
  risks: z.array(z.string()).optional().default([]),
});

const IMPROVEMENT_AREAS = [
  "idea-pipeline", "morning-brief", "scheduler", "career-os",
  "mahoraga", "content-pipeline", "new-mcp", "none",
] as const;

const EnrichmentSchema = z.object({
  deep_dive: z.object({
    core_claim: z.string(),
    evidence: z.string().optional().default(""),
    risks: z.array(z.string()).max(3).optional().default([]),
    validation_path: z.string().optional().default(""),
  }),
  deep_links: z.array(z.object({
    target: z.string(),
    relationship: z.string(),
    strength: z.number().min(0).max(1),
  })).max(5).optional().default([]),
  homer_improvement: z.object({
    relevant: z.boolean().optional().default(false),
    summary: z.string().optional().default(""),
    area: z.enum(IMPROVEMENT_AREAS).catch("none"),
    priority: z.enum(["high", "medium", "low"]).optional().default("low"),
    user_context: z.string().optional().default(""),
    plan: z.array(z.object({
      step: z.number(),
      action: z.string(),
      file: z.string(),
      effort: z.enum(["S", "M", "L"]).catch("M"),
    })).max(5).optional().default([]),
    automation_potential: z.string().optional().default(""),
  }).optional().default({
    relevant: false, summary: "", area: "none", priority: "low",
    user_context: "", plan: [], automation_potential: "",
  }),
});

type StepResult =
  | { ok: true }
  | { ok: false; kind: "executor" | "parse" | "apply" | "exhausted" };

type SaveStepResult =
  | { ok: true; result: SmartSaveResult }
  | { ok: false; kind: "apply" | "exhausted" };

type StepFailureKind = Extract<StepResult, { ok: false }>["kind"];
type SaveFailureKind = Extract<SaveStepResult, { ok: false }>["kind"];

async function runPipelineStep(opts: {
  db: Database.Database;
  scrapes: StoredScrape[];
  step: PipelineAttemptName;
  signal: AbortSignal | undefined;
  exec: (s: StoredScrape) => Promise<StepResult>;
  onOk: (s: StoredScrape) => void;
  countFailed: (kind: StepFailureKind) => boolean;
  stepLabel: string;
  chainId: string;
  promptHash: string;
  scheduledRunId: number | undefined;
}): Promise<void> {
  const { db, scrapes, step, signal, exec, onOk, countFailed, stepLabel } = opts;
  let consecutiveExecutorFailures = 0;
  let okCount = 0;
  let failedCount = 0;
  const startedAt = Date.now();

  for (const [index, scrape] of scrapes.entries()) {
    if (signal?.aborted) break;
    if (consecutiveExecutorFailures >= 3) {
      logger.warn({ step: stepLabel, remaining: scrapes.length - index }, `3 consecutive executor failures — aborting ${stepLabel} step`);
      break;
    }
    try {
      if (isStepExhausted(db, scrape.id, step)) {
        markScrapeTerminal(db, scrape.id, "exhausted");
        countFailed("exhausted");
        continue;
      }
      const result = await exec(scrape);
      if (result.ok) {
        consecutiveExecutorFailures = 0;
        okCount++;
        onOk(scrape);
      } else {
        consecutiveExecutorFailures = result.kind === "executor" ? consecutiveExecutorFailures + 1 : 0;
        if (countFailed(result.kind)) failedCount++;
      }
    } catch (err) {
      consecutiveExecutorFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ scrapeId: scrape.id, step, error: msg }, "Unexpected scrape failure, treating as executor failure");
      if (countFailed("executor")) failedCount++;
    }
  }

  if (scrapes.length > 0) {
    writeStepTrace({
      jobId: "idea-synthesizer", chainId: opts.chainId, stepName: step,
      executor: "codex", model: "gpt-5.5", success: okCount > 0 || failedCount === 0,
      durationMs: Date.now() - startedAt, promptHash: opts.promptHash,
      scheduledRunId: opts.scheduledRunId,
    });
  }
}

function loadFileIfExists(path: string, maxChars?: number): string {
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf-8");
  return maxChars ? content.slice(0, maxChars) : content;
}

function formatScrapeForPrompt(s: StoredScrape): string {
  const meta = s.metadata ? JSON.parse(s.metadata) : {};
  return `## ${s.title || "(no title)"} (ID: ${s.id})
Source: ${s.source} | URL: ${s.url || "N/A"} | Author: ${s.author || "N/A"}
${meta.stars ? `Stars: ${meta.stars} | ` : ""}${meta.language ? `Language: ${meta.language} | ` : ""}${meta.topic ? `Topic: ${meta.topic}` : ""}

${(s.raw_content || "").slice(0, 3000)}`;
}

export function loadRecentMdFiles(maxDays = 7, maxTotalChars = 6000, perFileCap = 800): string {
  const home = process.env.HOME ?? "/Users/yj";
  const searchDirs = [
    join(home, "homer", "output", "claude"),
    join(home, "homer", "output", "codex"),
    join(home, "homer", "output", "gemini"),
    join(home, "homer", "output", "opus"),
    join(home, "homer", "output", "kimi"),
    join(home, "homer", "output", "swarm"),
  ];

  const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
  const entries: { path: string; mtime: number }[] = [];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".md")) continue;
        const full = join(dir, name);
        try {
          const st = statSync(full);
          if (st.mtimeMs >= cutoff) entries.push({ path: full, mtime: st.mtimeMs });
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip unreadable dir */ }
  }

  entries.sort((a, b) => b.mtime - a.mtime);

  const parts: string[] = [];
  let total = 0;

  for (const { path } of entries) {
    if (total >= maxTotalChars) break;
    try {
      const raw = readFileSync(path, "utf-8").slice(0, perFileCap);
      const name = path.split("/").slice(-2).join("/");
      const snippet = `### ${name}\n${raw}`;
      parts.push(snippet);
      total += snippet.length;
    } catch { /* skip */ }
  }

  return parts.join("\n\n---\n\n");
}

interface ScoredScrapeInfo {
  scrape: StoredScrape;
  score: number;
  dimensions: string[];
  summary: string;
  titleFp: ReturnType<typeof createFingerprint>;
}

function extractDimsByPrefix(dimensions: string[], prefix: string): string[] {
  return dimensions
    .filter(d => d.startsWith(prefix + ":"))
    .map(d => d.slice(prefix.length + 1));
}

function scrapeRelatedness(a: ScoredScrapeInfo, b: ScoredScrapeInfo): number {
  const aProjects = extractDimsByPrefix(a.dimensions, "project");
  const bProjects = extractDimsByPrefix(b.dimensions, "project");
  const sharedProjects = aProjects.filter(p => bProjects.includes(p)).length;

  const aTopics = extractDimsByPrefix(a.dimensions, "topic");
  const bTopics = extractDimsByPrefix(b.dimensions, "topic");
  const sharedTopics = aTopics.filter(t => bTopics.includes(t)).length;

  const titleSim = fingerprintSimilarity(a.titleFp, b.titleFp);

  let score = 0;
  if (sharedProjects > 0) score += 0.5;   // Same project = strong signal
  if (sharedTopics > 0) score += 0.2;     // Same topic = moderate signal
  score += titleSim * 0.3;                 // Title similarity = supporting signal

  return Math.min(1, score);
}

function buildClusters(scrapes: ScoredScrapeInfo[]): ScoredScrapeInfo[][] {
  if (scrapes.length === 0) return [];
  if (scrapes.length === 1) return [scrapes];

  const parent = new Map<string, string>();
  const find = (id: string): string => {
    if (!parent.has(id)) parent.set(id, id);
    let root = parent.get(id)!;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = id;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  for (const s of scrapes) parent.set(s.scrape.id, s.scrape.id);

  for (let i = 0; i < scrapes.length; i++) {
    for (let j = i + 1; j < scrapes.length; j++) {
      const a = scrapes[i]!;
      const b = scrapes[j]!;
      const rel = scrapeRelatedness(a, b);
      if (rel >= CLUSTER_SIMILARITY_THRESHOLD) {
        union(a.scrape.id, b.scrape.id);
      }
    }
  }

  const groups = new Map<string, ScoredScrapeInfo[]>();
  for (const s of scrapes) {
    const root = find(s.scrape.id);
    const group = groups.get(root);
    if (group) group.push(s);
    else groups.set(root, [s]);
  }

  const clusters: ScoredScrapeInfo[][] = [];
  for (const [, members] of groups) {
    members.sort((a, b) => b.score - a.score);
    clusters.push(members.slice(0, MAX_CLUSTER_SIZE));
  }

  clusters.sort((a, b) => (b[0]?.score ?? 0) - (a[0]?.score ?? 0));
  return clusters;
}

function stepCluster(
  db: Database.Database,
  scoredScrapes: StoredScrape[],
): { clustersFormed: number; nearDuplicatesSkipped: number; singletons: number } {
  const infos: ScoredScrapeInfo[] = scoredScrapes.map(s => {
    const pipeline = getPipelineState(db, s.id);
    return {
      scrape: s,
      score: pipeline?.score?.value ?? 0,
      dimensions: pipeline?.score?.dimensions ?? [],
      summary: pipeline?.score?.summary ?? "",
      titleFp: createFingerprint(s.title || ""),
    };
  });

  let nearDuplicatesSkipped = 0;
  const survived = new Set(infos.map(i => i.scrape.id));

  for (let i = 0; i < infos.length; i++) {
    const infoA = infos[i]!;
    if (!survived.has(infoA.scrape.id)) continue;
    for (let j = i + 1; j < infos.length; j++) {
      const infoB = infos[j]!;
      if (!survived.has(infoB.scrape.id)) continue;
      const titleSim = fingerprintSimilarity(infoA.titleFp, infoB.titleFp);
      if (titleSim >= NEAR_DUPLICATE_THRESHOLD) {
        const loser = infoA.score >= infoB.score ? infoB : infoA;
        survived.delete(loser.scrape.id);
        markScrapeTerminal(db, loser.scrape.id, "skipped", undefined, loser.score);
        logger.info({
          scrapeId: loser.scrape.id,
          title: loser.scrape.title,
          similarity: titleSim.toFixed(2),
        }, "Near-duplicate scrape skipped");
        nearDuplicatesSkipped++;
      }
    }
  }

  const remainingInfos = infos.filter(i => survived.has(i.scrape.id));
  const clusters = buildClusters(remainingInfos);

  let singletons = 0;
  let clustersFormed = 0;

  for (const cluster of clusters) {
    const now = Date.now();
    const memberIds = cluster.map(c => c.scrape.id);
    const clusterId = `cluster_${now}_${memberIds.join("_").slice(0, 60)}`;

    if (cluster.length === 1) {
      singletons++;
    } else {
      clustersFormed++;
      logger.info({
        clusterId,
        size: cluster.length,
        members: memberIds,
        topics: cluster.flatMap(c => extractDimsByPrefix(c.dimensions, "topic")).filter((v, i, a) => a.indexOf(v) === i),
      }, "Cluster formed");
    }

    for (let i = 0; i < cluster.length; i++) {
      const member = cluster[i]!;
      const role = i === 0 ? "primary" as const : "secondary" as const;
      updatePipelineStep(db, member.scrape.id, "clustered", {
        clusterId,
        role,
        memberIds,
      });
    }
  }

  return { clustersFormed, nearDuplicatesSkipped, singletons };
}

async function stepScore(
  db: Database.Database,
  scrape: StoredScrape,
  sharedContext: string,
): Promise<StepResult> {
  if (isStepExhausted(db, scrape.id, "score")) {
    markScrapeTerminal(db, scrape.id, "exhausted");
    return { ok: false, kind: "exhausted" };
  }

  const skill = loadFileIfExists(SKILL_SCORE);
  const prompt = `${skill}

---

## Context
${sharedContext.slice(0, 3000)}

## Scrape to Triage

${formatScrapeForPrompt(scrape)}

---

Decide whether this scrape is strong enough to continue in the idea pipeline.
Return ONLY a JSON object: { "passed": true|false, "reason": "why", "summary": "one-line summary", "dimensions": ["topic tags"] }`;

  let result;
  try {
    result = await executeCodexCLI(redactForLLM(prompt, "idea-synthesizer"), {
      cwd: "/tmp",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      timeout: STEP_TIMEOUT,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ scrapeId: scrape.id, error: msg }, "Triage step: executor error (not counted)");
    return { ok: false, kind: "executor" };
  }

  if (result.exitCode !== 0 || !result.output) {
    logger.warn({ scrapeId: scrape.id, exitCode: result.exitCode }, "Triage step: Sonnet call failed (not counted)");
    return { ok: false, kind: "executor" };
  }

  let parsed: z.infer<typeof TriageSchema>;
  try {
    parsed = parseSwarmJSON(result.output, TriageSchema);
  } catch (err) {
    incrementPipelineAttempt(db, scrape.id, "score");
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ scrapeId: scrape.id, error: msg }, "Triage step: parse failed (attempt counted)");
    return { ok: false, kind: "parse" };
  }

  try {
    updatePipelineStep(db, scrape.id, "scored", {
      value: parsed.passed ? 8 : 3,
      dimensions: parsed.dimensions,
      summary: parsed.summary,
    });

    db.prepare(`UPDATE scrapes SET quality_score = ? WHERE id = ?`).run(parsed.passed ? 8 : 3, scrape.id);

    if (!parsed.passed) {
      markScrapeTerminal(db, scrape.id, "skipped");
      logger.info({ scrapeId: scrape.id, reason: parsed.reason }, "Triage rejected, skipping");
    } else {
      logger.info({ scrapeId: scrape.id, dims: parsed.dimensions }, "Triage passed");
    }
    return { ok: true };
  } catch (err) {
    incrementPipelineAttempt(db, scrape.id, "score");
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ scrapeId: scrape.id, error: msg }, "Triage step: apply failed");
    return { ok: false, kind: "apply" };
  }
}

async function stepSynthesize(
  db: Database.Database,
  primaryScrape: StoredScrape,
  sharedContext: string,
): Promise<StepResult> {
  if (isStepExhausted(db, primaryScrape.id, "synthesize")) {
    markScrapeTerminal(db, primaryScrape.id, "exhausted");
    return { ok: false, kind: "exhausted" };
  }

  const pipeline = getPipelineState(db, primaryScrape.id);
  const clusterId = pipeline?.cluster?.clusterId;
  const memberIds = pipeline?.cluster?.memberIds ?? [primaryScrape.id];

  let clusterScrapes: StoredScrape[];
  if (clusterId) {
    clusterScrapes = getClusterMembers(db, clusterId);
    clusterScrapes.sort((a, b) => (a.id === primaryScrape.id ? -1 : b.id === primaryScrape.id ? 1 : 0));
  } else {
    clusterScrapes = [primaryScrape];
  }

  const scrapeBlocks = clusterScrapes.map(s => {
    const p = getPipelineState(db, s.id);
    return `${formatScrapeForPrompt(s)}

**Score:** ${p?.score?.value ?? "N/A"}/10 — ${p?.score?.summary ?? ""}
**Dimensions:** ${p?.score?.dimensions?.join(", ") ?? "none"}`;
  });

  const skill = loadFileIfExists(SKILL_SYNTHESIZE);
  const prompt = `${skill}

---

## Context
${sharedContext.slice(0, 4000)}

## Scrapes to Synthesize (${clusterScrapes.length} source${clusterScrapes.length > 1 ? "s" : ""})

${scrapeBlocks.join("\n\n---\n\n")}

---

${clusterScrapes.length > 1
    ? "Synthesize ONE sharp idea from these related sources. Find the THREAD that connects them."
    : "Extract a focused candidate idea from this scrape."}
Return ONLY the JSON object.`;

  let result;
  try {
    result = await executeCodexCLI(redactForLLM(prompt, "idea-synthesizer"), {
      cwd: "/tmp",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      timeout: STEP_TIMEOUT,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ scrapeId: primaryScrape.id, error: msg }, "Synthesize step: executor error (not counted)");
    return { ok: false, kind: "executor" };
  }

  if (result.exitCode !== 0 || !result.output) {
    logger.warn({ scrapeId: primaryScrape.id, exitCode: result.exitCode }, "Synthesize step: Sonnet call failed (not counted)");
    return { ok: false, kind: "executor" };
  }

  let parsed: z.infer<typeof CandidateSchema>;
  try {
    parsed = parseSwarmJSON(result.output, CandidateSchema);
  } catch (err) {
    incrementPipelineAttempt(db, primaryScrape.id, "synthesize");
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ scrapeId: primaryScrape.id, error: msg }, "Synthesize step: parse failed (attempt counted)");
    return { ok: false, kind: "parse" };
  }

  try {
    const tags = [...parsed.tags];
    if (clusterScrapes.length > 1 && !tags.includes("multi-source")) {
      tags.push("multi-source");
    }

    updatePipelineStep(db, primaryScrape.id, "extracted", {
      title: parsed.title,
      content: parsed.content,
      tags,
      link: parsed.link,
      relevance: parsed.relevance,
      confidence: parsed.confidence,
      source: parsed.source,
    });

    logger.info({
      scrapeId: primaryScrape.id,
      title: parsed.title,
      confidence: parsed.confidence,
      clusterSize: clusterScrapes.length,
      memberIds,
    }, "Candidate synthesized");
    return { ok: true };
  } catch (err) {
    incrementPipelineAttempt(db, primaryScrape.id, "synthesize");
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ scrapeId: primaryScrape.id, error: msg }, "Synthesize step: apply failed");
    return { ok: false, kind: "apply" };
  }
}

async function stepCritique(
  db: Database.Database,
  scrape: StoredScrape,
  sharedContext: string,
): Promise<StepResult> {
  if (isStepExhausted(db, scrape.id, "critique")) {
    markScrapeTerminal(db, scrape.id, "exhausted");
    return { ok: false, kind: "exhausted" };
  }

  const pipeline = getPipelineState(db, scrape.id);
  const candidate = pipeline?.candidate;
  if (!candidate) {
    logger.warn({ scrapeId: scrape.id }, "Critique step: no candidate found");
    markScrapeTerminal(db, scrape.id, "exhausted");
    return { ok: false, kind: "exhausted" };
  }

  const skill = loadFileIfExists(SKILL_CRITIQUE);
  const prompt = `${skill}

---

## Candidate Idea

**Title:** ${candidate.title}
**Content:** ${candidate.content}
**Relevance:** ${candidate.relevance}
**Tags:** ${candidate.tags?.join(", ") ?? "none"}

## Context
${sharedContext.slice(0, 2000)}

---

Decide whether this candidate should advance to enrichment.
Return ONLY a JSON object: { "passed": true|false, "reason": "main reason", "strengths": ["..."], "risks": ["..."] }`;

  let result;
  try {
    result = await executeCodexCLI(redactForLLM(prompt, "idea-synthesizer"), {
      cwd: "/tmp",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      timeout: STEP_TIMEOUT,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ scrapeId: scrape.id, error: msg }, "Critique step: executor error (not counted)");
    return { ok: false, kind: "executor" };
  }

  if (result.exitCode !== 0 || !result.output) {
    logger.warn({ scrapeId: scrape.id, exitCode: result.exitCode }, "Critique step: Sonnet call failed (not counted)");
    return { ok: false, kind: "executor" };
  }

  let parsed: z.infer<typeof CritiqueSchema>;
  try {
    parsed = parseSwarmJSON(result.output, CritiqueSchema);
  } catch (err) {
    incrementPipelineAttempt(db, scrape.id, "critique");
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ scrapeId: scrape.id, error: msg }, "Critique step: parse failed (attempt counted)");
    return { ok: false, kind: "parse" };
  }

  try {
    updatePipelineStep(db, scrape.id, "critiqued", {
      passed: parsed.passed,
      reason: parsed.reason,
    });

    if (!parsed.passed) {
      markScrapeTerminal(db, scrape.id, "rejected");
      logger.info({
        scrapeId: scrape.id,
        title: candidate.title,
        reason: parsed.reason,
      }, "Critique rejected");
    } else {
      logger.info({
        scrapeId: scrape.id,
        title: candidate.title,
        strengths: parsed.strengths,
      }, "Critique passed");
    }
    return { ok: true };
  } catch (err) {
    incrementPipelineAttempt(db, scrape.id, "critique");
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ scrapeId: scrape.id, error: msg }, "Critique step: apply failed");
    return { ok: false, kind: "apply" };
  }
}

async function stepEnrich(
  db: Database.Database,
  scrape: StoredScrape,
  sharedContext: string,
): Promise<StepResult> {
  if (isStepExhausted(db, scrape.id, "enrich")) {
    markScrapeTerminal(db, scrape.id, "exhausted");
    return { ok: false, kind: "exhausted" };
  }

  const pipeline = getPipelineState(db, scrape.id);
  const candidate = pipeline?.candidate;
  const critique = pipeline?.critique;
  if (!candidate || !critique) {
    logger.warn({ scrapeId: scrape.id }, "Enrich step: missing candidate or critique");
    markScrapeTerminal(db, scrape.id, "exhausted");
    return { ok: false, kind: "exhausted" };
  }

  const existingIdeas = ideaDao.getAllIdeas(db);
  const existingTitles = existingIdeas.slice(0, 50).map(i => i.title).join("\n");

  const clusterId = pipeline?.cluster?.clusterId;
  let sourceContext: string;
  if (clusterId) {
    const members = getClusterMembers(db, clusterId);
    sourceContext = members.map(s => formatScrapeForPrompt(s).slice(0, 800)).join("\n---\n");
  } else {
    sourceContext = formatScrapeForPrompt(scrape).slice(0, 1500);
  }

  const skill = loadFileIfExists(SKILL_ENRICH);
  const prompt = `${skill}

---

## Idea to Enrich

**Title:** ${candidate.title}
**Content:** ${candidate.content}
**Relevance:** ${candidate.relevance}
**Critique:** ${critique.passed ? "Passed" : "Rejected"} — ${critique.reason ?? ""}

## Context
${sharedContext.slice(0, 3000)}

## Existing Ideas (for deep_links.target references)
${existingTitles.slice(0, 1500)}

## Source Scrape(s)
${sourceContext.slice(0, 2000)}

---

Enrich this idea. Return ONLY the JSON object. Omit optional fields if not applicable.`;

  let result;
  try {
    result = await executeCodexCLI(redactForLLM(prompt, "idea-synthesizer"), {
      cwd: "/tmp",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      timeout: STEP_TIMEOUT,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ scrapeId: scrape.id, error: msg }, "Enrich step: executor error (not counted)");
    return { ok: false, kind: "executor" };
  }

  if (result.exitCode !== 0 || !result.output) {
    logger.warn({ scrapeId: scrape.id, exitCode: result.exitCode }, "Enrich step: Sonnet call failed (not counted)");
    return { ok: false, kind: "executor" };
  }

  let parsed: z.infer<typeof EnrichmentSchema>;
  try {
    parsed = parseSwarmJSON(result.output, EnrichmentSchema);
  } catch (err) {
    incrementPipelineAttempt(db, scrape.id, "enrich");
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ scrapeId: scrape.id, error: msg }, "Enrich step: parse failed (attempt counted)");
    return { ok: false, kind: "parse" };
  }

  try {
    updatePipelineStep(db, scrape.id, "enriched", parsed);

    logger.info({ scrapeId: scrape.id, title: candidate.title, hasImprovement: parsed.homer_improvement?.relevant }, "Enriched");
    return { ok: true };
  } catch (err) {
    incrementPipelineAttempt(db, scrape.id, "enrich");
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ scrapeId: scrape.id, error: msg }, "Enrich step: apply failed");
    return { ok: false, kind: "apply" };
  }
}

function stepSave(
  db: Database.Database,
  scrape: StoredScrape,
): SaveStepResult {
  if (isStepExhausted(db, scrape.id, "save")) {
    markScrapeTerminal(db, scrape.id, "exhausted");
    return { ok: false, kind: "exhausted" };
  }

  const pipeline = getPipelineState(db, scrape.id);
  if (!pipeline?.candidate || !pipeline.critique?.passed || !pipeline.enrichment) {
    logger.warn({ scrapeId: scrape.id }, "Save step: missing required pipeline data");
    markScrapeTerminal(db, scrape.id, "exhausted");
    return { ok: false, kind: "exhausted" };
  }

  const enrichment = EnrichmentSchema.safeParse(pipeline.enrichment);
  if (!enrichment.success) {
    logger.warn({ scrapeId: scrape.id, error: enrichment.error.message }, "Save step: invalid enrichment payload");
    markScrapeTerminal(db, scrape.id, "exhausted");
    return { ok: false, kind: "exhausted" };
  }

  const candidate = pipeline.candidate;
  const critique = pipeline.critique;
  const cluster = pipeline.cluster;
  const memberIds = cluster?.memberIds ?? [scrape.id];

  const now = new Date();
  const slug = candidate.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const packetId = `pkt_${now.toISOString().slice(5, 10).replace("-", "")}_${slug}`;

  try {
    const enrichmentData = enrichment.data;
    packetDao.createPacket(db, {
      id: packetId,
      clusterId: cluster?.clusterId ?? undefined,
      sourceType: candidate.source || scrape.source,
      primaryUrl: candidate.link || scrape.url || undefined,
      title: candidate.title,
      summary: `${candidate.content.slice(0, 300)}${candidate.content.length > 300 ? "..." : ""}`,
      rawContent: scrape.raw_content,
      deepFetchContent: (() => {
        try {
          const meta = scrape.metadata ? JSON.parse(scrape.metadata) : null;
          return meta?.deep_fetch?.content ?? null;
        } catch { return null; }
      })(),
      metadata: {
        author: scrape.author ?? undefined,
        externalUrls: candidate.link ? [candidate.link] : undefined,
        extractedTopics: candidate.tags ?? [],
        scrapeIds: memberIds,
      },
      enrichment: {
        candidate: {
          title: candidate.title,
          content: candidate.content,
          relevance: candidate.relevance,
          confidence: candidate.confidence,
          tags: candidate.tags ?? [],
          link: candidate.link ?? undefined,
          source: candidate.source,
        },
        critique: {
          passed: critique.passed,
          reason: critique.reason,
          strengths: [],
          risks: [],
        },
        deepDive: enrichmentData.deep_dive ? {
          coreClaim: enrichmentData.deep_dive.core_claim,
          evidence: enrichmentData.deep_dive.evidence,
          risks: enrichmentData.deep_dive.risks,
          validationPath: enrichmentData.deep_dive.validation_path,
        } : undefined,
        deepLinks: enrichmentData.deep_links?.map((l) => ({
          target: l.target,
          relationship: l.relationship,
          strength: l.strength,
        })),
        homerImprovement: enrichmentData.homer_improvement ? {
          relevant: enrichmentData.homer_improvement.relevant,
          summary: enrichmentData.homer_improvement.summary,
          area: enrichmentData.homer_improvement.area,
          priority: enrichmentData.homer_improvement.priority,
          plan: enrichmentData.homer_improvement.plan?.map((s) => s.action),
        } : undefined,
      },
      status: "queued",
    });

    packetDao.linkScrapesToPacket(db, packetId, [scrape.id], "primary");
    packetDao.linkScrapesToPacket(db, packetId, memberIds.filter(id => id !== scrape.id), "supporting");

    markScrapeTerminal(db, scrape.id, "saved", packetId, candidate.confidence);

    for (const memberId of memberIds) {
      try {
        db.prepare("UPDATE scrapes SET source_packet_id = ? WHERE id = ?").run(packetId, memberId);
      } catch { /* best-effort */ }
    }

    logger.info({
      scrapeId: scrape.id,
      packetId,
      title: candidate.title,
      clusterSize: memberIds.length,
    }, "Source packet created (queued for review)");

    return { ok: true, result: {
      action: "created",
      ideaId: packetId,
      title: candidate.title,
    } };
  } catch (err) {
    const attempts = incrementPipelineAttempt(db, scrape.id, "save");
    const exhausted = isStepExhausted(db, scrape.id, "save");
    if (exhausted) {
      markScrapeTerminal(db, scrape.id, "exhausted");
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ scrapeId: scrape.id, attempts, error: msg }, "Save step failed");
    return { ok: false, kind: exhausted ? "exhausted" : "apply" };
  }
}

export async function runIdeaSynthesizer(db: Database.Database, jobRunId?: number, signal?: AbortSignal): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  try {
    const unprocessed = getUnprocessedScrapes(db, 48, []);

    if (unprocessed.length === 0) {
      return { success: true, output: "No unprocessed scrapes to synthesize" };
    }

    logger.info({ count: unprocessed.length }, "Starting idea synthesis pipeline v3");

    const pipelineChainId = `synth_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const manifestHash = getManifestHash();

    const [condensedContext, preferences] = await Promise.all([
      buildCondensedContext(),
      (async () => {
        try { return getPreferenceContext(db); }
        catch { return ""; }
      })(),
    ]);

    const existingIdeas = ideaDao.getAllIdeas(db);
    const existingTitles = existingIdeas.slice(0, 100).map(i => i.title).join("\n");

    const sharedContext = `### Yanqing's Goals & Context
${condensedContext.slice(0, 4000)}

### Learned Preferences
${preferences || "(no preferences yet)"}

### Existing Idea Titles (AVOID duplicates)
${existingTitles.slice(0, 1500)}`;

    const stats = {
      totalScrapes: unprocessed.length,
      scored: 0,
      clustersFormed: 0,
      nearDuplicatesSkipped: 0,
      synthesized: 0,
      critiquePassed: 0,
      critiqueScoreRejected: 0,
      enriched: 0,
      saved: 0,
      enhanced: 0,
      skipped: 0,
      exhausted: 0,
      failed: 0,
    };

    const saveResults: SmartSaveResult[] = [];
    const countFailedStep = (kind: StepFailureKind | SaveFailureKind): boolean => {
      if (kind === "exhausted") {
        stats.exhausted++;
        return false;
      }
      stats.failed++;
      return true;
    };

    const needsFetch = unprocessed.filter(s => {
      const meta = s.metadata ? JSON.parse(s.metadata) : {};
      return !meta.deep_fetch?.completed;
    });
    if (needsFetch.length > 0) {
      logger.info({ count: needsFetch.length }, "Step 0: Deep-fetching external URLs");
      try {
        const fetchStats = await deepFetchScrapes(db, needsFetch);
        logger.info(fetchStats, "Step 0: Deep-fetch complete");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ error: msg }, "Step 0: Deep-fetch failed (non-fatal, continuing)");
      }
    }

    const needsScoring = getScrapesForStep(db, "pending", 48);
    logger.info({ count: needsScoring.length }, "Step 1: Scoring scrapes");

    await runPipelineStep({
      db, scrapes: needsScoring, step: "score", signal, stepLabel: "score",
      chainId: pipelineChainId, promptHash: manifestHash, scheduledRunId: jobRunId,
      exec: scrape => stepScore(db, scrape, sharedContext),
      countFailed: countFailedStep,
      onOk: scrape => {
        stats.scored++;
        const pipeline = getPipelineState(db, scrape.id);
        if (pipeline?.step === "skipped") stats.skipped++;
      },
    });

    const needsClustering = getScrapesForStep(db, "scored", 48);
    logger.info({ count: needsClustering.length }, "Step 2: Clustering scored scrapes");
    const clusterStart = Date.now();

    if (needsClustering.length > 0) {
      try {
        const clusterResult = stepCluster(db, needsClustering);
        stats.clustersFormed = clusterResult.clustersFormed;
        stats.nearDuplicatesSkipped = clusterResult.nearDuplicatesSkipped;
        logger.info({
          clusters: clusterResult.clustersFormed,
          singletons: clusterResult.singletons,
          nearDups: clusterResult.nearDuplicatesSkipped,
        }, "Clustering complete");

        writeStepTrace({
          jobId: "idea-synthesizer", chainId: pipelineChainId, stepName: "cluster",
          executor: "deterministic", success: true,
          durationMs: Date.now() - clusterStart, scheduledRunId: jobRunId,
        });
      } catch (clusterErr) {
        const msg = clusterErr instanceof Error ? clusterErr.message : String(clusterErr);
        logger.error({ error: msg, scrapeCount: needsClustering.length }, "Step 2 clustering failed — continuing to steps 3-6");
        writeStepTrace({
          jobId: "idea-synthesizer", chainId: pipelineChainId, stepName: "cluster",
          executor: "deterministic", success: false,
          durationMs: Date.now() - clusterStart, scheduledRunId: jobRunId,
        });
      }
    }

    const needsSynthesis = getScrapesForStep(db, "clustered", 48);
    logger.info({ count: needsSynthesis.length }, "Step 3: Synthesizing candidates");

    await runPipelineStep({
      db, scrapes: needsSynthesis, step: "synthesize", signal, stepLabel: "synthesize",
      chainId: pipelineChainId, promptHash: manifestHash, scheduledRunId: jobRunId,
      exec: scrape => stepSynthesize(db, scrape, sharedContext),
      countFailed: countFailedStep,
      onOk: () => { stats.synthesized++; },
    });

    const needsCritique = getScrapesForStep(db, "extracted", 48);
    logger.info({ count: needsCritique.length }, "Step 4: Critiquing candidates");

    await runPipelineStep({
      db, scrapes: needsCritique, step: "critique", signal, stepLabel: "critique",
      chainId: pipelineChainId, promptHash: manifestHash, scheduledRunId: jobRunId,
      exec: scrape => stepCritique(db, scrape, sharedContext),
      countFailed: countFailedStep,
      onOk: scrape => {
        const pipeline = getPipelineState(db, scrape.id);
        if (pipeline?.critique?.passed) stats.critiquePassed++;
        else stats.critiqueScoreRejected++;
      },
    });

    const needsEnrichment = getScrapesForStep(db, "critiqued", 48);
    logger.info({ count: needsEnrichment.length }, "Step 5: Enriching passed candidates");

    await runPipelineStep({
      db, scrapes: needsEnrichment, step: "enrich", signal, stepLabel: "enrich",
      chainId: pipelineChainId, promptHash: manifestHash, scheduledRunId: jobRunId,
      exec: scrape => stepEnrich(db, scrape, sharedContext),
      countFailed: countFailedStep,
      onOk: () => { stats.enriched++; },
    });

    const needsSaving = getScrapesForStep(db, "enriched", 48);
    logger.info({ count: needsSaving.length }, "Step 6: Saving enriched ideas");

    for (const scrape of needsSaving) {
      if (signal?.aborted) break;
      try {
        const result = stepSave(db, scrape);
        if (result.ok) {
          saveResults.push(result.result);
          if (result.result.action === "created") stats.saved++;
          else if (result.result.action === "enhanced") stats.enhanced++;
          else stats.skipped++;
        } else {
          countFailedStep(result.kind);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ scrapeId: scrape.id, step: "save", error: msg }, "Scrape failed, continuing");
        stats.failed++;
      }
    }

    if (jobRunId) {
      storeJobArtifact(db, jobRunId, "idea-synthesizer", "pipeline-stats", "json",
        JSON.stringify(stats), stats);
      if (saveResults.length > 0) {
        storeJobArtifact(db, jobRunId, "idea-synthesizer", "save-results", "json",
          JSON.stringify(saveResults.map(r => ({ id: r.ideaId, action: r.action }))),
          { created: stats.saved, enhanced: stats.enhanced, skipped: stats.skipped });
      }
    }

    const parts: string[] = [];
    parts.push(`Pipeline v3: ${unprocessed.length} scrapes`);
    parts.push(`${stats.scored} scored`);
    if (stats.clustersFormed > 0) parts.push(`${stats.clustersFormed} clusters`);
    if (stats.nearDuplicatesSkipped > 0) parts.push(`${stats.nearDuplicatesSkipped} near-dups skipped`);
    if (stats.synthesized > 0) parts.push(`${stats.synthesized} synthesized`);
    if (stats.critiquePassed > 0) parts.push(`${stats.critiquePassed} critique-passed`);
    if (stats.critiqueScoreRejected > 0) parts.push(`${stats.critiqueScoreRejected} critique-rejected`);
    if (stats.enriched > 0) parts.push(`${stats.enriched} enriched`);
    if (stats.saved > 0) parts.push(`${stats.saved} new ideas`);
    if (stats.enhanced > 0) parts.push(`${stats.enhanced} enhanced`);
    if (stats.exhausted > 0) parts.push(`${stats.exhausted} exhausted`);
    if (stats.failed > 0) parts.push(`${stats.failed} step failures`);

    const output = `Synthesizer: ${parts.join(", ")}`;
    logger.info({ stats }, "Idea synthesis pipeline v3 complete");

    const terminalized = stats.saved + stats.enhanced + stats.skipped + stats.nearDuplicatesSkipped + stats.critiqueScoreRejected + stats.exhausted;
    const actionableLoaded = unprocessed.length;
    const actionableFailed = (["pending", "scored", "clustered", "extracted", "critiqued", "enriched"] as const)
      .reduce((sum, step) => sum + getScrapesForStep(db, step, 48).length, 0);

    try {
      const version = registerVersion(db, "idea-synthesizer", getPromptManifest(), getSourceHash(), "migration");
      const runId = jobRunId ? String(jobRunId) : pipelineChainId;

      const totalCritiqued = stats.critiquePassed + stats.critiqueScoreRejected;
      if (totalCritiqued > 0) {
        writeEvalScore(db, {
          runId, jobId: "idea-synthesizer", harnessVersionId: version.id,
          scoreName: "critique_pass_rate",
          scoreValue: stats.critiquePassed / totalCritiqued,
          scoreComponents: { passed: stats.critiquePassed, rejected: stats.critiqueScoreRejected },
        });
      }

      if (unprocessed.length > 0) {
        writeEvalScore(db, {
          runId, jobId: "idea-synthesizer", harnessVersionId: version.id,
          scoreName: "packet_yield",
          scoreValue: stats.saved + stats.enhanced,
          scoreComponents: { saved: stats.saved, enhanced: stats.enhanced, input: unprocessed.length },
        });
      }

      if (unprocessed.length > 0) {
        writeEvalScore(db, {
          runId, jobId: "idea-synthesizer", harnessVersionId: version.id,
          scoreName: "pipeline_throughput",
          scoreValue: terminalized / unprocessed.length,
          scoreComponents: stats,
        });
      }
    } catch (err) {
      logger.warn({ error: err }, "Failed to write harness scores (non-fatal)");
    }

    const success = terminalized > 0 || (actionableLoaded > 0 && actionableFailed === 0);
    return { success, output, error: success ? undefined : "All pipeline steps failed" };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Idea synthesizer pipeline v3 failed");
    return { success: false, output: "", error: msg };
  }
}
