/**
 * YouTube Video Summarizer — Pipeline v2
 *
 * Two-pass adaptive analysis:
 *   Pass 1 (Flash)   — classify video, infer intent, plan context retrieval
 *   Pass 2 (3.1 Pro) — deep adaptive analysis, only expands relevant categories
 *
 * Concurrency: Flash classification semaphore (max 4), Pro analysis semaphore (max 2).
 */

import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { executeGeminiCLIDirect, GEMINI_CLI_FLASH_MODEL } from "../executors/gemini-cli.js";
import { executeClaudeCommand } from "../executors/claude.js";
import { extractTranscript, buildTranscriptSampleForPass1, buildTranscriptForPass2, getLocalTranscriptPath } from "./transcript.js";
import { logger } from "../utils/logger.js";
import { buildCondensedContext } from "../scheduler/shared-context.js";
import { createIdea, findByCanonicalUrl, searchIdeas } from "../ideas/dao.js";
import type { ParsedIdea } from "../ideas/parser.js";
import { randomUUID } from "crypto";
import type { YouTubeSummaryMetadata } from "../overnight/types.js";
// @ts-ignore TS6133 — Database is used as a type throughout this file
// @ts-ignore
import type Database from "better-sqlite3";
import { PATHS } from "../config/paths.js";

const SUMMARIES_DIR = `${PATHS.homerData}/youtube-summaries`;
const ARCHITECTURE_PATH = PATHS.architectureMd;

// ============================================
// CONCURRENCY CONTROL
// ============================================

class Semaphore {
  private queue: (() => void)[] = [];
  private running = 0;

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      this.running++;
      next();
    }
  }
}

/** Backward-compat export — callers that acquire before calling summarizeYouTubeVideo */
export const geminiSemaphore = new Semaphore(4);

/** Separate semaphore for the expensive Pro analysis pass */
const proSemaphore = new Semaphore(2);

// ============================================
// TYPES
// ============================================

/** 8 analysis categories used in Pass 1 weights and Pass 2 expansion */
export const ANALYSIS_CATEGORIES = [
  "AI Trends & Agent Strategy",
  "Technical Deep-Dive / Homer Application",
  "Automation & Productivity",
  "Trading / Finance",
  "Content Creation & Thought Leadership",
  "Life Strategy / Mental Models",
  "General Knowledge / Curiosity",
  "Career / Job Strategy",
] as const;

export type AnalysisCategory = typeof ANALYSIS_CATEGORIES[number];

export interface Pass1Result {
  videoCategory: AnalysisCategory;
  intentInference: string;
  categoryWeights: Record<string, number>;  // category name → 0.0–1.0
  relevancePreScore: number;                 // 0–10
  analysisPlan: {
    focusCategories: string[];
    transcriptStrategy: "full" | "chunked" | "sampled";
    contextHints: {
      shouldCheckHomerArchitecture: boolean;
      shouldCheckJobActivity: boolean;
      shouldCheckRecentIdeas: boolean;
      shouldCheckRecentSessions: boolean;
      keywords: string[];
    };
  };
}

export interface IdeaCandidate {
  title: string;
  summary: string;
  firstStep: string;
  evidence: string;
  novelty: number;       // 0.0–1.0
  actionability: number; // 0.0–1.0
  fit: number;           // 0.0–1.0
  shouldCreateIdea: boolean;
  categoryTags: string[];
  projectTags: string[];
}

export interface Pass2Result {
  videoTitle: string;
  channelName: string;
  intentHypothesis: string;
  overallRelevance: number;  // 0–10
  overallRelevanceReason: string;
  analysisByCategory: Array<{
    category: string;
    weight: number;
    analysis: string;
    actionItems: string[];
  }>;
  actions: string[];
  ideaCandidates: IdeaCandidate[];
  scores: {
    depth: number;
    novelty: number;
    actionability: number;
  };
  degraded?: boolean;  // true if fell back from Pro to Flash
}

// ============================================
// SUMMARY FILE I/O
// ============================================

export function ensureSummariesDir(): void {
  if (!existsSync(SUMMARIES_DIR)) {
    mkdirSync(SUMMARIES_DIR, { recursive: true });
  }
}

export function summaryFileExists(videoId: string): string | null {
  if (!existsSync(SUMMARIES_DIR)) return null;
  const files = readdirSync(SUMMARIES_DIR);
  const match = files.find((f) => f.startsWith(`${videoId}-`));
  return match ? join(SUMMARIES_DIR, match) : null;
}

export function videoExistsInDb(db: Database.Database, videoId: string): boolean {
  try {
    const row = db.prepare("SELECT 1 FROM youtube_videos WHERE video_id = ?").get(videoId);
    return !!row;
  } catch {
    return false;
  }
}

export function summaryExists(videoId: string, db?: Database.Database): boolean {
  if (db && videoExistsInDb(db, videoId)) return true;
  return !!summaryFileExists(videoId);
}

export function markSummaryReviewedV2(videoId: string, db?: Database.Database): void {
  if (db) {
    try {
      db.prepare("UPDATE youtube_videos SET reviewed_at = datetime('now') WHERE video_id = ?").run(videoId);
    } catch (error) {
      logger.warn({ videoId, error }, "Failed to mark video reviewed in DB");
    }
  }
  markSummaryReviewed(videoId);
}

export function getYouTubeVideoFromDb(db: Database.Database, videoId: string): {
  videoId: string;
  url: string;
  title: string;
  channelName: string;
  summary: string;
  relevanceScore: number;
  metadata: string;
  reviewedAt: string | null;
} | null {
  try {
    const row = db.prepare(
      "SELECT video_id, url, title, channel_name, summary, relevance_score, metadata, reviewed_at FROM youtube_videos WHERE video_id = ?"
    ).get(videoId) as {
      video_id: string;
      url: string;
      title: string;
      channel_name: string;
      summary: string;
      relevance_score: number;
      metadata: string;
      reviewed_at: string | null;
    } | undefined;

    if (!row) return null;

    return {
      videoId: row.video_id,
      url: row.url,
      title: row.title,
      channelName: row.channel_name,
      summary: row.summary ?? "",
      relevanceScore: row.relevance_score ?? 0,
      metadata: row.metadata ?? "{}",
      reviewedAt: row.reviewed_at,
    };
  } catch {
    return null;
  }
}

export function markSummaryReviewed(videoId: string): void {
  const filePath = summaryFileExists(videoId);
  if (!filePath) return;
  try {
    let content = readFileSync(filePath, "utf-8");
    content = content.replace("status: pending_review", "status: reviewed");
    writeFileSync(filePath, content, "utf-8");
  } catch (error) {
    logger.warn({ videoId, error }, "Failed to mark summary as reviewed");
  }
}

// ============================================
// PASS 1 — CLASSIFICATION (Flash)
// ============================================

async function classifyVideoPass1(
  transcriptSample: string,
  queueMeta: Pick<YouTubeSummaryMetadata, "queuedAt" | "queueSource" | "queueLocalHour" | "queueLocalDow">,
  condensedCtx: string
): Promise<Pass1Result> {
  const prompt = `You are a video classification agent. Analyze this YouTube video transcript sample and classify it.

## Yanqing's Profile (condensed)
${condensedCtx}

## Queue Context
- Queued at: ${queueMeta.queuedAt ?? "unknown"}
- Source: ${queueMeta.queueSource ?? "unknown"}
- Local hour: ${queueMeta.queueLocalHour ?? "unknown"}
- Day of week: ${queueMeta.queueLocalDow ?? "unknown"} (0=Sun)

## Transcript Sample (~3K chars, head+mid+tail)
${transcriptSample}

## Task
Classify this video and plan the deep analysis. Return JSON:

{
  "videoCategory": "<one of: AI Trends & Agent Strategy | Technical Deep-Dive / Homer Application | Automation & Productivity | Trading / Finance | Content Creation & Thought Leadership | Life Strategy / Mental Models | General Knowledge / Curiosity | Career / Job Strategy>",
  "intentInference": "<1-2 sentences: why did Yanqing queue this? What was he probably hoping to get from it?>",
  "categoryWeights": {
    "AI Trends & Agent Strategy": 0.0,
    "Technical Deep-Dive / Homer Application": 0.0,
    "Automation & Productivity": 0.0,
    "Trading / Finance": 0.0,
    "Content Creation & Thought Leadership": 0.0,
    "Life Strategy / Mental Models": 0.0,
    "General Knowledge / Curiosity": 0.0,
    "Career / Job Strategy": 0.0
  },
  "relevancePreScore": 7,
  "analysisPlan": {
    "focusCategories": ["<top 2-4 category names by weight>"],
    "transcriptStrategy": "full",
    "contextHints": {
      "shouldCheckHomerArchitecture": false,
      "shouldCheckJobActivity": false,
      "shouldCheckRecentIdeas": false,
      "shouldCheckRecentSessions": false,
      "keywords": ["<3-5 keywords for FTS context retrieval>"]
    }
  }
}

Rules:
- categoryWeights must sum to ~1.0
- transcriptStrategy: "full" if <12K chars likely, "chunked" if 12K-50K, "sampled" if >50K
- shouldCheckHomerArchitecture: true if video touches system design / AI agents / coding patterns
- shouldCheckJobActivity: true if career/job-search relevant
- shouldCheckRecentIdeas: true if video connects to existing ideas/projects
- shouldCheckRecentSessions: true if connects to recent work context
- Return ONLY valid JSON, no markdown fences`;

  const result = await executeGeminiCLIDirect(prompt, {
    timeout: 900_000,
  });

  if (result.exitCode !== 0) {
    throw new Error(`Pass 1 classification failed: ${result.output}`);
  }

  try {
    const jsonMatch = result.output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON object found");
    return JSON.parse(jsonMatch[0]) as Pass1Result;
  } catch {
    throw new Error(`Pass 1 JSON parse failed: ${result.output.slice(0, 200)}`);
  }
}

// ============================================
// DYNAMIC CONTEXT ASSEMBLY
// ============================================

async function buildDynamicContextPack(
  pass1: Pass1Result,
  db: Database.Database | undefined
): Promise<string> {
  const sections: string[] = [];

  // Always: condensed profile + recent momentum snapshot
  const condensed = await buildCondensedContext();
  sections.push(`## Profile\n${condensed}`);

  // Always: recent sessions momentum (last 7 days, active)
  if (db) {
    try {
      const recent = db.prepare(`
        SELECT title, summary, started_at
        FROM session_summaries
        WHERE status = 'active'
          AND is_sub_agent = 0
          AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
        ORDER BY started_at DESC
        LIMIT 10
      `).all() as Array<{ title: string; summary: string; started_at: string }>;

      if (recent.length > 0) {
        const lines = recent.map((r) => `- [${r.started_at?.slice(0, 10)}] ${r.title}: ${r.summary?.slice(0, 120)}`);
        sections.push(`## Recent Activity (7 days)\n${lines.join("\n")}`);
      }
    } catch {
      // session_summaries may not exist — non-fatal
    }

    // Active plans
    try {
      const plans = db.prepare(`
        SELECT title, description FROM plans WHERE status = 'active' LIMIT 5
      `).all() as Array<{ title: string; description: string }>;
      if (plans.length > 0) {
        const lines = plans.map((p) => `- ${p.title}: ${p.description?.slice(0, 100)}`);
        sections.push(`## Active Plans\n${lines.join("\n")}`);
      }
    } catch { /* non-fatal */ }
  }

  const hints = pass1.analysisPlan.contextHints;

  // Conditional: Homer architecture
  if (hints.shouldCheckHomerArchitecture && existsSync(ARCHITECTURE_PATH)) {
    try {
      const arch = readFileSync(ARCHITECTURE_PATH, "utf-8");
      sections.push(`## Homer Architecture (excerpts)\n${arch.slice(0, 8000)}`);
    } catch { /* non-fatal */ }
  }

  // Conditional: Job activity
  if (hints.shouldCheckJobActivity && db) {
    try {
      const jobs = db.prepare(`
        SELECT title, company, status, applied_at
        FROM job_postings
        WHERE status IN ('applied', 'approved', 'hold')
        ORDER BY applied_at DESC NULLS LAST
        LIMIT 10
      `).all() as Array<{ title: string; company: string; status: string; applied_at: string }>;
      if (jobs.length > 0) {
        const lines = jobs.map((j) => `- ${j.title} @ ${j.company} [${j.status}]`);
        sections.push(`## Recent Job Activity\n${lines.join("\n")}`);
      }
    } catch { /* non-fatal */ }
  }

  // Conditional: Recent ideas by keywords
  if (hints.shouldCheckRecentIdeas && db && hints.keywords.length > 0) {
    const keyQuery = hints.keywords.slice(0, 3).join(" OR ");
    try {
      const results = searchIdeas(db, keyQuery, 5);
      if (results.length > 0) {
        const lines = results.map((r) => `- [${r.status}] ${r.title}: ${r.content?.slice(0, 100)}`);
        sections.push(`## Related Ideas\n${lines.join("\n")}`);
      }
    } catch { /* non-fatal */ }
  }

  // Conditional: Recent sessions by keywords
  if (hints.shouldCheckRecentSessions && db && hints.keywords.length > 0) {
    const keyQuery = hints.keywords.slice(0, 3)
      .map((k) => k.replace(/[*()":^$]/g, "").trim()).filter(Boolean)
      .join(" OR ");
    try {
      const matches = db.prepare(`
        SELECT ss.title, ss.summary
        FROM session_summaries_fts fts
        JOIN session_summaries ss ON fts.rowid = ss.rowid
        WHERE session_summaries_fts MATCH ?
          AND ss.status = 'active'
        ORDER BY bm25(session_summaries_fts)
        LIMIT 5
      `).all(keyQuery) as Array<{ title: string; summary: string }>;
      if (matches.length > 0) {
        const lines = matches.map((m) => `- ${m.title}: ${m.summary?.slice(0, 120)}`);
        sections.push(`## Related Sessions\n${lines.join("\n")}`);
      }
    } catch { /* non-fatal */ }
  }

  return sections.join("\n\n");
}

// ============================================
// PASS 2 — DEEP ANALYSIS (3.1 Pro)
// ============================================

async function analyzeVideoPass2(
  transcriptMaterial: string,
  pass1: Pass1Result,
  contextPack: string
): Promise<Pass2Result> {
  const focusList = pass1.analysisPlan.focusCategories.join(", ");
  const allWeights = Object.entries(pass1.categoryWeights)
    .sort(([, a], [, b]) => b - a)
    .map(([cat, w]) => `  "${cat}": ${w.toFixed(2)}`)
    .join(",\n");

  const prompt = `You are a personal strategic advisor for Yanqing Jiang. Analyze this YouTube video deeply and adaptively — only expand the categories that are actually relevant based on the Pass 1 classification.

## Pass 1 Classification
- Primary category: ${pass1.videoCategory}
- Intent: ${pass1.intentInference}
- Focus categories: ${focusList}
- Pre-score: ${pass1.relevancePreScore}/10
- Category weights:
${allWeights}

## Yanqing's Context
${contextPack}

## Video Transcript
${transcriptMaterial}

## Task
Analyze this video. Return JSON:

{
  "videoTitle": "<inferred title from transcript>",
  "channelName": "<channel name if discernible>",
  "intentHypothesis": "<refined 1-2 sentence hypothesis about why Yanqing watched this and what value he was seeking>",
  "overallRelevance": 7,
  "overallRelevanceReason": "<one sentence>",
  "analysisByCategory": [
    {
      "category": "<category name>",
      "weight": 0.8,
      "analysis": "<detailed analysis paragraph — only for top 2-4 categories with weight > 0.15>",
      "actionItems": ["<specific action item>"]
    }
  ],
  "actions": ["<3-5 top concrete next steps Yanqing should take, ranked by importance>"],
  "ideaCandidates": [
    {
      "title": "<idea title>",
      "summary": "<2-3 sentences describing the idea>",
      "firstStep": "<concrete first step to act on it>",
      "evidence": "<specific insight from the video that supports this idea>",
      "novelty": 0.7,
      "actionability": 0.8,
      "fit": 0.75,
      "shouldCreateIdea": true,
      "categoryTags": ["ai-agents"],
      "projectTags": ["homer"]
    }
  ],
  "scores": {
    "depth": 7,
    "novelty": 6,
    "actionability": 8
  }
}

Rules:
- analysisByCategory: ONLY include categories with weight > 0.15. Skip low-relevance ones.
- If a category has low weight (< 0.15), do NOT force analysis — omit it entirely.
- ideaCandidates: only include if novelty >= 0.6 AND actionability >= 0.5 AND fit >= 0.5
- Set shouldCreateIdea=true only for ideas that are genuinely novel and immediately actionable
- Return ONLY valid JSON, no markdown fences`;

  // Primary: Sonnet via Claude Code CLI — full context window
  try {
    const sonnetResult = await executeClaudeCommand(prompt, {
      cwd: process.env.HOME ?? process.cwd(),
      model: "sonnet",
      timeout: 180_000,
    });

    if (sonnetResult.exitCode === 0 && sonnetResult.output) {
      const jsonMatch = sonnetResult.output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Pass2Result;
        logger.info({ model: "claude-sonnet-4-6" }, "Pass 2 analysis complete");
        return parsed;
      }
    }
  } catch (err) {
    logger.warn({ error: err }, "Pass 2 Sonnet attempt failed, falling back to Flash");
  }

  // Fallback: Flash via Gemini CLI
  const flashResult = await executeGeminiCLIDirect(prompt, {
    timeout: 120_000,
  });

  if (flashResult.exitCode !== 0) {
    throw new Error(`Pass 2 all models failed. Last error: ${flashResult.output}`);
  }

  const parsed = JSON.parse(flashResult.output) as Pass2Result;
  parsed.degraded = true;
  logger.info({ model: GEMINI_CLI_FLASH_MODEL, degraded: true }, "Pass 2 analysis complete (Flash fallback)");
  return parsed;
}

// ============================================
// RENDER SUMMARY MARKDOWN
// ============================================

function renderSummaryMarkdown(pass2: Pass2Result, pass1: Pass1Result): string {
  const parts: string[] = [];

  parts.push(`## Summary\n**Primary Category:** ${pass1.videoCategory}  \n**Intent:** ${pass2.intentHypothesis}`);

  for (const cat of pass2.analysisByCategory) {
    if (!cat.analysis) continue;
    parts.push(`## ${cat.category} (weight: ${(cat.weight * 100).toFixed(0)}%)\n${cat.analysis}`);
    if (cat.actionItems?.length) {
      parts.push(`**Action items:**\n${cat.actionItems.map((a) => `- ${a}`).join("\n")}`);
    }
  }

  if (pass2.actions?.length) {
    parts.push(`## Key Actions\n${pass2.actions.map((a) => `- ${a}`).join("\n")}`);
  }

  if (pass2.ideaCandidates?.length) {
    const viableIdeas = pass2.ideaCandidates.filter((c) => c.shouldCreateIdea);
    if (viableIdeas.length) {
      const lines = viableIdeas.map(
        (c) => `- **${c.title}** — ${c.summary.slice(0, 120)}`
      );
      parts.push(`## Ideas Generated\n${lines.join("\n")}`);
    }
  }

  parts.push(
    `## Relevance\n**Score:** ${pass2.overallRelevance}/10 — ${pass2.overallRelevanceReason}` +
    (pass2.degraded ? "\n\n_⚠️ Analyzed with degraded model (Flash fallback)_" : "")
  );

  return parts.join("\n\n");
}

// ============================================
// DATABASE UPSERT (v2)
// ============================================

function upsertYouTubeVideo(
  db: Database.Database,
  videoId: string,
  videoUrl: string,
  pass1: Pass1Result,
  pass2: Pass2Result,
  transcriptText: string,
  transcriptMethod: string,
  processingMs: number,
  queuedAt?: string,
  modelPass1?: string,
  modelPass2?: string,
): void {
  try {
    const summary = renderSummaryMarkdown(pass2, pass1);
    const topicsText = [
      pass1.videoCategory,
      ...pass1.analysisPlan.focusCategories,
      ...pass1.analysisPlan.contextHints.keywords,
      ...(pass2.analysisByCategory?.map((c) => c.category) ?? []),
    ].join(" ");

    db.prepare(`
      INSERT INTO youtube_videos (
        video_id, url, title, channel_name, transcript, summary, relevance_score,
        metadata, transcript_method,
        pipeline_version, analysis_status,
        primary_category, primary_topic, intent_primary, intent_confidence,
        pass1_classification, analysis_json, topics_text,
        model_pass1, model_pass2, queued_at, processing_ms
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        title = excluded.title,
        channel_name = excluded.channel_name,
        transcript = excluded.transcript,
        summary = excluded.summary,
        relevance_score = excluded.relevance_score,
        metadata = excluded.metadata,
        transcript_method = excluded.transcript_method,
        pipeline_version = excluded.pipeline_version,
        analysis_status = excluded.analysis_status,
        primary_category = excluded.primary_category,
        primary_topic = excluded.primary_topic,
        intent_primary = excluded.intent_primary,
        intent_confidence = excluded.intent_confidence,
        pass1_classification = excluded.pass1_classification,
        analysis_json = excluded.analysis_json,
        topics_text = excluded.topics_text,
        model_pass1 = excluded.model_pass1,
        model_pass2 = excluded.model_pass2,
        queued_at = excluded.queued_at,
        processing_ms = excluded.processing_ms,
        processed_at = datetime('now')
    `).run(
      videoId,
      videoUrl,
      pass2.videoTitle ?? "",
      pass2.channelName ?? "",
      transcriptText,
      summary,
      pass2.overallRelevance ?? 0,
      JSON.stringify({
        keyTakeaways: pass2.actions,
        actionableSuggestions: pass2.actions,
        ideaCandidates: pass2.ideaCandidates,
        scores: pass2.scores,
      }),
      transcriptMethod,
      "yt_v2",
      "complete",
      pass1.videoCategory ?? null,
      pass1.analysisPlan.focusCategories[0] ?? null,
      pass2.intentHypothesis?.slice(0, 200) ?? null,
      pass1.relevancePreScore / 10,
      JSON.stringify(pass1),
      JSON.stringify(pass2),
      topicsText,
      modelPass1 ?? GEMINI_CLI_FLASH_MODEL,
      modelPass2 ?? "claude-sonnet-4.6",
      queuedAt ?? null,
      processingMs,
    );

    logger.info({ videoId, relevance: pass2.overallRelevance }, "YouTube video v2 upserted to DB");
  } catch (error) {
    logger.warn({ videoId, error }, "Failed to upsert YouTube video to DB (non-fatal)");
  }
}

// ============================================
// IDEA CREATION BRIDGE (Phase 3)
// ============================================

async function maybeCreateIdeasFromVideo(
  db: Database.Database,
  videoId: string,
  videoUrl: string,
  pass1: Pass1Result,
  pass2: Pass2Result,
  summaryFilePath: string,
  transcriptFilePath: string | null
): Promise<string[]> {
  if (pass2.overallRelevance < 6) return [];

  const candidates = (pass2.ideaCandidates ?? []).filter(
    (c) =>
      c.shouldCreateIdea &&
      c.novelty >= 0.65 &&
      c.actionability >= 0.60 &&
      c.fit >= 0.60
  );

  if (candidates.length === 0) return [];

  // Max 1 idea per video on initial creation
  const candidate = candidates[0]!;
  const createdIds: string[] = [];

  // Dedup: check by canonical URL first
  const existing = findByCanonicalUrl(db, videoUrl);
  if (existing) {
    logger.info({ videoId, ideaId: existing.id }, "Video URL already linked to existing idea, skipping creation");
    return [];
  }

  // Dedup: FTS title similarity check
  const similar = searchIdeas(db, candidate.title, 3);
  for (const s of similar) {
    if (s.rank < -1.5) {  // very high similarity score (bm25 is negative)
      logger.info({ videoId, similarIdeaId: s.id, title: s.title }, "Similar idea already exists, skipping creation");
      return [];
    }
  }

  try {
    const tags = [
      "youtube",
      ...candidate.categoryTags,
      ...candidate.projectTags,
    ].filter(Boolean);

    // Build full video summary as context so Talk analysis has rich material.
    // Include exact file paths so Claude Code / agents can navigate directly.
    const fullSummary = renderSummaryMarkdown(pass2, pass1);
    const fileLinks = [
      `- Summary: \`${summaryFilePath}\``,
      transcriptFilePath ? `- Transcript: \`${transcriptFilePath}\`` : null,
      `- DB video_id: \`${videoId}\` in table \`youtube_videos\``,
    ].filter(Boolean).join("\n");
    const videoContext = `## Source Files\n${fileLinks}\n\n## Source Video Analysis\n**Title:** ${pass2.videoTitle ?? "Unknown"}\n**URL:** ${videoUrl}\n**Category:** ${pass1.videoCategory}\n\n${fullSummary}`;

    const idea: ParsedIdea = {
      id: `idea_yt_${randomUUID().slice(0, 8)}`,
      title: candidate.title,
      status: "review",
      source: "youtube-analysis",
      content: `${candidate.summary}\n\n**First step:** ${candidate.firstStep}\n\n**Evidence from video:** ${candidate.evidence}`,
      context: videoContext,
      link: videoUrl,
      tags,
      timestamp: new Date().toISOString(),
    };

    const saved = createIdea(db, idea);
    createdIds.push(saved.id);
    logger.info({ videoId, ideaId: saved.id, title: saved.title }, "Idea created from YouTube video");

    // knowledge_links table removed in migration 070
  } catch (error) {
    logger.warn({ videoId, error }, "Failed to create idea from video (non-fatal)");
  }

  return createdIds;
}

// ============================================
// SUMMARY FILE (MIRROR)
// ============================================

function writeSummaryFile(
  videoId: string,
  videoUrl: string,
  pass1: Pass1Result,
  pass2: Pass2Result
): string {
  ensureSummariesDir();

  const date = new Date().toISOString().split("T")[0];
  const fileName = `${videoId}-${date}.md`;
  const filePath = join(SUMMARIES_DIR, fileName);

  const summaryBody = renderSummaryMarkdown(pass2, pass1);

  const content = `---
videoId: ${videoId}
videoUrl: ${videoUrl}
videoTitle: "${(pass2.videoTitle ?? "Unknown").replace(/"/g, '\\"')}"
channelName: "${(pass2.channelName ?? "Unknown").replace(/"/g, '\\"')}"
processedAt: ${new Date().toISOString()}
pipelineVersion: yt_v2
primaryCategory: "${pass1.videoCategory}"
relevanceScore: ${pass2.overallRelevance}
status: pending_review
---

${summaryBody}
`;

  writeFileSync(filePath, content, "utf-8");
  logger.info({ filePath, videoId, relevance: pass2.overallRelevance }, "YouTube v2 summary file written");
  return filePath;
}

// ============================================
// MEMORY FILE (for FTS5 + embedding indexing)
// ============================================

function writeTranscriptToMemory(
  videoId: string,
  videoUrl: string,
  pass1: Pass1Result,
  pass2: Pass2Result,
  transcriptText: string,
  db?: Database.Database,
): void {
  try {
    const memDir = PATHS.youtubeMemory;
    if (!existsSync(memDir)) {
      mkdirSync(memDir, { recursive: true });
    }

    const filePath = join(memDir, `${videoId}.md`);
    const content = `---
videoId: ${videoId}
videoUrl: ${videoUrl}
title: "${(pass2.videoTitle ?? "Unknown").replace(/"/g, '\\"')}"
channel: "${(pass2.channelName ?? "Unknown").replace(/"/g, '\\"')}"
category: "${pass1.videoCategory}"
relevance: ${pass2.overallRelevance}
processedAt: ${new Date().toISOString()}
---

# ${pass2.videoTitle ?? videoId}

**Channel:** ${pass2.channelName ?? "Unknown"}
**Category:** ${pass1.videoCategory}
**Relevance:** ${pass2.overallRelevance}/10

## Transcript

${transcriptText}
`;

    writeFileSync(filePath, content, "utf-8");
    logger.info({ filePath, videoId }, "YouTube transcript written to memory directory");

    // Mark reindex + embeddings pipelines dirty so the scheduler picks up the new file
    if (db) {
      try {
        db.prepare(`
          INSERT INTO pipeline_dirty (pipeline, is_dirty, last_trigger, marked_at)
          VALUES (?, 1, ?, datetime('now'))
          ON CONFLICT(pipeline) DO UPDATE SET
            is_dirty = 1, last_trigger = excluded.last_trigger, marked_at = excluded.marked_at
        `).run("reindex", "youtube_transcript");
        db.prepare(`
          INSERT INTO pipeline_dirty (pipeline, is_dirty, last_trigger, marked_at)
          VALUES (?, 1, ?, datetime('now'))
          ON CONFLICT(pipeline) DO UPDATE SET
            is_dirty = 1, last_trigger = excluded.last_trigger, marked_at = excluded.marked_at
        `).run("embeddings", "youtube_transcript");
      } catch { /* pipeline_dirty table may not exist — non-fatal */ }
    }
  } catch (error) {
    logger.warn({ videoId, error }, "Failed to write YouTube transcript to memory (non-fatal)");
  }
}

// ============================================
// BACKFILL: Write memory files for existing youtube_videos rows
// ============================================

/**
 * Backfill ~/memory/youtube/ for all youtube_videos rows that don't yet have a memory file.
 * Call once after deploying this refactor to catch existing corpus.
 */
export function backfillYouTubeMemoryFiles(db: Database.Database): { written: number; skipped: number } {
  const stats = { written: 0, skipped: 0 };
  const memDir = PATHS.youtubeMemory;
  if (!existsSync(memDir)) {
    mkdirSync(memDir, { recursive: true });
  }

  const rows = db.prepare(`
    SELECT video_id, url, title, channel_name, transcript, pass1_classification, analysis_json, relevance_score
    FROM youtube_videos
    WHERE transcript IS NOT NULL AND length(transcript) > 50
  `).all() as Array<{
    video_id: string; url: string; title: string; channel_name: string;
    transcript: string; pass1_classification: string; analysis_json: string; relevance_score: number;
  }>;

  for (const row of rows) {
    const filePath = join(memDir, `${row.video_id}.md`);
    if (existsSync(filePath)) {
      stats.skipped++;
      continue;
    }

    let category = "Unknown";
    try {
      const p1 = JSON.parse(row.pass1_classification ?? "{}");
      category = p1.videoCategory ?? "Unknown";
    } catch { /* ignore */ }

    const content = `---
videoId: ${row.video_id}
videoUrl: ${row.url}
title: "${(row.title ?? "Unknown").replace(/"/g, '\\"')}"
channel: "${(row.channel_name ?? "Unknown").replace(/"/g, '\\"')}"
category: "${category}"
relevance: ${row.relevance_score ?? 0}
processedAt: ${new Date().toISOString()}
backfilled: true
---

# ${row.title ?? row.video_id}

**Channel:** ${row.channel_name ?? "Unknown"}
**Category:** ${category}
**Relevance:** ${row.relevance_score ?? 0}/10

## Transcript

${row.transcript}
`;

    try {
      writeFileSync(filePath, content, "utf-8");
      stats.written++;
    } catch {
      logger.warn({ videoId: row.video_id }, "Failed to backfill YouTube memory file");
    }
  }

  if (stats.written > 0) {
    // Mark pipelines dirty for indexing
    try {
      db.prepare(`
        INSERT INTO pipeline_dirty (pipeline, is_dirty, last_trigger, marked_at)
        VALUES (?, 1, ?, datetime('now'))
        ON CONFLICT(pipeline) DO UPDATE SET
          is_dirty = 1, last_trigger = excluded.last_trigger, marked_at = excluded.marked_at
      `).run("reindex", "youtube_backfill");
      db.prepare(`
        INSERT INTO pipeline_dirty (pipeline, is_dirty, last_trigger, marked_at)
        VALUES (?, 1, ?, datetime('now'))
        ON CONFLICT(pipeline) DO UPDATE SET
          is_dirty = 1, last_trigger = excluded.last_trigger, marked_at = excluded.marked_at
      `).run("embeddings", "youtube_backfill");
    } catch { /* non-fatal */ }
  }

  logger.info(stats, "YouTube memory backfill complete");
  return stats;
}

// ============================================
// MAIN SUMMARIZE FUNCTION
// ============================================

export interface SummarizeResult {
  success: boolean;
  summaryPath?: string;
  parsed?: Record<string, unknown>;
  error?: string;
  pass1?: Pass1Result;
  pass2?: Pass2Result;
  createdIdeaIds?: string[];
}

/**
 * Full two-pass pipeline for a single video:
 *   1. Extract transcript
 *   2. Pass 1: Flash classification
 *   3. Build dynamic context pack
 *   4. Pass 2: 3.1 Pro deep analysis
 *   5. Upsert to DB + write file
 *   6. Maybe create idea entries
 *
 * Caller is responsible for outer semaphore (geminiSemaphore) if needed.
 */
export async function summarizeYouTubeVideo(
  metadata: YouTubeSummaryMetadata,
  db?: Database.Database,
): Promise<SummarizeResult> {
  const { videoId, videoUrl } = metadata;
  const startTime = Date.now();

  // Check if already summarized (DB first, then file)
  if (db && videoExistsInDb(db, videoId)) {
    logger.info({ videoId }, "Video already in DB, skipping");
    return { success: true, summaryPath: summaryFileExists(videoId) ?? undefined };
  }
  const existing = summaryFileExists(videoId);
  if (existing) {
    logger.info({ videoId, path: existing }, "Video already summarized, skipping");
    return { success: true, summaryPath: existing };
  }

  // Step 1: Extract transcript
  logger.info({ videoId }, "Extracting transcript");
  const transcript = await extractTranscript(videoId);
  const transcriptText = transcript?.text ?? "No transcript available.";
  const transcriptMethod = transcript?.method ?? "none";

  try {
    // Step 2: Pass 1 — Flash classification
    logger.info({ videoId }, "Pass 1: classifying with Flash");
    const transcriptSample = buildTranscriptSampleForPass1(transcriptText);
    const condensedCtx = await buildCondensedContext();

    let pass1: Pass1Result;
    await geminiSemaphore.acquire();
    try {
      pass1 = await classifyVideoPass1(
        transcriptSample,
        {
          queuedAt: metadata.queuedAt,
          queueSource: metadata.queueSource,
          queueLocalHour: metadata.queueLocalHour,
          queueLocalDow: metadata.queueLocalDow,
        },
        condensedCtx
      );
    } finally {
      geminiSemaphore.release();
    }

    logger.info({ videoId, category: pass1.videoCategory, preScore: pass1.relevancePreScore }, "Pass 1 complete");

    // Step 3: Build dynamic context
    const contextPack = await buildDynamicContextPack(pass1, db);

    // Step 4: Pass 2 — 3.1 Pro deep analysis
    logger.info({ videoId, strategy: pass1.analysisPlan.transcriptStrategy }, "Pass 2: deep analysis with 3.1 Pro");
    const transcriptMaterial = buildTranscriptForPass2(transcriptText, pass1.analysisPlan.transcriptStrategy);

    let pass2: Pass2Result;
    await proSemaphore.acquire();
    try {
      pass2 = await analyzeVideoPass2(transcriptMaterial, pass1, contextPack);
    } finally {
      proSemaphore.release();
    }

    logger.info({ videoId, relevance: pass2.overallRelevance, degraded: pass2.degraded }, "Pass 2 complete");

    // Update metadata with enriched fields
    metadata.videoTitle = pass2.videoTitle ?? metadata.videoTitle ?? "";
    metadata.channelName = pass2.channelName ?? metadata.channelName ?? "";
    metadata.relevanceScore = pass2.overallRelevance;
    metadata.primaryCategory = pass1.videoCategory;
    metadata.intentPrimary = pass2.intentHypothesis?.slice(0, 200);
    metadata.pass1Classification = pass1 as unknown as Record<string, unknown>;
    metadata.transcript = transcriptText.slice(0, 1000);
    metadata.transcriptMethod = transcriptMethod as YouTubeSummaryMetadata["transcriptMethod"];

    const processingMs = Date.now() - startTime;

    // Step 5: Upsert to DB
    if (db) {
      upsertYouTubeVideo(
        db, videoId, videoUrl,
        pass1, pass2,
        transcriptText, transcriptMethod,
        processingMs,
        metadata.queuedAt,
        GEMINI_CLI_FLASH_MODEL,
        pass2.degraded ? GEMINI_CLI_FLASH_MODEL : "claude-sonnet-4.6",
      );
    }

    // Write summary file mirror
    const summaryPath = writeSummaryFile(videoId, videoUrl, pass1, pass2);

    // Write transcript to memory directory for indexing (FTS5 + embeddings)
    writeTranscriptToMemory(videoId, videoUrl, pass1, pass2, transcriptText, db);

    // Resolve transcript file path (written by extractTranscript → saveTranscriptLocally)
    const transcriptPath = getLocalTranscriptPath(videoId);

    // Step 6: Maybe create ideas (gated)
    let createdIdeaIds: string[] = [];
    if (db) {
      createdIdeaIds = await maybeCreateIdeasFromVideo(db, videoId, videoUrl, pass1, pass2, summaryPath, transcriptPath);
    }

    return {
      success: true,
      summaryPath,
      parsed: { ...pass2 } as unknown as Record<string, unknown>,
      pass1,
      pass2,
      createdIdeaIds,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ videoId, error: msg }, "YouTube summarization v2 failed");
    return { success: false, error: msg };
  }
}
