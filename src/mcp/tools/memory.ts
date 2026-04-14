/**
 * Memory tools: search, hybrid_search, generate_embeddings, promote, suggest, read, reindex, context, candidates, replace, remove
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { PATHS } from "../../config/paths.js";
import { logger } from "../../utils/logger.js";
import * as ideaDao from "../../ideas/dao.js";
import { loadPlansFromDir } from "../../plans/parser.js";
import { getTopPreferences } from "../../preferences/engine.js";
import type { ToolResult, ToolDeps, ToolDefinition } from "./types.js";

const MEMORY_BASE = PATHS.memory;

export const definitions: ToolDefinition[] = [
  {
    name: "memory_search",
    description: "Unified recall across ~/memory/*.md chunks AND operational stores (session summaries, threads, failure takeovers, scrapes, ideas, YouTube, transcripts). Hybrid (vector + BM25) on memory chunks when embeddings exist; BM25 per operational table, fused into one ranked list.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (supports OR, phrase matching)" },
        context: { type: "string", enum: ["work", "general"], description: "Filter by context (optional)" },
        limit: { type: "number", description: "Max results to return (default: 10)" },
        include_archived: { type: "boolean", description: "Include archived sessions in search results (default: false). Archived results rank lower." },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_hybrid_search",
    description: "Semantic + keyword hybrid search across memory. Uses Gemini embeddings for meaning-based matches combined with FTS5 keyword matching via RRF fusion. Better for conceptual queries.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (natural language works best)" },
        context: { type: "string", enum: ["work", "general"], description: "Filter by context (optional)" },
        limit: { type: "number", description: "Max results to return (default: 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_generate_embeddings",
    description: "Generate embeddings for all indexed chunks. Run after memory_reindex to enable hybrid search.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "memory_promote",
    description: "Promote a fact to a permanent memory file. Use for lasting information.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Content to add" },
        file: { type: "string", enum: ["me", "work", "preferences", "tools"], description: "Target file to append to" },
        section: { type: "string", description: "Optional section header to add under" },
      },
      required: ["content", "file"],
    },
  },
  {
    name: "memory_read",
    description: "Read a memory file or today's daily log. Use source='archive' to read the full raw daily log from SQLite (before it was stripped to summary-only).",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", enum: ["me", "work", "preferences", "tools", "daily"], description: "File to read (daily = today's log)" },
        date: { type: "string", description: "For daily: specific date YYYY-MM-DD (default: today)" },
        source: { type: "string", enum: ["file", "archive"], description: "For daily: 'file' reads .md (default), 'archive' reads full raw content from SQLite" },
      },
      required: ["file"],
    },
  },
  {
    name: "memory_reindex",
    description: "Refresh the curated memory corpus in memory_fts: core files (me/work/preferences/tools), recent daily logs (7-day hot window — older purged), meetings, skills, and transcripts. Does NOT touch trigger-maintained FTS tables (session_summaries_fts, thread_messages_fts, ideas_fts, etc.).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "memory_context",
    description: "Returns recent session context, active plans, pending decisions, and project momentum for session warmup. No LLM call, pure SQL + file reads, fast.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Number of days to look back (default: 7)" },
      },
    },
  },
  {
    name: "memory_candidates",
    description: "Returns pending memory promotion candidates awaiting human review. Use in morning brief to show 'Memory Moments'.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max candidates to return (default: 5)" },
        status: { type: "string", enum: ["candidate", "approved", "rejected", "expired"], description: "Filter by status (default: candidate)" },
      },
    },
  },
  {
    name: "memory_replace",
    description: "Replace specific content in a memory file by substring match. Routes through claims pipeline for human review. Use when a fact is outdated or needs correction.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", enum: ["me", "work", "preferences", "tools"], description: "Target memory file" },
        old_text: { type: "string", description: "Exact text to find (substring match)" },
        new_text: { type: "string", description: "Replacement text" },
        reason: { type: "string", description: "Why this replacement is needed" },
      },
      required: ["file", "old_text", "new_text"],
    },
  },
  {
    name: "memory_remove",
    description: "Remove specific content from a memory file by substring match. Routes through claims pipeline for human review. Use when a fact is no longer relevant.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", enum: ["me", "work", "preferences", "tools"], description: "Target memory file" },
        text: { type: "string", description: "Exact text to remove (substring match)" },
        reason: { type: "string", description: "Why this content should be removed" },
      },
      required: ["file", "text"],
    },
  },
  {
    name: "memory_suggest",
    description: "Suggest a fact for permanent memory, queued for human review via Telegram. Use instead of memory_promote when the fact should be reviewed before persisting. Good for preserving valuable synthesis from conversations.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The fact or synthesis to remember" },
        file: { type: "string", enum: ["me", "work", "preferences", "tools"], description: "Target memory file" },
        section: { type: "string", description: "Optional section header" },
        claim_type: { type: "string", enum: ["fact", "decision", "preference", "question", "lesson"], description: "Type of claim (default: fact)" },
        confidence: { type: "number", description: "0.0-1.0 confidence (default: 0.7)" },
        session_id: { type: "string", description: "Optional source session ID for attribution" },
      },
      required: ["content", "file"],
    },
  },
  {
    name: "memory_debug",
    description: "Diagnostic view of the memory pipeline for one session: which claims the extractor produced, what confidence each got, where each was routed (auto-approve / HITL / rejected / stale), and whether they landed in a memory file. Read-only. Use when memory feels off and you want to see why something was or wasn't remembered. Dropped-as-noise claims (confidence < 0.20) are not stored and so cannot be shown.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Specific session_summaries.id to inspect. If omitted, returns the most recent processed session." },
        last_n: { type: "number", description: "When session_id is omitted, inspect the N most recent processed sessions (default: 1, max: 5)." },
      },
    },
  },
];

export async function handle(
  name: string,
  args: Record<string, unknown>,
  deps: ToolDeps
): Promise<ToolResult | null> {
  switch (name) {
    case "memory_search": {
      const { query, context, limit, include_archived } = args as {
        query: string;
        context?: "work" | "general";
        limit?: number;
        include_archived?: boolean;
      };
      const maxResults = limit || 10;

      const hasEmbeddings = deps.indexer.getEmbeddingStats().totalEmbeddings > 0;
      const memoryResults = hasEmbeddings
        ? await deps.indexer.hybridSearch(query, maxResults, context)
        : deps.indexer.search(query, maxResults, context);

      let sessionResults: Array<{ id: string; title: string; summary: string; project: string; agent: string; started_at: string; rank: number }> = [];
      let takeoverResults: Array<{ id: number; job_id: string; diagnosis: string; fix_description: string | null; decision: string; retry_success: number | null; created_at: string; rank: number }> = [];
      let threadResults: Array<{ id: string; thread_id: string; role: string; created_at: string; content: string; rank: number }> = [];
      let scrapeResults: Array<{ id: string; source: string; title: string; url: string | null; scraped_at: string; rank: number }> = [];
      let ideaResults: Array<{ id: string; title: string; status: string; source: string; link: string | null; created_at: string; content: string; rank: number }> = [];
      let youtubeResults: Array<{ video_id: string; title: string; channel_name: string; relevance_score: number; processed_at: string; content: string; rank: number }> = [];
      let transcriptResults: Array<{ content_hash: string; agent: string; project: string | null; started_at: string | null; content: string; rank: number }> = [];
      try {
        const sm = deps.getSharedStateManager();
        // Escape FTS5 query: preserve quoted phrases, implicit AND for terms
        const escapedTerms = (() => {
          const tokens: string[] = [];
          const phraseRegex = /"([^"]+)"/g;
          let lastIdx = 0;
          let m: RegExpExecArray | null;
          while ((m = phraseRegex.exec(query)) !== null) {
            const before = query.slice(lastIdx, m.index);
            for (const t of before.split(/\s+/).filter(Boolean)) {
              const c = t.replace(/[*()\^$]/g, "");
              if (c) tokens.push(c);
            }
            const phrase = (m[1] ?? "").replace(/[*()\^$]/g, "");
            if (phrase.trim()) tokens.push(`"${phrase}"`);
            lastIdx = m.index + m[0].length;
          }
          const rest = query.slice(lastIdx);
          for (const t of rest.split(/\s+/).filter(Boolean)) {
            const c = t.replace(/[*()\^$":]/g, "");
            if (c) tokens.push(c);
          }
          return tokens.join(" "); // Space = implicit AND in FTS5
        })();

        if (escapedTerms) {
          if (include_archived) {
            sessionResults = sm.getDb().prepare(`
              SELECT s.id, s.title, s.summary, s.project, s.agent, s.started_at,
                     bm25(session_summaries_fts) + CASE WHEN s.status = 'archived' THEN 1000 ELSE 0 END as rank
              FROM session_summaries_fts fts
              JOIN session_summaries s ON fts.rowid = s.rowid
              WHERE session_summaries_fts MATCH ?
              ORDER BY rank
              LIMIT ?
            `).all(escapedTerms, maxResults) as typeof sessionResults;
          } else {
            sessionResults = sm.getDb().prepare(`
              SELECT s.id, s.title, s.summary, s.project, s.agent, s.started_at,
                     bm25(session_summaries_fts) as rank
              FROM session_summaries_fts fts
              JOIN session_summaries s ON fts.rowid = s.rowid
              WHERE session_summaries_fts MATCH ?
                AND s.status = 'active'
              ORDER BY rank
              LIMIT ?
            `).all(escapedTerms, maxResults) as typeof sessionResults;
          }

          try {
            takeoverResults = sm.getDb().prepare(`
              SELECT t.id, t.job_id, t.diagnosis, t.fix_description, t.decision,
                     t.retry_success, t.created_at, bm25(failure_takeover_fts) as rank
              FROM failure_takeover_fts fts
              JOIN failure_takeover_runs t ON fts.rowid = t.rowid
              WHERE failure_takeover_fts MATCH ?
              ORDER BY rank
              LIMIT ?
            `).all(escapedTerms, maxResults) as typeof takeoverResults;
          } catch (err) {
            logger.debug({ error: err }, "Failure takeover FTS search failed (table may not exist)");
          }

          try {
            threadResults = sm.getDb().prepare(`
              SELECT tm.id, tm.thread_id, tm.role, tm.created_at,
                     snippet(thread_messages_fts, 0, '>>>', '<<<', '...', 50) as content,
                     bm25(thread_messages_fts) as rank
              FROM thread_messages_fts fts
              JOIN thread_messages tm ON fts.rowid = tm.rowid
              WHERE thread_messages_fts MATCH ?
              ORDER BY rank
              LIMIT ?
            `).all(escapedTerms, maxResults) as typeof threadResults;
          } catch (err) {
            logger.debug({ error: err }, "Thread messages FTS search failed (table may not exist)");
          }

          try {
            scrapeResults = sm.getDb().prepare(`
              SELECT s.id, s.source, s.title, s.url, s.scraped_at,
                     bm25(scrapes_fts) as rank
              FROM scrapes_fts fts
              JOIN scrapes s ON fts.rowid = s.rowid
              WHERE scrapes_fts MATCH ?
              ORDER BY rank
              LIMIT ?
            `).all(escapedTerms, maxResults) as typeof scrapeResults;
          } catch (err) {
            logger.debug({ error: err }, "Scrapes FTS search failed (table may not exist)");
          }

          try {
            ideaResults = sm.getDb().prepare(`
              SELECT i.id, i.title, i.status, i.source, i.link, i.created_at,
                     snippet(ideas_fts, 1, '>>>', '<<<', '...', 50) as content,
                     bm25(ideas_fts) as rank
              FROM ideas_fts fts
              JOIN ideas i ON fts.rowid = i.rowid
              WHERE ideas_fts MATCH ?
              ORDER BY rank
              LIMIT ?
            `).all(escapedTerms, maxResults) as typeof ideaResults;
          } catch (err) {
            logger.debug({ error: err }, "Ideas FTS search failed (table may not exist)");
          }

          try {
            youtubeResults = sm.getDb().prepare(`
              SELECT y.video_id, y.title, y.channel_name, y.relevance_score, y.processed_at,
                     snippet(youtube_videos_fts, 1, '>>>', '<<<', '...', 50) as content,
                     bm25(youtube_videos_fts) as rank
              FROM youtube_videos_fts fts
              JOIN youtube_videos y ON fts.rowid = y.rowid
              WHERE youtube_videos_fts MATCH ?
              ORDER BY rank
              LIMIT ?
            `).all(escapedTerms, maxResults) as typeof youtubeResults;
          } catch (err) {
            logger.debug({ error: err }, "YouTube FTS search failed (table may not exist)");
          }

          try {
            transcriptResults = sm.getDb().prepare(`
              SELECT content_hash, agent, project, started_at,
                     snippet(transcript_fts, 0, '>>>', '<<<', '...', 50) as content,
                     bm25(transcript_fts) as rank
              FROM transcript_fts
              WHERE transcript_fts MATCH ?
              ORDER BY rank
              LIMIT ?
            `).all(escapedTerms, maxResults) as typeof transcriptResults;
          } catch (err) {
            logger.debug({ error: err }, "Transcript FTS search failed (table may not exist)");
          }
        }
      } catch (err) {
        logger.debug({ error: err }, "Session summaries FTS search failed (table may not exist yet)");
      }

      // ── Cross-table BM25 normalization ──────────────────────────
      // BM25 returns negative scores (more negative = better match).
      // Normalize per-table using absolute values so positive scores (weak matches) don't invert ranking.
      function normalizeBM25<T extends { rank: number }>(results: T[]): (T & { normalizedRank: number })[] {
        if (results.length === 0) return [];
        // Filter out non-negative ranks (marginal/no matches) — BM25 should be negative for real matches
        const validResults = results.filter(r => r.rank < 0);
        if (validResults.length === 0) {
          // All results are marginal — give them uniform low scores
          return results.map(r => ({ ...r, normalizedRank: 0.1 }));
        }
        const bestRank = Math.min(...validResults.map(r => r.rank)); // most negative = best
        return results.map(r => ({
          ...r,
          normalizedRank: r.rank >= 0 ? 0.05 : r.rank / bestRank, // 1.0 = best, non-negative → near zero
        }));
      }

      const indexStats = deps.indexer.getStats();
      const metaMap = new Map(indexStats.fileStats.map(f => [f.filePath, f.indexedAt]));

      // Normalize memory-file ranks into [0,1] so they fuse correctly against
      // per-table BM25 scores below. Two sources to handle:
      //   - hybridSearch(): carries an RRF `score` (higher = better, rank is a placeholder 0)
      //   - search():       carries a negative BM25 `rank` (lower = better)
      const memoryWithScore = memoryResults as Array<typeof memoryResults[number] & { score?: number }>;
      const hybridScores = memoryWithScore.map(r => r.score).filter((s): s is number => typeof s === "number" && s > 0);
      const bm25Ranks = memoryWithScore.map(r => r.rank).filter(r => r < 0);
      const bestHybrid = hybridScores.length > 0 ? Math.max(...hybridScores) : 0;
      const bestBm25 = bm25Ranks.length > 0 ? Math.min(...bm25Ranks) : 0;

      const enrichedMemory = memoryWithScore.map(r => {
        let normalizedRank: number;
        if (typeof r.score === "number" && r.score > 0 && bestHybrid > 0) {
          normalizedRank = r.score / bestHybrid; // RRF path
        } else if (r.rank < 0 && bestBm25 < 0) {
          normalizedRank = r.rank / bestBm25; // plain-FTS path
        } else {
          normalizedRank = 0.1; // marginal match
        }
        return {
          ...r,
          source_file: r.filePath,
          indexed_at: metaMap.get(r.filePath) ?? null,
          normalizedRank,
        };
      });

      // Normalize each table's BM25 scores independently
      const normSessions = normalizeBM25(sessionResults);
      const normThreads = normalizeBM25(threadResults);
      const normTakeovers = normalizeBM25(takeoverResults);
      const normScrapes = normalizeBM25(scrapeResults);
      const normIdeas = normalizeBM25(ideaResults);
      const normYoutube = normalizeBM25(youtubeResults);
      const normTranscripts = normalizeBM25(transcriptResults);

      // Build unified ranked results across all tables
      type UnifiedResult = { type: string; normalizedRank: number; data: Record<string, unknown> };
      const unified: UnifiedResult[] = [];

      for (const r of enrichedMemory) {
        unified.push({
          type: "memory",
          normalizedRank: r.normalizedRank,
          data: { ...r },
        });
      }
      for (const r of normSessions) {
        unified.push({
          type: "session", normalizedRank: r.normalizedRank,
          data: { id: r.id, title: r.title, summary: r.summary, project: r.project, agent: r.agent, startedAt: r.started_at, rank: r.rank },
        });
      }
      for (const r of normThreads) {
        unified.push({
          type: "thread", normalizedRank: r.normalizedRank,
          data: { id: r.id, threadId: r.thread_id, role: r.role, content: r.content, createdAt: r.created_at, rank: r.rank },
        });
      }
      for (const r of normTakeovers) {
        unified.push({
          type: "takeover", normalizedRank: r.normalizedRank,
          data: { id: r.id, jobId: r.job_id, diagnosis: r.diagnosis, fixDescription: r.fix_description, decision: r.decision, retrySuccess: r.retry_success, createdAt: r.created_at, rank: r.rank },
        });
      }
      for (const r of normScrapes) {
        unified.push({
          type: "scrape", normalizedRank: r.normalizedRank,
          data: { id: r.id, source: r.source, title: r.title, url: r.url, scrapedAt: r.scraped_at, rank: r.rank },
        });
      }
      for (const r of normIdeas) {
        unified.push({
          type: "idea", normalizedRank: r.normalizedRank,
          data: { id: r.id, title: r.title, status: r.status, source: r.source, link: r.link, content: r.content, createdAt: r.created_at, rank: r.rank },
        });
      }
      for (const r of normYoutube) {
        unified.push({
          type: "youtube", normalizedRank: r.normalizedRank,
          data: { videoId: r.video_id, title: r.title, channelName: r.channel_name, relevanceScore: r.relevance_score, content: r.content, processedAt: r.processed_at, rank: r.rank },
        });
      }
      for (const r of normTranscripts) {
        // Demote transcripts to 70% — fallback tier behind curated memory & summaries
        unified.push({
          type: "transcript", normalizedRank: r.normalizedRank * 0.7,
          data: { contentHash: r.content_hash, agent: r.agent, project: r.project, startedAt: r.started_at, content: r.content, rank: r.rank },
        });
      }

      // ── Preference-based boost (30% max influence) ──────────────
      try {
        const sm = deps.getSharedStateManager();
        const prefs = getTopPreferences(sm.getDb(), 15);
        if (prefs.length > 0) {
          const prefTerms = prefs.map(p => ({
            term: p.dimension.split(":").slice(1).join(":").toLowerCase() || p.dimension.toLowerCase(),
            weight: p.score - 0.5, // positive = likes, negative = dislikes
          })).filter(p => p.term.length > 0);

          for (const u of unified) {
            const text = JSON.stringify(u.data).toLowerCase();
            let boost = 0;
            let matches = 0;
            for (const pref of prefTerms) {
              if (text.includes(pref.term)) {
                boost += pref.weight;
                matches++;
              }
            }
            if (matches > 0) {
              // Normalize and cap at 30% influence
              const normalizedBoost = Math.min(0.3, Math.max(-0.3, boost / matches));
              u.normalizedRank *= (1 + normalizedBoost);
            }
          }
        }
      } catch {
        // preference_model table may not exist yet
      }

      // Sort globally by normalized rank (descending — 1.0 is best)
      unified.sort((a, b) => b.normalizedRank - a.normalizedRank);

      // Return both the unified ranked list AND the legacy grouped format for backward compatibility
      const combined = {
        // Unified ranking: top results across all tables, sorted by relevance
        ranked: unified.slice(0, maxResults).map(u => ({ type: u.type, normalizedRank: u.normalizedRank, ...u.data })),
        // Legacy grouped format (preserved for existing consumers)
        memory: enrichedMemory,
        sessions: normSessions.map((r) => ({
          type: "session" as const, id: r.id, title: r.title, summary: r.summary,
          project: r.project, agent: r.agent, startedAt: r.started_at, rank: r.rank, normalizedRank: r.normalizedRank,
        })),
        threads: normThreads.map((r) => ({
          type: "thread" as const, id: r.id, threadId: r.thread_id, role: r.role,
          content: r.content, createdAt: r.created_at, rank: r.rank, normalizedRank: r.normalizedRank,
        })),
        takeovers: normTakeovers.map((r) => ({
          type: "takeover" as const, id: r.id, jobId: r.job_id, diagnosis: r.diagnosis,
          fixDescription: r.fix_description, decision: r.decision,
          retrySuccess: r.retry_success, createdAt: r.created_at, rank: r.rank, normalizedRank: r.normalizedRank,
        })),
        scrapes: normScrapes.map((r) => ({
          type: "scrape" as const, id: r.id, source: r.source, title: r.title,
          url: r.url, scrapedAt: r.scraped_at, rank: r.rank, normalizedRank: r.normalizedRank,
        })),
        ideas: normIdeas.map((r) => ({
          type: "idea" as const, id: r.id, title: r.title, status: r.status,
          source: r.source, link: r.link, content: r.content, createdAt: r.created_at, rank: r.rank, normalizedRank: r.normalizedRank,
        })),
        youtube: normYoutube.map((r) => ({
          type: "youtube" as const, videoId: r.video_id, title: r.title,
          channelName: r.channel_name, relevanceScore: r.relevance_score,
          content: r.content, processedAt: r.processed_at, rank: r.rank, normalizedRank: r.normalizedRank,
        })),
        transcripts: normTranscripts.map((r) => ({
          type: "transcript" as const, contentHash: r.content_hash, agent: r.agent,
          project: r.project, startedAt: r.started_at, content: r.content,
          rank: r.rank, normalizedRank: r.normalizedRank,
        })),
      };

      return { content: [{ type: "text", text: JSON.stringify(combined, null, 2) }] };
    }

    case "memory_hybrid_search": {
      const { query, context, limit } = args as { query: string; context?: "work" | "general"; limit?: number };
      const results = await deps.indexer.hybridSearch(query, limit || 10, context);
      const hybridStats = deps.indexer.getStats();
      const hybridMetaMap = new Map(hybridStats.fileStats.map(f => [f.filePath, f.indexedAt]));
      const enrichedResults = results.map(r => ({ ...r, source_file: r.filePath, indexed_at: hybridMetaMap.get(r.filePath) ?? null }));
      return { content: [{ type: "text", text: JSON.stringify(enrichedResults, null, 2) }] };
    }

    case "memory_generate_embeddings": {
      const stats = await deps.indexer.generateEmbeddings();
      return { content: [{ type: "text", text: `Generated ${stats.generated} embeddings, ${stats.skipped} skipped, ${stats.errors} errors` }] };
    }

    case "memory_promote": {
      // Rerouted through claims pipeline for HITL — direct writes bypass all review.
      // High confidence (0.95) makes it auto-approve eligible but still logged.
      const { content, file, section } = args as { content: string; file: "me" | "work" | "preferences" | "tools"; section?: string };
      const sm = deps.getSharedStateManager();
      try {
        const { insertCandidate } = await import("../../memory/claims.js");
        const claimId = insertCandidate(sm.getDb(), {
          content,
          targetFile: file,
          section: section ?? "",
          claimType: "fact",
          confidence: 0.95,
          originChannel: "mcp-promote",
        });
        if (!claimId) {
          return { content: [{ type: "text", text: `Skipped — duplicate (already pending or promoted to ${file}.md)` }] };
        }
        return { content: [{ type: "text", text: `Queued for review (${claimId}) → ${file}.md${section ? ` / "${section}"` : ""}. High confidence — will auto-approve or appear in next Memory Moments.` }] };
      } catch (err) {
        // Fail closed: do NOT fall back to direct write — HITL gate must be honored.
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to queue for review: ${msg}. Use memory_suggest as alternative.` }] };
      }
    }

    case "memory_read": {
      const { file, date, source } = args as { file: string; date?: string; source?: "file" | "archive" };

      if (file === "daily" && source === "archive") {
        const dateStr = date ?? new Date().toISOString().slice(0, 10);
        const sm = deps.getSharedStateManager();
        const archive = sm.getDailyLogArchive(dateStr);
        if (!archive) return { content: [{ type: "text", text: `No archive found for ${dateStr}` }] };
        return { content: [{ type: "text", text: archive.rawContent }] };
      }

      if (file === "daily") {
        const dateStr = date ?? new Date().toISOString().slice(0, 10);
        const sm = deps.getSharedStateManager();
        try {
          const sessions = sm.getDb().prepare(`
            SELECT agent, title, summary, started_at, project
            FROM session_summaries
            WHERE date(COALESCE(started_at, created_at)) = ?
              AND status = 'active'
            ORDER BY COALESCE(started_at, created_at) ASC
          `).all(dateStr) as Array<{ agent: string; title: string; summary: string; started_at: string | null; project: string | null }>;

          if (sessions.length > 0) {
            const formatted = sessions.map(s => {
              const time = s.started_at?.slice(11, 16) || "??:??";
              return `[${time}] [${s.agent}] ${s.title}\n${s.summary}`;
            }).join("\n\n");
            return { content: [{ type: "text", text: `# ${dateStr} (from session_summaries)\n\n${formatted}` }] };
          }
        } catch {
          // fall through to legacy
        }

        const dailyPath = `${PATHS.daily}/${dateStr}.md`;
        if (existsSync(dailyPath)) {
          const rawDaily = await readFile(dailyPath, "utf-8");
          return { content: [{ type: "text", text: rawDaily }] };
        }
        return { content: [{ type: "text", text: `No daily data for ${dateStr}` }] };
      }

      const filePath = `${MEMORY_BASE}/${file}.md`;
      if (!existsSync(filePath)) return { content: [{ type: "text", text: `File not found: ${file}.md` }] };
      const content = await readFile(filePath, "utf-8");
      return { content: [{ type: "text", text: content }] };
    }

    case "memory_reindex": {
      const stats = await deps.indexer.indexAllMemoryFiles();
      const transcriptNote = stats.transcriptsIndexed ? `, ${stats.transcriptsIndexed} transcripts indexed` : "";
      return { content: [{ type: "text", text: `Reindexed: ${stats.indexed} files, ${stats.skipped} skipped, ${stats.errors} errors${transcriptNote}` }] };
    }

    case "memory_context": {
      const { days } = args as { days?: number };
      const lookbackDays = days || 3;
      const sections: string[] = [];
      const sm = deps.getSharedStateManager();

      const sessions = sm.getDb().prepare(`
        SELECT title, project, started_at
        FROM session_summaries
        WHERE is_sub_agent = 0 AND status = 'active'
          AND started_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
        ORDER BY started_at DESC LIMIT 3
      `).all(`-${lookbackDays} days`) as Array<{ title: string; project: string; started_at: string }>;

      if (sessions.length > 0) {
        sections.push("## Recent Sessions");
        for (const s of sessions) {
          const d = s.started_at.slice(5, 10);
          sections.push(`- [${d}] ${s.project || "~"}: ${(s.title || "untitled").slice(0, 50)}`);
        }
      }

      try {
        const recentThreads = sm.getDb().prepare(`
          SELECT t.title, t.chat_session_id, t.last_message_at
          FROM threads t
          WHERE t.last_message_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
            AND t.status = 'active'
          ORDER BY t.last_message_at DESC LIMIT 3
        `).all(`-${lookbackDays} days`) as Array<{ title: string; chat_session_id: string; last_message_at: string }>;

        if (recentThreads.length > 0) {
          sections.push("\n## Recent Conversations");
          for (const t of recentThreads) {
            const label = t.chat_session_id === "tg:system" ? "TG" : "Web";
            sections.push(`- [${label}] ${(t.title || "untitled").slice(0, 50)}`);
          }
        }
      } catch { /* threads table may not exist */ }

      const plans = loadPlansFromDir();
      const activePlans = plans.filter(p => p.status === "execution" || p.status === "planning");
      if (activePlans.length > 0) {
        sections.push(`\n## Active Plans (${activePlans.length})`);
        for (const p of activePlans) sections.push(`- ${p.title} (${p.completedTasks}/${p.totalTasks})`);
      }

      const reviewIdeas = ideaDao.getAllIdeas(sm.getDb(), { status: "review", limit: 3 });
      if (reviewIdeas.length > 0) {
        sections.push(`\n## Pending Decisions (${reviewIdeas.length})`);
        for (const idea of reviewIdeas) sections.push(`- "${idea.title.slice(0, 50)}"`);
      }

      const momentum = sm.getDb().prepare(`
        SELECT project, COUNT(*) as count
        FROM session_summaries
        WHERE is_sub_agent = 0 AND status = 'active'
          AND started_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
          AND project IS NOT NULL AND project != ''
        GROUP BY project ORDER BY count DESC LIMIT 5
      `).all(`-${lookbackDays} days`) as Array<{ project: string; count: number }>;

      if (momentum.length > 0) {
        sections.push("\n## Project Momentum");
        for (const m of momentum) {
          const heat = m.count >= 6 ? "hot" : m.count >= 3 ? "active" : "light";
          sections.push(`- ${m.project}: ${m.count} (${heat})`);
        }
      }

      const recentJobs = sm.getDb().prepare(`
        SELECT job_name, completed_at
        FROM scheduled_job_runs
        WHERE success = 1 AND completed_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
        ORDER BY completed_at DESC LIMIT 3
      `).all() as Array<{ job_name: string; completed_at: string }>;

      if (recentJobs.length > 0) {
        sections.push("\n## Recent Jobs");
        sections.push(recentJobs.map(j => j.job_name).join(", "));
      }

      try {
        const pendingOutcomes = sm.getDb().prepare(`
          SELECT source_title, check_at
          FROM outcome_checks
          WHERE status = 'pending' AND check_at <= datetime('now', '+3 days')
          ORDER BY check_at ASC LIMIT 3
        `).all() as Array<{ source_title: string; check_at: string }>;

        if (pendingOutcomes.length > 0) {
          sections.push("\n## Due Checks");
          for (const o of pendingOutcomes) sections.push(`- ${o.source_title} (${o.check_at.slice(0, 10)})`);
        }
      } catch { /* outcome_checks table may not exist yet */ }

      const output = sections.length > 0 ? sections.join("\n") : "No recent activity found.";
      return { content: [{ type: "text", text: output }] };
    }

    case "memory_candidates": {
      const { limit: candidateLimit, status: candidateStatus } = args as { limit?: number; status?: string };
      const sm = deps.getSharedStateManager();
      try {
        const statusFilter = candidateStatus ?? "candidate";
        const maxResults = candidateLimit ?? 5;
        const rows = sm.getDb().prepare(`
          SELECT id, content, target_file as targetFile, section, claim_type as claimType,
                 confidence, status, created_at as createdAt
          FROM knowledge_claims
          WHERE status = ?
          ORDER BY confidence DESC, created_at ASC
          LIMIT ?
        `).all(statusFilter, maxResults) as Array<{
          id: string; content: string; targetFile: string; section: string | null;
          claimType: string; confidence: number; status: string; createdAt: string;
        }>;

        if (rows.length === 0) {
          return { content: [{ type: "text", text: `No ${statusFilter} candidates found.` }] };
        }

        return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
      } catch {
        return { content: [{ type: "text", text: "knowledge_claims table not yet available (migration 069 pending)" }] };
      }
    }

    case "memory_replace": {
      // Route through claims for HITL review
      const { file: replFile, old_text, new_text, reason } = args as {
        file: string; old_text: string; new_text: string; reason?: string;
      };
      const replSm = deps.getSharedStateManager();
      try {
        const { insertCandidate } = await import("../../memory/claims.js");
        const claimContent = [
          `REPLACE in ${replFile}.md`,
          reason ? `Reason: ${reason}` : "",
          "",
          "--- Old Text ---",
          old_text,
          "",
          "--- New Text ---",
          new_text,
        ].filter(Boolean).join("\n");

        const claimId = insertCandidate(replSm.getDb(), {
          content: claimContent,
          targetFile: replFile as "me" | "work" | "preferences" | "tools",
          section: "replace",
          claimType: "replace",
          confidence: 0.85,
          originChannel: "mcp-replace",
        });
        if (!claimId) {
          return { content: [{ type: "text", text: "Skipped — duplicate replacement proposal" }] };
        }
        return { content: [{ type: "text", text: `Replacement queued for review (${claimId}). Will appear in next Memory Moments.` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to queue replacement: ${msg}` }] };
      }
    }

    case "memory_remove": {
      // Route through claims for HITL review
      const { file: rmFile, text: rmText, reason: rmReason } = args as {
        file: string; text: string; reason?: string;
      };
      const rmSm = deps.getSharedStateManager();
      try {
        const { insertCandidate } = await import("../../memory/claims.js");
        const claimContent = [
          `REMOVE from ${rmFile}.md`,
          rmReason ? `Reason: ${rmReason}` : "",
          "",
          "--- Text to Remove ---",
          rmText,
        ].filter(Boolean).join("\n");

        const claimId = insertCandidate(rmSm.getDb(), {
          content: claimContent,
          targetFile: rmFile as "me" | "work" | "preferences" | "tools",
          section: "remove",
          claimType: "remove",
          confidence: 0.80,
          originChannel: "mcp-remove",
        });
        if (!claimId) {
          return { content: [{ type: "text", text: "Skipped — duplicate removal proposal" }] };
        }
        return { content: [{ type: "text", text: `Removal queued for review (${claimId}). Will appear in next Memory Moments.` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to queue removal: ${msg}` }] };
      }
    }

    case "memory_suggest": {
      const { content, file, section, claim_type, confidence, session_id } = args as {
        content: string; file: string; section?: string; claim_type?: string;
        confidence?: number; session_id?: string;
      };
      const sm = deps.getSharedStateManager();
      try {
        const { insertCandidate } = await import("../../memory/claims.js");
        const claimId = insertCandidate(sm.getDb(), {
          content,
          targetFile: file as "me" | "work" | "preferences" | "tools",
          section: section ?? "",
          claimType: (claim_type ?? "fact") as "fact" | "decision" | "preference" | "question" | "lesson",
          confidence: confidence ?? 0.7,
          sessionIds: session_id ? [session_id] : undefined,
          originChannel: "mcp-suggest",
        });
        if (!claimId) {
          return { content: [{ type: "text", text: `Skipped — duplicate (already pending or approved in ${file}.md)` }] };
        }
        return { content: [{ type: "text", text: `Queued for review (${claimId}). Will appear in next Memory Moments batch.` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to suggest: ${msg}` }] };
      }
    }

    case "memory_debug": {
      const { session_id, last_n } = args as { session_id?: string; last_n?: number };
      const sm = deps.getSharedStateManager();
      const db = sm.getDb();

      let sessions: Array<{ id: string; title: string; project: string | null; agent: string; started_at: string | null; processed_for_promotion: number }>;
      if (session_id) {
        sessions = db.prepare(`
          SELECT id, title, project, agent, started_at, processed_for_promotion
          FROM session_summaries WHERE id = ?
        `).all(session_id) as typeof sessions;
        if (sessions.length === 0) {
          return { content: [{ type: "text", text: `No session_summaries row with id=${session_id}` }] };
        }
      } else {
        const limit = Math.min(Math.max(last_n ?? 1, 1), 5);
        sessions = db.prepare(`
          SELECT id, title, project, agent, started_at, processed_for_promotion
          FROM session_summaries
          WHERE processed_for_promotion = 1
          ORDER BY started_at DESC
          LIMIT ?
        `).all(limit) as typeof sessions;
      }

      const placeholders = sessions.map(() => "?").join(",") || "''";
      const claimRows = db.prepare(`
        SELECT
          id, content, target_file, section, claim_type,
          confidence, status, decided_by, decided_at, created_at,
          telegram_message_id, session_id
        FROM knowledge_claims
        WHERE session_id IN (${placeholders})
        ORDER BY created_at ASC
      `).all(...sessions.map(s => s.id)) as Array<{
        id: string; content: string; target_file: string; section: string | null; claim_type: string;
        confidence: number; status: string; decided_by: string | null; decided_at: string | null;
        created_at: string; telegram_message_id: number | null; session_id: string;
      }>;

      const routeOf = (c: typeof claimRows[number]): string => {
        if (c.status === "approved" && c.decided_by === "auto-approve") return "auto-approve (>=0.95)";
        if (c.status === "approved") return `HITL-approved by ${c.decided_by ?? "user"}`;
        if (c.status === "candidate") return "HITL-pending";
        if (c.status === "rejected") return `HITL-rejected by ${c.decided_by ?? "user"}`;
        if (c.status === "stale") return "stale (lint flagged)";
        if (c.status === "expired") return "expired (>7d unreviewed)";
        if (c.status === "applying") return "in-flight (applying)";
        if (c.status === "archived") return "archived";
        return c.status;
      };

      const counts: Record<string, number> = {};
      for (const c of claimRows) {
        const r = routeOf(c);
        counts[r] = (counts[r] ?? 0) + 1;
      }

      const out = {
        sessions: sessions.map(s => ({
          id: s.id,
          title: s.title,
          project: s.project,
          agent: s.agent,
          started_at: s.started_at,
          processed: s.processed_for_promotion === 1,
        })),
        routing_counts: counts,
        claims: claimRows.map(c => ({
          id: c.id,
          session_id: c.session_id,
          content: c.content.length > 200 ? c.content.slice(0, 200) + "…" : c.content,
          target: `${c.target_file}.md${c.section ? ` / ${c.section}` : ""}`,
          claim_type: c.claim_type,
          confidence: c.confidence,
          routing: routeOf(c),
          decided_at: c.decided_at,
          telegram_message_id: c.telegram_message_id,
        })),
        notes: [
          "Claims with confidence < 0.20 are dropped as noise and not stored — they will not appear here.",
          "Sub-agent sessions are skipped by the harvester and so produce no claims.",
        ],
      };

      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }

    default:
      return null;
  }
}
