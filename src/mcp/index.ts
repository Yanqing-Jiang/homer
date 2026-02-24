#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getMemoryIndexer } from "../memory/indexer.js";
import { appendDailyLog, createDailyEntry, readDailyLog } from "../memory/daily.js";
import { StateManager } from "../state/manager.js";
import { logger } from "../utils/logger.js";
import { appendFile, readFile, mkdir, rename } from "fs/promises";
import { existsSync } from "fs";
import {
  type ParsedIdea,
} from "../ideas/parser.js";
import * as ideaDao from "../ideas/dao.js";
import { savePlanFile, parsePlanFile, loadPlansFromDir, type ParsedPhase } from "../plans/parser.js";
// Shared StateManager singleton — better-sqlite3 is synchronous, MCP is single-threaded
let sharedSM: StateManager | null = null;
function getSharedStateManager(): StateManager {
  if (!sharedSM) {
    sharedSM = new StateManager("/Users/yj/homer/data/homer.db");
  }
  return sharedSM;
}

// Lazy-load azure-blob to avoid startup failure if @azure/storage-blob is not installed
// Memory tools will work without it; blob tools will fail gracefully
let azureBlobModule: typeof import("../integrations/azure-blob.js") | null = null;
async function getAzureBlob() {
  if (!azureBlobModule) {
    try {
      azureBlobModule = await import("../integrations/azure-blob.js");
    } catch (error) {
      throw new Error("Azure Blob Storage not available. Install @azure/storage-blob: npm install @azure/storage-blob");
    }
  }
  return azureBlobModule;
}
// randomUUID removed - using timestamp-based IDs for consistency

const MEMORY_BASE = "/Users/yj/memory";
const PLANS_DIR = `${MEMORY_BASE}/plans`;
const FEEDBACK_FILE = `${MEMORY_BASE}/feedback.md`;

/**
 * Homer Memory MCP Server
 *
 * Provides tools for:
 * - memory_search: FTS5 search across all memory
 * - memory_append: Append to daily log
 * - memory_promote: Promote facts to permanent files
 * - memory_read: Read a memory file
 * - memory_suggestions: Get suggestions for promoting daily entries
 */
const server = new Server(
  {
    name: "homer-memory",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Initialize indexer
const indexer = getMemoryIndexer();

/**
 * List available tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "memory_search",
        description: "Search memory using FTS5 full-text search. Returns ranked results with snippets.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query (supports OR, phrase matching)",
            },
            context: {
              type: "string",
              enum: ["work", "life", "general"],
              description: "Filter by context (optional)",
            },
            limit: {
              type: "number",
              description: "Max results to return (default: 10)",
            },
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
            query: {
              type: "string",
              description: "Search query (natural language works best)",
            },
            context: {
              type: "string",
              enum: ["work", "life", "general"],
              description: "Filter by context (optional)",
            },
            limit: {
              type: "number",
              description: "Max results to return (default: 10)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "memory_generate_embeddings",
        description: "Generate embeddings for all indexed chunks. Run after memory_reindex to enable hybrid search.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "memory_append",
        description: "Append an entry to today's daily log. Use for session notes, decisions, blockers.",
        inputSchema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "Content to append",
            },
            context: {
              type: "string",
              enum: ["work", "life", "general"],
              description: "Context tag (default: general)",
            },
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
            content: {
              type: "string",
              description: "Content to add",
            },
            file: {
              type: "string",
              enum: ["me", "work", "life", "preferences", "tools"],
              description: "Target file to append to",
            },
            section: {
              type: "string",
              description: "Optional section header to add under",
            },
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
            file: {
              type: "string",
              enum: ["me", "work", "life", "preferences", "tools", "daily"],
              description: "File to read (daily = today's log)",
            },
            date: {
              type: "string",
              description: "For daily: specific date YYYY-MM-DD (default: today)",
            },
            source: {
              type: "string",
              enum: ["file", "archive"],
              description: "For daily: 'file' reads .md (default), 'archive' reads full raw content from SQLite",
            },
          },
          required: ["file"],
        },
      },
      {
        name: "memory_reindex",
        description: "Reindex all memory files for search. Run after major changes.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "memory_suggestions",
        description: "Get suggestions for facts from daily log that should be promoted to permanent files.",
        inputSchema: {
          type: "object",
          properties: {
            date: {
              type: "string",
              description: "Date to analyze YYYY-MM-DD (default: today)",
            },
          },
        },
      },
      // Idea management tools
      {
        name: "idea_add",
        description: "Add a new idea to ideas.md with source and context.",
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Short title for the idea",
            },
            content: {
              type: "string",
              description: "Main content/description of the idea",
            },
            source: {
              type: "string",
              description: "Source of the idea (e.g., github-trending, bookmark, moltbot)",
            },
            context: {
              type: "string",
              description: "Why this is relevant (optional)",
            },
            link: {
              type: "string",
              description: "URL reference (optional)",
            },
          },
          required: ["title", "content", "source"],
        },
      },
      {
        name: "idea_update",
        description: "Update an existing idea's status or add notes.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Idea ID (first 8 chars of UUID or timestamp)",
            },
            status: {
              type: "string",
              enum: ["draft", "review", "planning", "execution", "archived"],
              description: "New status for the idea",
            },
            notes: {
              type: "string",
              description: "Additional notes to add",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "idea_list",
        description: "List ideas filtered by status.",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["draft", "review", "planning", "execution", "archived", "all"],
              description: "Filter by status (default: draft)",
            },
          },
        },
      },
      // Plan management tools
      {
        name: "plan_create",
        description: "Create a new plan file with YAML frontmatter and task checkboxes.",
        inputSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Plan title",
            },
            description: {
              type: "string",
              description: "Plan description and goals",
            },
            phases: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Phase name" },
                  tasks: {
                    type: "array",
                    items: { type: "string" },
                    description: "Task descriptions for this phase",
                  },
                },
                required: ["name", "tasks"],
              },
              description: "Phases with task lists",
            },
            status: {
              type: "string",
              enum: ["planning", "execution", "completed"],
              description: "Initial status (default: planning)",
            },
            ideaId: {
              type: "string",
              description: "ID of the source idea (optional)",
            },
          },
          required: ["title", "description"],
        },
      },
      {
        name: "plan_update",
        description: "Update a plan's status or phase.",
        inputSchema: {
          type: "object",
          properties: {
            slug: {
              type: "string",
              description: "Plan slug (filename without .md)",
            },
            status: {
              type: "string",
              enum: ["planning", "execution", "completed"],
              description: "New status",
            },
            currentPhase: {
              type: "string",
              description: "Current phase name",
            },
            notes: {
              type: "string",
              description: "Notes to append to feedback log",
            },
          },
          required: ["slug"],
        },
      },
      {
        name: "plan_list",
        description: "List all plans with their current status.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "plan_archive",
        description:
          "Archive a completed plan. Sets status to 'completed' and moves to archive folder. Plan is preserved but hidden from active listings.",
        inputSchema: {
          type: "object",
          properties: {
            slug: {
              type: "string",
              description: "Plan slug (filename without .md)",
            },
          },
          required: ["slug"],
        },
      },
      {
        name: "plan_add_task",
        description: "Add a task to an existing plan phase. Creates the phase if it doesn't exist.",
        inputSchema: {
          type: "object",
          properties: {
            slug: {
              type: "string",
              description: "Plan slug (filename without .md)",
            },
            task: {
              type: "string",
              description: "Task text to add as a checkbox item",
            },
            phase: {
              type: "string",
              description: "Phase name (if omitted, adds to first phase)",
            },
          },
          required: ["slug", "task"],
        },
      },
      // Feedback logging
      {
        name: "feedback_log",
        description: "Log a decision or feedback from the user.",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["approve", "reject", "explore", "comment"],
              description: "Type of action",
            },
            target: {
              type: "string",
              description: "What the feedback is about (idea title or plan name)",
            },
            notes: {
              type: "string",
              description: "Additional notes or context",
            },
          },
          required: ["action", "target"],
        },
      },
      // Azure Blob Storage tools
      {
        name: "blob_upload",
        description: "Upload a file to Azure Blob Storage.",
        inputSchema: {
          type: "object",
          properties: {
            localFilePath: {
              type: "string",
              description: "Path to the local file to upload (supports ~ for home directory)",
            },
            blobName: {
              type: "string",
              description: "Name for the blob (optional, defaults to filename)",
            },
          },
          required: ["localFilePath"],
        },
      },
      {
        name: "blob_upload_content",
        description: "Upload text or buffer content to Azure Blob Storage.",
        inputSchema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "Content to upload (text)",
            },
            blobName: {
              type: "string",
              description: "Name for the blob",
            },
            contentType: {
              type: "string",
              description: "Content type (default: application/octet-stream)",
            },
          },
          required: ["content", "blobName"],
        },
      },
      {
        name: "blob_download",
        description: "Download a blob from Azure Blob Storage to local file system.",
        inputSchema: {
          type: "object",
          properties: {
            blobName: {
              type: "string",
              description: "Name of the blob to download",
            },
            localFilePath: {
              type: "string",
              description: "Local path to save the file (supports ~ for home directory)",
            },
          },
          required: ["blobName", "localFilePath"],
        },
      },
      {
        name: "blob_get_content",
        description: "Download blob content as text.",
        inputSchema: {
          type: "object",
          properties: {
            blobName: {
              type: "string",
              description: "Name of the blob to download",
            },
          },
          required: ["blobName"],
        },
      },
      {
        name: "blob_list",
        description: "List blobs in the Azure storage container.",
        inputSchema: {
          type: "object",
          properties: {
            prefix: {
              type: "string",
              description: "Optional prefix to filter blobs (e.g., 'backups/')",
            },
          },
        },
      },
      {
        name: "blob_delete",
        description: "Delete a blob from Azure Blob Storage. Requires confirm=true.",
        inputSchema: {
          type: "object",
          properties: {
            blobName: {
              type: "string",
              description: "Name of the blob to delete",
            },
            confirm: {
              type: "boolean",
              description: "Must be true to confirm deletion",
            },
          },
          required: ["blobName", "confirm"],
        },
      },
      {
        name: "blob_exists",
        description: "Check if a blob exists in Azure Blob Storage.",
        inputSchema: {
          type: "object",
          properties: {
            blobName: {
              type: "string",
              description: "Name of the blob to check",
            },
          },
          required: ["blobName"],
        },
      },
      {
        name: "blob_properties",
        description: "Get blob metadata and properties.",
        inputSchema: {
          type: "object",
          properties: {
            blobName: {
              type: "string",
              description: "Name of the blob",
            },
          },
          required: ["blobName"],
        },
      },
      // Context & intelligence tools
      {
        name: "memory_context",
        description: "Returns recent session context, active plans, pending decisions, and project momentum for session warmup. No LLM call, pure SQL + file reads, fast.",
        inputSchema: {
          type: "object",
          properties: {
            days: {
              type: "number",
              description: "Number of days to look back (default: 7)",
            },
          },
        },
      },
      {
        name: "outcome_check",
        description: "Manually trigger an outcome check for a specific item. Creates an outcome_check entry for tracking.",
        inputSchema: {
          type: "object",
          properties: {
            source_type: {
              type: "string",
              enum: ["idea", "plan", "application", "promotion", "improvement"],
              description: "Type of item to check",
            },
            source_id: {
              type: "string",
              description: "ID of the item",
            },
            source_title: {
              type: "string",
              description: "Title/description of the item",
            },
            check_days: {
              type: "number",
              description: "Days from now to schedule the check (default: 14)",
            },
          },
          required: ["source_type", "source_id", "source_title"],
        },
      },
      {
        name: "preference_query",
        description: "Query the preference model for learned user preferences. Returns top preferences with scores and evidence counts.",
        inputSchema: {
          type: "object",
          properties: {
            dimension: {
              type: "string",
              description: "Optional prefix filter (e.g., 'topic:', 'source:', 'project:')",
            },
            limit: {
              type: "number",
              description: "Max results (default: 20)",
            },
          },
        },
      },
      // Meeting tools
      {
        name: "meeting_list",
        description: "List recorded meetings with transcripts.",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["pending", "transcribing", "mapping", "summarizing", "complete", "error", "all"],
              description: "Filter by status (default: all)",
            },
            limit: {
              type: "number",
              description: "Max results to return (default: 20)",
            },
            attendee: {
              type: "string",
              description: "Filter by attendee name",
            },
          },
        },
      },
      {
        name: "meeting_search",
        description: "Search meeting transcripts and content. Use for queries like 'what did X say about Y'.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query",
            },
            limit: {
              type: "number",
              description: "Max results to return (default: 10)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "meeting_get",
        description: "Get full meeting details including transcript.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Meeting ID",
            },
          },
          required: ["id"],
        },
      },
    ],
  };
});

/**
 * Handle tool calls
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "memory_search": {
        const { query, context, limit } = args as {
          query: string;
          context?: "work" | "life" | "general";
          limit?: number;
        };
        const maxResults = limit || 10;

        // Auto-upgrade to hybrid search when embeddings exist
        const hasEmbeddings = indexer.getEmbeddingStats().totalEmbeddings > 0;
        const memoryResults = hasEmbeddings
          ? await indexer.hybridSearch(query, maxResults, context)
          : indexer.search(query, maxResults, context);

        // Also search session_summaries_fts, failure_takeover_fts, and thread_messages_fts
        let sessionResults: Array<{ id: string; title: string; summary: string; project: string; agent: string; started_at: string; rank: number }> = [];
        let takeoverResults: Array<{ id: number; job_id: string; diagnosis: string; fix_description: string | null; decision: string; retry_success: number | null; created_at: string; rank: number }> = [];
        let threadResults: Array<{ id: string; thread_id: string; role: string; created_at: string; content: string; rank: number }> = [];
        let scrapeResults: Array<{ id: string; source: string; title: string; url: string | null; scraped_at: string; rank: number }> = [];
        let ideaResults: Array<{ id: string; title: string; status: string; source: string; link: string | null; created_at: string; content: string; rank: number }> = [];
        let youtubeResults: Array<{ video_id: string; title: string; channel_name: string; relevance_score: number; processed_at: string; content: string; rank: number }> = [];
        try {
          const sm = getSharedStateManager();
          const escapedTerms = query
            .split(/\s+/)
            .filter(Boolean)
            .map((t) => t.replace(/[*()":^$]/g, ""))
            .filter(Boolean)
            .join(" OR ");

          if (escapedTerms) {
            sessionResults = sm.getDb().prepare(`
              SELECT s.id, s.title, s.summary, s.project, s.agent, s.started_at,
                     bm25(session_summaries_fts) as rank
              FROM session_summaries_fts fts
              JOIN session_summaries s ON fts.rowid = s.rowid
              WHERE session_summaries_fts MATCH ?
              ORDER BY rank
              LIMIT ?
            `).all(escapedTerms, maxResults) as typeof sessionResults;
          }

          // Also search failure_takeover_fts for past failure diagnoses
          if (escapedTerms) {
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
          }

          // Also search thread_messages_fts for Telegram/Web conversations
          if (escapedTerms) {
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
          }

          // Also search scrapes_fts for scraped content
          if (escapedTerms) {
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
          }

          // Search ideas_fts for idea content
          if (escapedTerms) {
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
          }

          // Search youtube_videos_fts for YouTube content
          if (escapedTerms) {
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
          // session_summaries_fts may not exist yet — gracefully degrade
          logger.debug({ error: err }, "Session summaries FTS search failed (table may not exist yet)");
        }

        // Combine results
        const combined = {
          memory: memoryResults,
          sessions: sessionResults.map((r) => ({
            type: "session" as const,
            id: r.id,
            title: r.title,
            summary: r.summary,
            project: r.project,
            agent: r.agent,
            startedAt: r.started_at,
            rank: r.rank,
          })),
          threads: threadResults.map((r) => ({
            type: "thread" as const,
            id: r.id,
            threadId: r.thread_id,
            role: r.role,
            content: r.content,
            createdAt: r.created_at,
            rank: r.rank,
          })),
          takeovers: takeoverResults.map((r) => ({
            type: "takeover" as const,
            id: r.id,
            jobId: r.job_id,
            diagnosis: r.diagnosis,
            fixDescription: r.fix_description,
            decision: r.decision,
            retrySuccess: r.retry_success,
            createdAt: r.created_at,
            rank: r.rank,
          })),
          scrapes: scrapeResults.map((r) => ({
            type: "scrape" as const,
            id: r.id,
            source: r.source,
            title: r.title,
            url: r.url,
            scrapedAt: r.scraped_at,
            rank: r.rank,
          })),
          ideas: ideaResults.map((r) => ({
            type: "idea" as const,
            id: r.id,
            title: r.title,
            status: r.status,
            source: r.source,
            link: r.link,
            content: r.content,
            createdAt: r.created_at,
            rank: r.rank,
          })),
          youtube: youtubeResults.map((r) => ({
            type: "youtube" as const,
            videoId: r.video_id,
            title: r.title,
            channelName: r.channel_name,
            relevanceScore: r.relevance_score,
            content: r.content,
            processedAt: r.processed_at,
            rank: r.rank,
          })),
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(combined, null, 2),
            },
          ],
        };
      }

      case "memory_hybrid_search": {
        const { query, context, limit } = args as {
          query: string;
          context?: "work" | "life" | "general";
          limit?: number;
        };
        const results = await indexer.hybridSearch(query, limit || 10, context);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      case "memory_generate_embeddings": {
        const stats = await indexer.generateEmbeddings();
        return {
          content: [
            {
              type: "text",
              text: `Generated ${stats.generated} embeddings, ${stats.skipped} skipped, ${stats.errors} errors`,
            },
          ],
        };
      }

      case "memory_append": {
        const { content, context } = args as {
          content: string;
          context?: "work" | "life" | "general";
        };
        const entry = createDailyEntry(content, context || "general", "conversation");
        await appendDailyLog(entry);

        // Re-index today's daily file into FTS5 for immediate searchability
        const today = new Date().toISOString().slice(0, 10);
        const dailyPath = `/Users/yj/memory/daily/${today}.md`;
        await indexer.indexFile(dailyPath, context || "general", today);

        return {
          content: [
            {
              type: "text",
              text: `Appended to daily log at ${entry.time}`,
            },
          ],
        };
      }

      case "memory_promote": {
        const { content, file, section } = args as {
          content: string;
          file: "me" | "work" | "life" | "preferences" | "tools";
          section?: string;
        };
        const filePath = `${MEMORY_BASE}/${file}.md`;

        let toAppend = "\n";
        if (section) {
          toAppend += `## ${section}\n`;
        }
        toAppend += `${content}\n`;

        await appendFile(filePath, toAppend, "utf-8");

        // Reindex the updated file
        await indexer.indexFile(filePath, file === "work" ? "work" : file === "life" ? "life" : "general");

        return {
          content: [
            {
              type: "text",
              text: `Promoted to ${file}.md${section ? ` under "${section}"` : ""}`,
            },
          ],
        };
      }

      case "memory_read": {
        const { file, date, source } = args as {
          file: "me" | "work" | "life" | "preferences" | "tools" | "daily";
          date?: string;
          source?: "file" | "archive";
        };

        if (file === "daily" && source === "archive") {
          const dateStr = date ?? new Date().toISOString().slice(0, 10);
          const sm = getSharedStateManager();
          const archive = sm.getDailyLogArchive(dateStr);
          if (!archive) {
            return {
              content: [{ type: "text", text: `No archive found for ${dateStr}` }],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: archive.rawContent,
              },
            ],
          };
        }

        if (file === "daily") {
          const d = date ? new Date(date) : new Date();
          const log = await readDailyLog(d);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(log, null, 2),
              },
            ],
          };
        }

        const filePath = `${MEMORY_BASE}/${file}.md`;
        if (!existsSync(filePath)) {
          return {
            content: [{ type: "text", text: `File not found: ${file}.md` }],
          };
        }

        const content = await readFile(filePath, "utf-8");
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "memory_reindex": {
        const stats = await indexer.indexAllMemoryFiles();
        return {
          content: [
            {
              type: "text",
              text: `Reindexed: ${stats.indexed} files, ${stats.skipped} skipped, ${stats.errors} errors`,
            },
          ],
        };
      }

      case "memory_suggestions": {
        const { date } = args as { date?: string };
        const d = date ? new Date(date) : new Date();
        const log = await readDailyLog(d);

        // Analyze entries for promotion candidates
        const suggestions: Array<{
          content: string;
          suggestedFile: string;
          reason: string;
        }> = [];

        for (const entry of log.entries) {
          const content = entry.content.toLowerCase();

          // Tool configs
          if (content.includes("config") || content.includes("cli") || content.includes("setup")) {
            suggestions.push({
              content: entry.content,
              suggestedFile: "tools",
              reason: "Contains tool/config information",
            });
          }

          // Career/work updates
          if (content.includes("meeting") || content.includes("project") || content.includes("decision")) {
            suggestions.push({
              content: entry.content,
              suggestedFile: "work",
              reason: "Contains work-related decision or update",
            });
          }

          // Preferences
          if (content.includes("prefer") || content.includes("style") || content.includes("always")) {
            suggestions.push({
              content: entry.content,
              suggestedFile: "preferences",
              reason: "Contains preference or style information",
            });
          }
        }

        return {
          content: [
            {
              type: "text",
              text: suggestions.length > 0
                ? JSON.stringify(suggestions, null, 2)
                : "No promotion suggestions for this day",
            },
          ],
        };
      }

      // Idea management tools
      case "idea_add": {
        const { title, content, source, context, link } = args as {
          title: string;
          content: string;
          source: string;
          context?: string;
          link?: string;
        };

        const now = new Date();
        const timestamp = now.toISOString().slice(0, 16).replace("T", " ");
        const timestampId = `idea_${now.toISOString().replace(/[-:T]/g, "").slice(0, 12)}`;

        const idea: ParsedIdea = {
          id: timestampId,
          title,
          content,
          status: "draft",
          source,
          context,
          link,
          tags: [],
          timestamp,
        };

        const sm = getSharedStateManager();
        const saved = ideaDao.createIdea(sm.getDb(), idea);

        return {
          content: [
            {
              type: "text",
              text: `Added idea: ${title} (ID: ${timestampId}, file: ${saved.filePath})`,
            },
          ],
        };
      }

      case "idea_update": {
        const { id, status, notes } = args as {
          id: string;
          status?: string;
          notes?: string;
        };

        const sm = getSharedStateManager();
        const existingIdea = ideaDao.getIdea(sm.getDb(), id);
        if (!existingIdea) {
          return {
            content: [{ type: "text", text: `Idea not found: ${id}` }],
            isError: true,
          };
        }

        const updateFields: Partial<Pick<ParsedIdea, "status" | "notes">> = {};
        if (status) updateFields.status = status;
        if (notes) updateFields.notes = (existingIdea.notes ? existingIdea.notes + "; " : "") + notes;

        ideaDao.updateIdea(sm.getDb(), existingIdea.id, updateFields);

        return {
          content: [
            {
              type: "text",
              text: `Updated idea: ${existingIdea.title} (status: ${status ?? existingIdea.status})`,
            },
          ],
        };
      }

      case "idea_list": {
        const { status } = args as { status?: string };
        const filterStatus = status || "draft";

        const sm = getSharedStateManager();
        const ideas = filterStatus === "all"
          ? ideaDao.getAllIdeas(sm.getDb())
          : ideaDao.getAllIdeas(sm.getDb(), { status: filterStatus });

        if (ideas.length === 0) {
          return {
            content: [{ type: "text", text: `No ideas with status: ${filterStatus}` }],
          };
        }

        const summary = ideas.map(i => ({
          id: i.id,
          title: i.title,
          source: i.source,
          status: i.status,
          timestamp: i.timestamp,
          filePath: i.filePath,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(summary, null, 2),
            },
          ],
        };
      }

      case "plan_create": {
        const { title, description, phases, status, ideaId } = args as {
          title: string;
          description: string;
          phases?: Array<{ name: string; tasks: string[] }>;
          status?: string;
          ideaId?: string;
        };

        // Create slug from title
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const planPath = `${PLANS_DIR}/${slug}.md`;

        // Ensure plans directory exists
        if (!existsSync(PLANS_DIR)) {
          await mkdir(PLANS_DIR, { recursive: true });
        }

        // Build phases array for savePlanFile
        const parsedPhases: ParsedPhase[] = phases
          ? phases.map((p) => ({
              name: p.name,
              status: "pending" as const,
              tasks: p.tasks.map((t) => ({ text: t, completed: false })),
            }))
          : [];

        const currentPhase = parsedPhases.length > 0 ? parsedPhases[0]!.name : null;

        savePlanFile({
          filePath: planPath,
          title,
          description: description || null,
          status: status || "planning",
          currentPhase,
          phases: parsedPhases,
          sourceIdeaId: ideaId || null,
        });

        return {
          content: [
            {
              type: "text",
              text: `Created plan: ${title} (${planPath})`,
            },
          ],
        };
      }

      case "plan_update": {
        const { slug, status, currentPhase, notes } = args as {
          slug: string;
          status?: "planning" | "execution" | "completed";
          currentPhase?: string;
          notes?: string;
        };

        const planPath = `${PLANS_DIR}/${slug}.md`;
        const parsed = parsePlanFile(planPath);
        if (!parsed) {
          return {
            content: [{ type: "text", text: `Plan not found: ${slug}` }],
            isError: true,
          };
        }

        // Add note through structured data
        const updatedNotes = [...parsed.notes];
        if (notes) {
          const now = new Date().toISOString().slice(0, 10);
          updatedNotes.push({ date: now, content: notes });
        }

        savePlanFile({
          filePath: planPath,
          title: parsed.title,
          description: parsed.description,
          status: status || parsed.status,
          currentPhase: currentPhase || parsed.currentPhase,
          phases: parsed.phases,
          notes: updatedNotes,
          sourceIdeaId: parsed.sourceIdeaId,
          tags: parsed.tags,
          createdAt: parsed.createdAt,
        });

        return {
          content: [
            {
              type: "text",
              text: `Updated plan: ${slug}`,
            },
          ],
        };
      }

      case "plan_list": {
        const plans = loadPlansFromDir();
        const summary = plans.map((p) => ({
          id: p.id,
          title: p.title,
          status: p.status,
          currentPhase: p.currentPhase || "Unknown",
          progress: `${p.completedTasks}/${p.totalTasks}`,
          createdAt: p.createdAt || "Unknown",
          updatedAt: p.updatedAt || "Unknown",
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(summary, null, 2),
            },
          ],
        };
      }

      case "plan_archive": {
        const { slug } = args as { slug: string };
        const planPath = `${PLANS_DIR}/${slug}.md`;
        const archiveDir = `${PLANS_DIR}/archive`;
        const archivePath = `${archiveDir}/${slug}.md`;

        const parsed = parsePlanFile(planPath);
        if (!parsed) {
          return {
            content: [{ type: "text", text: `Plan not found: ${slug}` }],
            isError: true,
          };
        }

        const now = new Date().toISOString().slice(0, 10);
        const archiveNotes = [...parsed.notes, { date: now, content: "Archived. Plan completed and moved to archive." }];

        savePlanFile({
          filePath: planPath,
          title: parsed.title,
          description: parsed.description,
          status: "completed",
          currentPhase: parsed.currentPhase,
          phases: parsed.phases,
          notes: archiveNotes,
          sourceIdeaId: parsed.sourceIdeaId,
          tags: parsed.tags,
          createdAt: parsed.createdAt,
        });

        // Ensure archive directory exists and move
        await mkdir(archiveDir, { recursive: true });
        await rename(planPath, archivePath);

        return {
          content: [
            {
              type: "text",
              text: `Archived plan: ${slug} → plans/archive/${slug}.md`,
            },
          ],
        };
      }

      case "plan_add_task": {
        const { slug, task, phase: phaseName } = args as {
          slug: string;
          task: string;
          phase?: string;
        };

        const planPath = `${PLANS_DIR}/${slug}.md`;
        if (!existsSync(planPath)) {
          return {
            content: [{ type: "text", text: `Plan not found: ${slug}` }],
            isError: true,
          };
        }

        const parsed = parsePlanFile(planPath);
        if (!parsed) {
          return {
            content: [{ type: "text", text: `Failed to parse plan: ${slug}` }],
            isError: true,
          };
        }

        // Find the target phase or create it
        let targetPhase: ParsedPhase | undefined;
        if (phaseName) {
          targetPhase = parsed.phases.find(
            (p) => p.name.toLowerCase() === phaseName.toLowerCase()
          );
          if (!targetPhase) {
            // Create new phase
            targetPhase = { name: phaseName, status: "pending", tasks: [] };
            parsed.phases.push(targetPhase);
          }
        } else {
          // Use first phase, or create one
          targetPhase = parsed.phases[0];
          if (!targetPhase) {
            targetPhase = { name: "Tasks", status: "pending", tasks: [] };
            parsed.phases.push(targetPhase);
          }
        }

        targetPhase.tasks.push({ text: task, completed: false });

        savePlanFile({
          filePath: planPath,
          title: parsed.title,
          description: parsed.description,
          status: parsed.status,
          currentPhase: parsed.currentPhase,
          phases: parsed.phases,
          sourceIdeaId: parsed.sourceIdeaId,
          tags: parsed.tags,
          createdAt: parsed.createdAt,
        });

        return {
          content: [
            {
              type: "text",
              text: `Added task to ${slug} (phase: ${targetPhase.name}): ${task}`,
            },
          ],
        };
      }

      case "feedback_log": {
        const { action, target, notes } = args as {
          action: "approve" | "reject" | "explore" | "comment";
          target: string;
          notes?: string;
        };

        const now = new Date();
        const timestamp = now.toISOString().slice(0, 16).replace("T", " ");

        let entry = `\n### [${timestamp}] ${action.charAt(0).toUpperCase() + action.slice(1)} - ${target}\n`;
        entry += `Decision: ${action}\n`;
        if (notes) entry += `Notes: ${notes}\n`;

        await appendFile(FEEDBACK_FILE, entry, "utf-8");

        return {
          content: [
            {
              type: "text",
              text: `Logged feedback: ${action} on "${target}"`,
            },
          ],
        };
      }

      // Azure Blob Storage tools
      case "blob_upload": {
        const { localFilePath, blobName } = args as {
          localFilePath: string;
          blobName?: string;
        };

        try {
          const blob = await getAzureBlob();
          const result = await blob.uploadBlob(localFilePath, blobName);
          return {
            content: [
              {
                type: "text",
                text: `Uploaded to blob storage: ${result.blobName}\nURL: ${result.url}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to upload: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      }

      case "blob_upload_content": {
        const { content, blobName, contentType } = args as {
          content: string;
          blobName: string;
          contentType?: string;
        };

        try {
          const blob = await getAzureBlob();
          const result = await blob.uploadBlobContent(content, blobName, contentType);
          return {
            content: [
              {
                type: "text",
                text: `Uploaded content to blob storage: ${result.blobName}\nURL: ${result.url}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to upload content: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      }

      case "blob_download": {
        const { blobName, localFilePath } = args as {
          blobName: string;
          localFilePath: string;
        };

        try {
          const blob = await getAzureBlob();
          const path = await blob.downloadBlob(blobName, localFilePath);
          return {
            content: [
              {
                type: "text",
                text: `Downloaded blob to: ${path}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to download: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      }

      case "blob_get_content": {
        const { blobName } = args as { blobName: string };

        try {
          const blob = await getAzureBlob();
          const content = await blob.downloadBlobContent(blobName, true);
          return {
            content: [
              {
                type: "text",
                text: String(content),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to get content: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      }

      case "blob_list": {
        const { prefix } = args as { prefix?: string };

        try {
          const blob = await getAzureBlob();
          const blobs = await blob.listBlobs(prefix);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(blobs, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to list blobs: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      }

      case "blob_delete": {
        const { blobName, confirm } = args as {
          blobName: string;
          confirm: boolean;
        };

        if (!confirm) {
          return {
            content: [
              {
                type: "text",
                text: "Deletion not confirmed. Set confirm=true to proceed.",
              },
            ],
            isError: true,
          };
        }

        try {
          const blob = await getAzureBlob();
          await blob.deleteBlob(blobName);
          return {
            content: [
              {
                type: "text",
                text: `Deleted blob: ${blobName}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to delete: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      }

      case "blob_exists": {
        const { blobName } = args as { blobName: string };

        try {
          const blob = await getAzureBlob();
          const exists = await blob.blobExists(blobName);
          return {
            content: [
              {
                type: "text",
                text: exists ? `Blob exists: ${blobName}` : `Blob does not exist: ${blobName}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to check existence: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      }

      case "blob_properties": {
        const { blobName } = args as { blobName: string };

        try {
          const blob = await getAzureBlob();
          const props = await blob.getBlobProperties(blobName);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(props, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to get properties: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      }

      // === Context & Intelligence tools ===
      case "memory_context": {
        const { days } = args as { days?: number };
        const lookbackDays = days || 7;
        const sections: string[] = [];

        const sm = getSharedStateManager();

        // 1. Recent sessions (non-sub-agent)
        const sessions = sm.getDb().prepare(`
          SELECT title, project, agent, started_at, message_count
          FROM session_summaries
          WHERE is_sub_agent = 0
            AND started_at > datetime('now', ?)
          ORDER BY started_at DESC LIMIT 5
        `).all(`-${lookbackDays} days`) as Array<{
          title: string; project: string; agent: string;
          started_at: string; message_count: number;
        }>;

        if (sessions.length > 0) {
          sections.push("## Recent Sessions");
          for (const s of sessions) {
            const date = s.started_at.slice(5, 10); // MM-DD
            const proj = s.project || "unknown";
            const title = (s.title || "untitled").slice(0, 60);
            sections.push(`- [${date}] ${proj}: ${title} (${s.message_count} msgs)`);
          }
        }

        // 1b. Recent Telegram/Web conversations
        try {
          const recentThreads = sm.getDb().prepare(`
            SELECT t.id, t.title, t.chat_session_id, t.provider, t.last_message_at,
                   (SELECT COUNT(*) FROM thread_messages WHERE thread_id = t.id) as msg_count
            FROM threads t
            WHERE t.last_message_at > datetime('now', ?)
              AND t.status = 'active'
            ORDER BY t.last_message_at DESC LIMIT 5
          `).all(`-${lookbackDays} days`) as Array<{
            id: string; title: string; chat_session_id: string;
            provider: string; last_message_at: string; msg_count: number;
          }>;

          if (recentThreads.length > 0) {
            sections.push("\n## Recent Conversations");
            for (const t of recentThreads) {
              const label = t.chat_session_id === "tg:system" ? "TG" : "Web";
              const date = t.last_message_at.slice(5, 10);
              const title = (t.title || "untitled").slice(0, 60);
              sections.push(`- [${label}] [${date}] ${title} (${t.msg_count} msgs)`);
            }
          }
        } catch {
          // threads table may not exist
        }

        // 2. Active plans
        const plans = loadPlansFromDir();
        const activePlans = plans.filter(p =>
          p.status === "execution" || p.status === "planning"
        );
        if (activePlans.length > 0) {
          sections.push("\n## Active Plans");
          for (const p of activePlans) {
            sections.push(`- ${p.title} (${p.status}, ${p.completedTasks}/${p.totalTasks} tasks)${p.currentPhase ? ` — phase: ${p.currentPhase}` : ""}`);
          }
        }

        // 3. Pending decisions (ideas in review)
        const reviewIdeas = ideaDao.getAllIdeas(sm.getDb(), { status: "review", limit: 5 });
        if (reviewIdeas.length > 0) {
          sections.push("\n## Pending Decisions");
          for (const idea of reviewIdeas) {
            sections.push(`- Idea: "${idea.title}" (in review)`);
          }
        }

        // 4. Project momentum
        const momentum = sm.getDb().prepare(`
          SELECT project, COUNT(*) as count
          FROM session_summaries
          WHERE is_sub_agent = 0
            AND started_at > datetime('now', ?)
            AND project IS NOT NULL AND project != ''
          GROUP BY project
          ORDER BY count DESC LIMIT 8
        `).all(`-${lookbackDays} days`) as Array<{ project: string; count: number }>;

        if (momentum.length > 0) {
          sections.push("\n## Project Momentum (" + lookbackDays + " days)");
          for (const m of momentum) {
            const heat = m.count >= 6 ? "hot" : m.count >= 3 ? "active" : "light";
            sections.push(`- ${m.project}: ${m.count} sessions (${heat})`);
          }
        }

        // 5. Recent Homer activity (last 24h successful jobs)
        const recentJobs = sm.getDb().prepare(`
          SELECT job_name, output, completed_at
          FROM scheduled_job_runs
          WHERE success = 1
            AND completed_at > datetime('now', '-24 hours')
            AND output IS NOT NULL AND output != ''
          ORDER BY completed_at DESC LIMIT 5
        `).all() as Array<{ job_name: string; output: string; completed_at: string }>;

        if (recentJobs.length > 0) {
          sections.push("\n## Recent Homer Activity");
          for (const j of recentJobs) {
            sections.push(`- ${j.job_name}: ${j.output.slice(0, 100)}`);
          }
        }

        // 6. Pending outcome checks (if table exists)
        try {
          const pendingOutcomes = sm.getDb().prepare(`
            SELECT source_type, source_title, check_at
            FROM outcome_checks
            WHERE status = 'pending' AND check_at <= datetime('now', '+3 days')
            ORDER BY check_at ASC LIMIT 3
          `).all() as Array<{ source_type: string; source_title: string; check_at: string }>;

          if (pendingOutcomes.length > 0) {
            sections.push("\n## Upcoming Outcome Checks");
            for (const o of pendingOutcomes) {
              sections.push(`- [${o.source_type}] ${o.source_title} (due: ${o.check_at.slice(0, 10)})`);
            }
          }
        } catch {
          // outcome_checks table may not exist yet
        }

        const output = sections.length > 0
          ? sections.join("\n")
          : "No recent activity found.";

        return {
          content: [{ type: "text", text: output }],
        };
      }

      case "outcome_check": {
        const { source_type, source_id, source_title, check_days } = args as {
          source_type: string;
          source_id: string;
          source_title: string;
          check_days?: number;
        };

        const daysOut = check_days || 14;
        const id = `oc_${Date.now()}`;
        const sm = getSharedStateManager();
        sm.getDb().prepare(`
          INSERT INTO outcome_checks (id, source_type, source_id, source_title, check_at)
          VALUES (?, ?, ?, ?, datetime('now', ?))
        `).run(id, source_type, source_id, source_title, `+${daysOut} days`);

        return {
          content: [{
            type: "text",
            text: `Created outcome check: ${source_title} (${source_type}), due in ${daysOut} days (ID: ${id})`,
          }],
        };
      }

      case "preference_query": {
        const { dimension, limit } = args as {
          dimension?: string;
          limit?: number;
        };

        const maxResults = limit || 20;
        try {
          const sm = getSharedStateManager();
          let rows: Array<{ dimension: string; score: number; evidence_count: number; last_updated: string }>;
          if (dimension) {
            rows = sm.getDb().prepare(`
              SELECT dimension, score, evidence_count, last_updated
              FROM preference_model
              WHERE dimension LIKE ?
              ORDER BY score DESC LIMIT ?
            `).all(`${dimension}%`, maxResults) as typeof rows;
          } else {
            rows = sm.getDb().prepare(`
              SELECT dimension, score, evidence_count, last_updated
              FROM preference_model
              ORDER BY ABS(score - 0.5) DESC LIMIT ?
            `).all(maxResults) as typeof rows;
          }

          if (rows.length === 0) {
            return {
              content: [{ type: "text", text: "No preferences found." + (dimension ? ` Filter: ${dimension}` : "") }],
            };
          }

          const lines = rows.map(r => {
            const bar = r.score > 0.6 ? "+" : r.score < 0.4 ? "-" : "~";
            return `${bar} ${r.dimension}: ${r.score.toFixed(2)} (${r.evidence_count} signals, updated ${r.last_updated.slice(0, 10)})`;
          });

          return {
            content: [{ type: "text", text: `## Preferences${dimension ? ` (${dimension}*)` : ""}\n\n${lines.join("\n")}` }],
          };
        } catch (err) {
          // Table may not exist yet
          return {
            content: [{ type: "text", text: `Preference model not initialized yet. Run migration 030 first.` }],
          };
        }
      }

      // Meeting tools
      case "meeting_list": {
        const { status, limit, attendee } = args as {
          status?: string;
          limit?: number;
          attendee?: string;
        };

        try {
          const { listMeetingFiles, readMeetingFile } = await import("../meetings/storage.js");
          const files = await listMeetingFiles();
          const maxResults = limit || 20;

          const meetings = [];
          for (const meetingId of files.slice(0, maxResults * 2)) {
            const content = await readMeetingFile(meetingId);
            if (!content) continue;

            // Filter by status (if specified and not 'all')
            if (status && status !== "all") {
              // We don't have status in file, skip status filter for now
            }

            // Filter by attendee
            if (attendee) {
              const hasAttendee = content.frontmatter.attendees.some(
                (a: string) => a.toLowerCase().includes(attendee.toLowerCase())
              );
              if (!hasAttendee) continue;
            }

            meetings.push({
              id: content.frontmatter.id,
              title: content.frontmatter.title,
              date: content.frontmatter.date,
              duration: content.frontmatter.duration,
              attendees: content.frontmatter.attendees,
              confidence: content.frontmatter.confidence,
            });

            if (meetings.length >= maxResults) break;
          }

          return {
            content: [
              {
                type: "text",
                text: meetings.length > 0
                  ? JSON.stringify(meetings, null, 2)
                  : "No meetings found",
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to list meetings: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      }

      case "meeting_search": {
        const { query, limit } = args as {
          query: string;
          limit?: number;
        };

        try {
          const { listMeetingFiles, readMeetingFile } = await import("../meetings/storage.js");
          const files = await listMeetingFiles();
          const maxResults = limit || 10;
          const queryLower = query.toLowerCase();

          const results = [];

          for (const meetingId of files) {
            const content = await readMeetingFile(meetingId);
            if (!content) continue;

            // Search in title
            if (content.frontmatter.title.toLowerCase().includes(queryLower)) {
              results.push({
                meetingId,
                title: content.frontmatter.title,
                date: content.frontmatter.date,
                match: "title",
                snippet: content.frontmatter.title,
              });
              continue;
            }

            // Search in transcript
            for (const segment of content.transcript) {
              if (segment.text.toLowerCase().includes(queryLower)) {
                results.push({
                  meetingId,
                  title: content.frontmatter.title,
                  date: content.frontmatter.date,
                  speaker: segment.speaker,
                  timestamp: segment.timestamp,
                  match: "transcript",
                  snippet: segment.text.slice(0, 200),
                });
                break; // Only one result per meeting
              }
            }

            // Search in summary
            if (content.summary?.toLowerCase().includes(queryLower)) {
              results.push({
                meetingId,
                title: content.frontmatter.title,
                date: content.frontmatter.date,
                match: "summary",
                snippet: content.summary.slice(0, 200),
              });
            }

            if (results.length >= maxResults) break;
          }

          return {
            content: [
              {
                type: "text",
                text: results.length > 0
                  ? JSON.stringify(results, null, 2)
                  : `No meetings found matching: ${query}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      }

      case "meeting_get": {
        const { id } = args as { id: string };

        try {
          const { readMeetingFile } = await import("../meetings/storage.js");
          const content = await readMeetingFile(id);

          if (!content) {
            return {
              content: [{ type: "text", text: `Meeting not found: ${id}` }],
              isError: true,
            };
          }

          // Format transcript for readability
          let transcriptText = "";
          for (const segment of content.transcript.slice(0, 50)) {
            transcriptText += `[${segment.timestamp}] ${segment.speaker}: ${segment.text}\n\n`;
          }
          if (content.transcript.length > 50) {
            transcriptText += `... (${content.transcript.length - 50} more segments)\n`;
          }

          const output = {
            id: content.frontmatter.id,
            title: content.frontmatter.title,
            date: content.frontmatter.date,
            duration: content.frontmatter.duration,
            attendees: content.frontmatter.attendees,
            speakerMappings: content.frontmatter.speaker_mappings,
            confidence: content.frontmatter.confidence,
            summary: content.summary,
            actionItems: content.actionItems,
            keyTopics: content.keyTopics,
            transcriptPreview: transcriptText,
          };

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(output, null, 2),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to get meeting: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

/**
 * Start the server
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Homer Memory MCP server running on stdio");
}

main().catch(console.error);
