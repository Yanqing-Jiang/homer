/**
 * YouTube Video Summarizer
 *
 * Uses Gemini Flash with full personal memory context to generate
 * deeply personalized video analysis. Includes concurrency control
 * via semaphore (max 3 parallel Gemini processes).
 */

import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { executeGeminiWithFallback } from "../executors/opencode-cli.js";
import { extractTranscript } from "./transcript.js";
import { logger } from "../utils/logger.js";
import type { YouTubeSummaryMetadata } from "../overnight/types.js";

const MEMORY_PATH = process.env.MEMORY_PATH ?? "/Users/yj/memory";
const SUMMARIES_DIR = `${process.env.HOME}/homer/data/youtube-summaries`;
const MAX_TRANSCRIPT_CHARS = 20000;

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

export const geminiSemaphore = new Semaphore(3);

// ============================================
// MEMORY CONTEXT
// ============================================

function loadMemoryContext(): string {
  const files = ["me.md", "work.md", "life.md", "preferences.md"];
  const sections: string[] = [];

  for (const file of files) {
    const path = join(MEMORY_PATH, file);
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        sections.push(`=== ${file.toUpperCase()} ===\n${content}`);
      } catch {
        logger.debug({ file }, "Failed to read memory file");
      }
    }
  }

  return sections.join("\n\n");
}

const HOMER_ARCHITECTURE_PATH = "/Users/yj/homer/architecture.md";

function loadHomerArchitecture(): string {
  try {
    if (existsSync(HOMER_ARCHITECTURE_PATH)) {
      return readFileSync(HOMER_ARCHITECTURE_PATH, "utf-8");
    }
  } catch {
    logger.debug("Failed to read Homer architecture file");
  }
  return "";
}

// ============================================
// GEMINI PROMPT
// ============================================

function buildSummaryPrompt(memoryContext: string, homerArchitecture: string, transcript: string, transcriptMethod: string): string {
  const archSection = homerArchitecture
    ? `\n=== HOMER ARCHITECTURE (detailed internals — use this for Tier 3) ===\n${homerArchitecture.slice(0, 30000)}\n=== END HOMER ARCHITECTURE ===\n`
    : "";

  return `You are a personal strategic advisor for Yanqing Jiang. You have deep knowledge
of his career, goals, projects, and life context (provided below). Your job is
NOT just to summarize this YouTube video — it's to extract maximum actionable
value for Yanqing specifically.

=== YANQING'S FULL CONTEXT ===
${memoryContext}
=== END CONTEXT ===
${archSection}
=== VIDEO TRANSCRIPT (extracted via: ${transcriptMethod}) ===
${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}
=== END TRANSCRIPT ===

Analyze this video across 4 tiers and respond with JSON:

{
  "videoTitle": "...",
  "channelName": "...",

  "summary": "2-3 paragraph summary of the video's main arguments and insights. Include the core thesis and supporting points.",
  "keyTakeaways": ["3-5 specific takeaways"],

  "projectConnections": "TIER 2 — Which of Yanqing's active projects can directly benefit? Consider: Homer OS (daemon, scheduler, executors, memory system), MAHORAGA trading system (regime filter, leveraged ETFs), hr-breaker (resume optimization), job hunt automation, Analytics Copilot (Chat-to-SQL on Databricks). Be SPECIFIC about HOW to apply the video's ideas.",

  "homerImprovements": "TIER 3 — You have Homer's FULL architecture above (scheduler swarm pattern, memory consolidation pipeline, session harvester, MCP tools, executor routing, overnight jobs, idea pipeline, job hunt system, scraping infrastructure). Based on this video, propose SPECIFIC architectural improvements or new features. Reference actual file paths, modules, and patterns from the architecture docs. Examples: 'Add X pattern to model-swarm.ts fan-out logic', 'The session-harvester could use Y technique for better summarization', 'Apply Z to the idea dedup pipeline in ideas-explore.ts'.",

  "careerRelevance": "TIER 4 — How does this help Yanqing's career and life? Consider: B3/Director promo path at P&G, $250-350K job hunt positioning, AI/analytics thought leadership, LinkedIn/Medium content strategy, relationship with JT and org dynamics, Army-to-tech narrative, side income goals. What deeper meanings or strategic lessons apply?",

  "actionableSuggestions": [
    "Concrete action items Yanqing should take based on this video",
    "E.g. 'Apply X technique to your Analytics Copilot pitch to JT'",
    "E.g. 'Add this trading pattern to MAHORAGA's regime filter'",
    "E.g. 'Write a LinkedIn post about Y — aligns with your thought leadership'"
  ],

  "relevanceScore": 7,
  "relevanceReason": "One sentence on why this score"
}

IMPORTANT:
- Be SPECIFIC. Reference actual project names, people (JT, Ravi, Alfredo), and goals.
- Generic advice like "this could help your career" is useless. Connect dots.
- For Homer improvements (Tier 3), reference actual modules and file paths from the architecture context.
- If the video has LOW relevance, say so honestly (score 1-3) with a brief note.
- If the video is highly relevant, go deep on connections across all 4 tiers.
- Return ONLY valid JSON, no markdown fences or extra text.`;
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

function writeSummaryFile(
  videoId: string,
  videoUrl: string,
  parsed: Record<string, unknown>
): string {
  ensureSummariesDir();

  const date = new Date().toISOString().split("T")[0];
  const fileName = `${videoId}-${date}.md`;
  const filePath = join(SUMMARIES_DIR, fileName);

  const videoTitle = String(parsed.videoTitle ?? "Unknown");
  const channelName = String(parsed.channelName ?? "Unknown");
  const relevanceScore = Number(parsed.relevanceScore ?? 0);
  const summary = String(parsed.summary ?? "");
  const keyTakeaways = Array.isArray(parsed.keyTakeaways)
    ? parsed.keyTakeaways.map((t: unknown) => `- ${String(t)}`).join("\n")
    : "";
  const careerRelevance = String(parsed.careerRelevance ?? "");
  const projectConnections = String(parsed.projectConnections ?? "");
  const actionableSuggestions = Array.isArray(parsed.actionableSuggestions)
    ? parsed.actionableSuggestions.map((s: unknown) => `- ${String(s)}`).join("\n")
    : "";
  const homerImprovements = String(parsed.homerImprovements ?? "");
  const relevanceReason = String(parsed.relevanceReason ?? "");

  const content = `---
videoId: ${videoId}
videoUrl: ${videoUrl}
videoTitle: "${videoTitle.replace(/"/g, '\\"')}"
channelName: "${channelName.replace(/"/g, '\\"')}"
processedAt: ${new Date().toISOString()}
relevanceScore: ${relevanceScore}
status: pending_review
---

## Summary
${summary}

## Key Takeaways
${keyTakeaways}

## Project Connections
${projectConnections}

## Homer Improvements
${homerImprovements}

## Career & Life Relevance
${careerRelevance}

## Actionable Suggestions
${actionableSuggestions}

## Relevance
**Score:** ${relevanceScore}/10 — ${relevanceReason}
`;

  writeFileSync(filePath, content, "utf-8");
  logger.info({ filePath, videoId, relevanceScore }, "YouTube summary file written");
  return filePath;
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
// MAIN SUMMARIZE FUNCTION
// ============================================

export interface SummarizeResult {
  success: boolean;
  summaryPath?: string;
  parsed?: Record<string, unknown>;
  error?: string;
}

/**
 * Full pipeline for a single video: extract transcript → Gemini summarize → write file.
 * Caller is responsible for semaphore acquire/release.
 */
export async function summarizeYouTubeVideo(
  metadata: YouTubeSummaryMetadata
): Promise<SummarizeResult> {
  const { videoId, videoUrl } = metadata;

  // Check if already summarized
  const existing = summaryFileExists(videoId);
  if (existing) {
    logger.info({ videoId, path: existing }, "Video already summarized, skipping");
    return { success: true, summaryPath: existing };
  }

  // Extract transcript
  logger.info({ videoId }, "Extracting transcript");
  const transcript = await extractTranscript(videoId);

  const transcriptText = transcript?.text ?? "No transcript available.";
  const transcriptMethod = transcript?.method ?? "none";

  // Load memory context + Homer architecture
  const memoryContext = loadMemoryContext();
  const homerArchitecture = loadHomerArchitecture();

  // Build prompt
  const prompt = buildSummaryPrompt(memoryContext, homerArchitecture, transcriptText, transcriptMethod);

  // Call Gemini
  try {
    const hardTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Gemini hard timeout after 90s")), 90000)
    );

    const geminiCall = executeGeminiWithFallback(prompt, "", {
      model: "gemini-3-flash-preview",
      sandbox: true,
      timeout: 60000,
    });

    const result = await Promise.race([geminiCall, hardTimeout]);

    if (result.exitCode !== 0) {
      return { success: false, error: `Gemini exited with code ${result.exitCode}` };
    }

    // Parse JSON from output
    const jsonMatch = result.output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, error: "No JSON found in Gemini output" };
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    // Update metadata
    metadata.transcript = transcriptText.slice(0, 1000); // store preview only
    metadata.transcriptMethod = transcriptMethod;
    metadata.videoTitle = String(parsed.videoTitle ?? metadata.videoTitle ?? "");
    metadata.channelName = String(parsed.channelName ?? metadata.channelName ?? "");
    metadata.relevanceScore = Number(parsed.relevanceScore ?? 0);

    // Write summary file
    const summaryPath = writeSummaryFile(videoId, videoUrl, parsed);

    return { success: true, summaryPath, parsed };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ videoId, error: msg }, "YouTube summarization failed");
    return { success: false, error: msg };
  }
}
