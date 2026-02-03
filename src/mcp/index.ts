#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getMemoryIndexer } from "../memory/indexer.js";
import { appendDailyLog, createDailyEntry, readDailyLog } from "../memory/daily.js";
import { appendFile, readFile, writeFile, mkdir, readdir } from "fs/promises";
import { existsSync } from "fs";
import {
  parseIdeaFile,
  saveIdeaFile,
  loadIdeasFromDir,
  isIdeasMigrated,
  type ParsedIdea,
} from "../ideas/parser.js";
import { join } from "path";
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
const IDEAS_FILE = `${MEMORY_BASE}/ideas.md`;
const PLANS_FILE = `${MEMORY_BASE}/plans.md`;
const PLANS_DIR = `${MEMORY_BASE}/plans`;
const FEEDBACK_FILE = `${MEMORY_BASE}/feedback.md`;

// Idea status values
type IdeaStatus = "draft" | "review" | "planning" | "execution" | "archived";

interface Idea {
  id: string;
  timestamp: string;
  source: string;
  status: IdeaStatus;
  title: string;
  content: string;
  context?: string;
  link?: string;
  notes?: string;
}

interface Plan {
  id: string;
  title: string;
  status: "planning" | "execution" | "completed";
  currentPhase: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Parse ideas.md file into structured data
 */
function parseIdeasFile(content: string): Idea[] {
  const ideas: Idea[] = [];
  const lines = content.split("\n");
  let currentIdea: Partial<Idea> | null = null;
  let currentSection = "";

  for (const line of lines) {
    // Detect section headers
    if (line.startsWith("## Draft Ideas")) {
      currentSection = "draft";
      continue;
    }
    if (line.startsWith("## Under Review")) {
      currentSection = "review";
      continue;
    }
    if (line.startsWith("## Archived")) {
      currentSection = "archived";
      continue;
    }

    // Parse idea header: ### [2026-01-29 14:30] Title
    const headerMatch = line.match(/^### \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] (.+)$/);
    if (headerMatch) {
      if (currentIdea && currentIdea.id) {
        ideas.push(currentIdea as Idea);
      }
      // Generate deterministic ID from timestamp (will be overwritten if ID field found)
      const timestampId = (headerMatch[1] ?? "").replace(/[- :]/g, "").slice(-8);
      currentIdea = {
        id: timestampId,
        timestamp: headerMatch[1] ?? "",
        title: headerMatch[2] ?? "",
        status: currentSection as IdeaStatus || "draft",
        source: "unknown",
        content: "",
      };
      continue;
    }

    // Parse idea fields
    if (currentIdea) {
      const idMatch = line.match(/^- \*\*ID:\*\* (.+)$/);
      if (idMatch) {
        currentIdea.id = idMatch[1];
        continue;
      }

      const sourceMatch = line.match(/^- \*\*Source:\*\* (.+)$/);
      if (sourceMatch) {
        currentIdea.source = sourceMatch[1];
        continue;
      }

      const statusMatch = line.match(/^- \*\*Status:\*\* (.+)$/);
      if (statusMatch) {
        currentIdea.status = statusMatch[1] as IdeaStatus;
        continue;
      }

      const contentMatch = line.match(/^- \*\*Content:\*\* (.+)$/);
      if (contentMatch) {
        currentIdea.content = contentMatch[1];
        continue;
      }

      const contextMatch = line.match(/^- \*\*Context:\*\* (.+)$/);
      if (contextMatch) {
        currentIdea.context = contextMatch[1];
        continue;
      }

      const linkMatch = line.match(/^- \*\*Link:\*\* (.+)$/);
      if (linkMatch) {
        currentIdea.link = linkMatch[1];
        continue;
      }

      const notesMatch = line.match(/^- \*\*Notes:\*\* (.+)$/);
      if (notesMatch) {
        currentIdea.notes = notesMatch[1];
        continue;
      }
    }
  }

  // Don't forget the last idea
  if (currentIdea && currentIdea.id) {
    ideas.push(currentIdea as Idea);
  }

  return ideas;
}

/**
 * Format an idea for ideas.md
 */
function formatIdea(idea: Idea): string {
  let output = `### [${idea.timestamp}] ${idea.title}\n`;
  output += `- **ID:** ${idea.id}\n`;
  output += `- **Source:** ${idea.source}\n`;
  output += `- **Status:** ${idea.status}\n`;
  output += `- **Content:** ${idea.content}\n`;
  if (idea.context) output += `- **Context:** ${idea.context}\n`;
  if (idea.link) output += `- **Link:** ${idea.link}\n`;
  if (idea.notes) output += `- **Notes:** ${idea.notes}\n`;
  return output;
}

/**
 * Rebuild ideas.md from parsed ideas
 */
function rebuildIdeasFile(ideas: Idea[]): string {
  const draft = ideas.filter(i => i.status === "draft");
  const review = ideas.filter(i => i.status === "review");
  const archived = ideas.filter(i => i.status === "archived" || i.status === "planning" || i.status === "execution");

  let output = "# Ideas\n\nRaw ideas collected by HOMER. Reviewed daily at 7 AM.\n\n";
  output += "## Draft Ideas\n\n";
  for (const idea of draft) {
    output += formatIdea(idea) + "\n";
  }
  output += "## Under Review\n\n";
  for (const idea of review) {
    output += formatIdea(idea) + "\n";
  }
  output += "## Archived\n\n";
  for (const idea of archived) {
    output += formatIdea(idea) + "\n";
  }
  return output;
}

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
        description: "Read a memory file or today's daily log.",
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
        description: "Create a new plan file from an approved idea.",
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
              items: { type: "string" },
              description: "List of phase names",
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
        const results = indexer.search(query, limit || 10, context);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(results, null, 2),
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
        const { file, date } = args as {
          file: "me" | "work" | "life" | "preferences" | "tools" | "daily";
          date?: string;
        };

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
        // Use timestamp-based ID for consistency
        const timestampId = `idea_${now.toISOString().replace(/[-:T]/g, "").slice(0, 12)}`;

        // Check if migrated to new format (individual files)
        if (isIdeasMigrated()) {
          // Use new format - create individual file
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

          const filePath = saveIdeaFile(idea);

          return {
            content: [
              {
                type: "text",
                text: `Added idea: ${title} (ID: ${timestampId}, file: ${filePath})`,
              },
            ],
          };
        }

        // Legacy format - append to ideas.md
        const idea: Idea = {
          id: timestampId,
          timestamp,
          title,
          content,
          source,
          status: "draft",
          context,
          link,
        };

        // Read current ideas file
        let ideasContent = "";
        if (existsSync(IDEAS_FILE)) {
          ideasContent = await readFile(IDEAS_FILE, "utf-8");
        }

        // Find the "## Draft Ideas" section and insert after it
        const insertPoint = ideasContent.indexOf("## Draft Ideas");
        if (insertPoint !== -1) {
          const afterHeader = ideasContent.indexOf("\n", insertPoint) + 1;
          // Skip any blank lines after header
          let insertIdx = afterHeader;
          while (ideasContent[insertIdx] === "\n") insertIdx++;

          const newIdea = "\n" + formatIdea(idea) + "\n";
          ideasContent = ideasContent.slice(0, insertIdx) + newIdea + ideasContent.slice(insertIdx);
        } else {
          // Fallback: append to file
          ideasContent += "\n" + formatIdea(idea);
        }

        await writeFile(IDEAS_FILE, ideasContent, "utf-8");

        return {
          content: [
            {
              type: "text",
              text: `Added idea: ${title} (ID: ${idea.id})`,
            },
          ],
        };
      }

      case "idea_update": {
        const { id, status, notes } = args as {
          id: string;
          status?: IdeaStatus;
          notes?: string;
        };

        // Check if migrated to new format
        if (isIdeasMigrated()) {
          // Find idea file in directory
          const IDEAS_DIR = join(MEMORY_BASE, "ideas");
          const files = await readdir(IDEAS_DIR);
          let ideaFile: string | null = null;

          for (const file of files) {
            if (!file.endsWith(".md")) continue;
            const filePath = join(IDEAS_DIR, file);
            const parsed = parseIdeaFile(filePath);
            if (parsed && (parsed.id === id || parsed.id.includes(id) || file.includes(id))) {
              ideaFile = filePath;
              break;
            }
          }

          if (!ideaFile) {
            return {
              content: [{ type: "text", text: `Idea not found: ${id}` }],
              isError: true,
            };
          }

          const idea = parseIdeaFile(ideaFile);
          if (!idea) {
            return {
              content: [{ type: "text", text: `Could not parse idea file: ${ideaFile}` }],
              isError: true,
            };
          }

          if (status) idea.status = status;
          if (notes) idea.notes = (idea.notes ? idea.notes + "; " : "") + notes;

          saveIdeaFile(idea);

          return {
            content: [
              {
                type: "text",
                text: `Updated idea: ${idea.title} (status: ${idea.status})`,
              },
            ],
          };
        }

        // Legacy format
        if (!existsSync(IDEAS_FILE)) {
          return {
            content: [{ type: "text", text: "ideas.md not found" }],
            isError: true,
          };
        }

        const ideasContent = await readFile(IDEAS_FILE, "utf-8");
        const ideas = parseIdeasFile(ideasContent);

        // Find idea by ID (partial match on timestamp or id field)
        const idea = ideas.find(i =>
          i.id.startsWith(id) || i.timestamp.includes(id)
        );

        if (!idea) {
          return {
            content: [{ type: "text", text: `Idea not found: ${id}` }],
            isError: true,
          };
        }

        if (status) idea.status = status;
        if (notes) idea.notes = (idea.notes ? idea.notes + "; " : "") + notes;

        const newContent = rebuildIdeasFile(ideas);
        await writeFile(IDEAS_FILE, newContent, "utf-8");

        return {
          content: [
            {
              type: "text",
              text: `Updated idea: ${idea.title} (status: ${idea.status})`,
            },
          ],
        };
      }

      case "idea_list": {
        const { status } = args as { status?: string };
        const filterStatus = status || "draft";

        // Check if migrated to new format
        if (isIdeasMigrated()) {
          const ideas = loadIdeasFromDir();

          const filtered = filterStatus === "all"
            ? ideas
            : ideas.filter(i => i.status === filterStatus);

          if (filtered.length === 0) {
            return {
              content: [{ type: "text", text: `No ideas with status: ${filterStatus}` }],
            };
          }

          const summary = filtered.map(i => ({
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

        // Legacy format
        if (!existsSync(IDEAS_FILE)) {
          return {
            content: [{ type: "text", text: "No ideas file found" }],
          };
        }

        const ideasContent = await readFile(IDEAS_FILE, "utf-8");
        const ideas = parseIdeasFile(ideasContent);

        const filtered = filterStatus === "all"
          ? ideas
          : ideas.filter(i => i.status === filterStatus);

        if (filtered.length === 0) {
          return {
            content: [{ type: "text", text: `No ideas with status: ${filterStatus}` }],
          };
        }

        const summary = filtered.map(i => ({
          id: i.id,
          title: i.title,
          source: i.source,
          status: i.status,
          timestamp: i.timestamp,
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
        const { title, description, phases, ideaId } = args as {
          title: string;
          description: string;
          phases?: string[];
          ideaId?: string;
        };

        // Create slug from title
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const planPath = `${PLANS_DIR}/${slug}.md`;
        const now = new Date().toISOString().slice(0, 10);

        // Ensure plans directory exists
        if (!existsSync(PLANS_DIR)) {
          await mkdir(PLANS_DIR, { recursive: true });
        }

        // Create plan file content
        let planContent = `# ${title}\n\n`;
        planContent += `**Created:** ${now}\n`;
        planContent += `**Status:** planning\n`;
        planContent += `**Current Phase:** ${phases?.[0] || "Phase 1"}\n\n`;
        planContent += `## Description\n\n${description}\n\n`;
        planContent += `## Phases\n\n`;

        if (phases && phases.length > 0) {
          for (let i = 0; i < phases.length; i++) {
            planContent += `### ${phases[i]}\n`;
            planContent += `- **Status:** ${i === 0 ? "in_progress" : "pending"}\n`;
            planContent += `- **Description:** TBD\n\n`;
          }
        } else {
          planContent += `### Phase 1\n- **Status:** in_progress\n- **Description:** TBD\n\n`;
        }

        planContent += `## Feedback Log\n\n`;
        planContent += `- **${now}:** Plan created\n`;

        await writeFile(planPath, planContent, "utf-8");

        // Update plans.md index
        if (existsSync(PLANS_FILE)) {
          let plansIndex = await readFile(PLANS_FILE, "utf-8");
          const tableMarker = "<!-- Active plans listed here -->";
          if (plansIndex.includes(tableMarker)) {
            const newRow = `| [${title}](plans/${slug}.md) | planning | ${phases?.[0] || "Phase 1"} | ${now} |\n`;
            plansIndex = plansIndex.replace(tableMarker, newRow + tableMarker);
            await writeFile(PLANS_FILE, plansIndex, "utf-8");
          }
        }

        // If ideaId provided, update the idea status
        if (ideaId && existsSync(IDEAS_FILE)) {
          const ideasContent = await readFile(IDEAS_FILE, "utf-8");
          const ideas = parseIdeasFile(ideasContent);
          const idea = ideas.find(i => i.id.startsWith(ideaId) || i.timestamp.includes(ideaId));
          if (idea) {
            idea.status = "planning";
            idea.notes = (idea.notes ? idea.notes + "; " : "") + `Plan created: ${slug}`;
            await writeFile(IDEAS_FILE, rebuildIdeasFile(ideas), "utf-8");
          }
        }

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
        if (!existsSync(planPath)) {
          return {
            content: [{ type: "text", text: `Plan not found: ${slug}` }],
            isError: true,
          };
        }

        let planContent = await readFile(planPath, "utf-8");
        const now = new Date().toISOString().slice(0, 10);

        if (status) {
          planContent = planContent.replace(/\*\*Status:\*\* \w+/, `**Status:** ${status}`);
        }
        if (currentPhase) {
          planContent = planContent.replace(/\*\*Current Phase:\*\* .+/, `**Current Phase:** ${currentPhase}`);
        }

        // Append to feedback log in the plan
        if (notes) {
          const feedbackSection = planContent.indexOf("## Feedback Log");
          if (feedbackSection !== -1) {
            const insertPoint = planContent.indexOf("\n", feedbackSection) + 1;
            const newNote = `\n- **${now}:** ${notes}\n`;
            planContent = planContent.slice(0, insertPoint) + newNote + planContent.slice(insertPoint);
          }
        }

        await writeFile(planPath, planContent, "utf-8");

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
        if (!existsSync(PLANS_DIR)) {
          return {
            content: [{ type: "text", text: "No plans directory found" }],
          };
        }

        const { readdir } = await import("fs/promises");
        const files = await readdir(PLANS_DIR);
        const plans: Plan[] = [];

        for (const file of files) {
          if (!file.endsWith(".md")) continue;
          const content = await readFile(`${PLANS_DIR}/${file}`, "utf-8");

          const titleMatch = content.match(/^# (.+)$/m);
          const statusMatch = content.match(/\*\*Status:\*\* (\w+)/);
          const phaseMatch = content.match(/\*\*Current Phase:\*\* (.+)/);
          const createdMatch = content.match(/\*\*Created:\*\* (\d{4}-\d{2}-\d{2})/);

          plans.push({
            id: file.replace(".md", ""),
            title: titleMatch?.[1] || file,
            status: (statusMatch?.[1] || "planning") as Plan["status"],
            currentPhase: phaseMatch?.[1] || "Unknown",
            createdAt: createdMatch?.[1] || "Unknown",
            updatedAt: createdMatch?.[1] || "Unknown",
          });
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(plans, null, 2),
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
