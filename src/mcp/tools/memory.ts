/**
 * Memory tools: search, hybrid_search, generate_embeddings, append, promote, read, reindex, suggestions, context
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
    description: "Search memory using FTS5 full-text search. Returns ranked results with snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (supports OR, phrase matching)" },
        context: { type: "string", enum: ["work", "life", "general"], description: "Filter by context (optional)" },
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
        context: { type: "string", enum: ["work", "life", "general"], description: "Filter by context (optional)" },
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
    name: "memory_append",
    description: "Append a session note to Homer's memory (stored in session_summaries). Use for decisions, blockers, and observations during daemon/scheduled jobs.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Content to append" },
        context: { type: "string", enum: ["work", "life", "general"], description: "Context tag (default: general)" },
      },
      required: ["content"],
    },
  },
  {
    name: "memory_promote",
    description: "Promote a fact to a permanent memory file. Use for lasting information.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Content to add" },
        file: { type: "string", enum: ["me", "work", "life", "preferences", "tools"], description: "Target file to append to" },
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
        file: { type: "string", enum: ["me", "work", "life", "preferences", "tools", "daily"], description: "File to read (daily = today's log)" },
        date: { type: "string", description: "For daily: specific date YYYY-MM-DD (default: today)" },
        source: { type: "string", enum: ["file", "archive"], description: "For daily: 'file' reads .md (default), 'archive' reads full raw content from SQLite" },
      },
      required: ["file"],
    },
  },
  {
    name: "memory_reindex",
    description: "Reindex all memory files for search. Run after major changes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "memory_suggestions",
    description: "Get suggestions for facts from daily log that should be promoted to permanent files.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date to analyze YYYY-MM-DD (default: today)" },
      },
    },
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
    name: "memory_suggest",
    description: "Suggest a fact for permanent memory, queued for human review via Telegram. Use instead of memory_promote when the fact should be reviewed before persisting. Good for preserving valuable synthesis from conversations.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The fact or synthesis to remember" },
        file: { type: "string", enum: ["me", "work", "life", "preferences", "tools"], description: "Target memory file" },
        section: { type: "string", description: "Optional section header" },
        claim_type: { type: "string", enum: ["fact", "decision", "preference", "question", "lesson"], description: "Type of claim (default: fact)" },
        confidence: { type: "number", description: "0.0-1.0 confidence (default: 0.7)" },
        session_id: { type: "string", description: "Optional source session ID for attribution" },
      },
      required: ["content", "file"],
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
        context?: "work" | "life" | "general";
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
      const enrichedMemory = memoryResults.map(r => ({
        ...r,
        source_file: r.filePath,
        indexed_at: metaMap.get(r.filePath) ?? null,
      }));

      // Normalize each table's BM25 scores independently
      const normSessions = normalizeBM25(sessionResults);
      const normThreads = normalizeBM25(threadResults);
      const normTakeovers = normalizeBM25(takeoverResults);
      const normScrapes = normalizeBM25(scrapeResults);
      const normIdeas = normalizeBM25(ideaResults);
      const normYoutube = normalizeBM25(youtubeResults);

      // Build unified ranked results across all tables
      type UnifiedResult = { type: string; normalizedRank: number; data: Record<string, unknown> };
      const unified: UnifiedResult[] = [];

      for (const r of enrichedMemory) {
        // Memory results from hybrid/FTS search already have their own scoring
        unified.push({
          type: "memory",
          normalizedRank: r.rank === 0 ? 0 : 1.0, // Memory results are pre-ranked
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
      };

      return { content: [{ type: "text", text: JSON.stringify(combined, null, 2) }] };
    }

    case "memory_hybrid_search": {
      const { query, context, limit } = args as { query: string; context?: "work" | "life" | "general"; limit?: number };
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

    case "memory_append": {
      const { content, context } = args as { content: string; context?: "work" | "life" | "general" };
      const time = new Date().toTimeString().slice(0, 5);
      const title = `[${context || "general"}] ${content.slice(0, 80)}`;
      deps.canonicalMemory.insertSessionEvent(title, content, context || "general");
      return { content: [{ type: "text", text: `Appended to session_summaries at ${time}` }] };
    }

    case "memory_promote": {
      const { content, file, section } = args as { content: string; file: "me" | "work" | "life" | "preferences" | "tools"; section?: string };
      const promoted = await deps.canonicalMemory.promoteToFile(content, file, section ?? null, "mcp");
      if (!promoted) {
        return { content: [{ type: "text", text: `Skipped — duplicate (already promoted to ${file}.md)` }] };
      }
      return { content: [{ type: "text", text: `Promoted to ${file}.md${section ? ` under "${section}"` : ""}` }] };
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
      return { content: [{ type: "text", text: `Reindexed: ${stats.indexed} files, ${stats.skipped} skipped, ${stats.errors} errors` }] };
    }

    case "memory_suggestions": {
      const { date } = args as { date?: string };
      const dateStr = date ?? new Date().toISOString().slice(0, 10);
      const sm = deps.getSharedStateManager();
      const sessions = sm.getDb().prepare(`
        SELECT title, summary
        FROM session_summaries
        WHERE date(COALESCE(started_at, created_at)) = ?
          AND status = 'active'
        ORDER BY COALESCE(started_at, created_at) ASC
      `).all(dateStr) as Array<{ title: string; summary: string }>;

      const suggestions: Array<{ content: string; suggestedFile: string; reason: string }> = [];
      for (const session of sessions) {
        const text = `${session.title} ${session.summary}`.toLowerCase();
        if (text.includes("config") || text.includes("cli") || text.includes("setup")) {
          suggestions.push({ content: `${session.title}: ${session.summary}`, suggestedFile: "tools", reason: "Contains tool/config information" });
        }
        if (text.includes("meeting") || text.includes("project") || text.includes("decision")) {
          suggestions.push({ content: `${session.title}: ${session.summary}`, suggestedFile: "work", reason: "Contains work-related decision or update" });
        }
        if (text.includes("prefer") || text.includes("style") || text.includes("always")) {
          suggestions.push({ content: `${session.title}: ${session.summary}`, suggestedFile: "preferences", reason: "Contains preference or style information" });
        }
      }

      return {
        content: [{ type: "text", text: suggestions.length > 0 ? JSON.stringify(suggestions, null, 2) : "No promotion suggestions for this day" }],
      };
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
          targetFile: file as "me" | "work" | "life" | "preferences" | "tools",
          section: section ?? "",
          claimType: (claim_type ?? "fact") as "fact" | "decision" | "preference" | "question" | "lesson",
          confidence: confidence ?? 0.7,
          sessionIds: session_id ? [session_id] : undefined,
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

    default:
      return null;
  }
}
