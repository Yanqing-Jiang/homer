#!/usr/bin/env node
/**
 * Homer Memory MCP Server
 *
 * Delegates to domain-specific tool modules in ./tools/
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getMemoryIndexer } from "../memory/indexer.js";
import { StateManager } from "../state/manager.js";
import { PATHS } from "../config/paths.js";
import type { ToolDeps } from "./tools/types.js";
import { getCanonicalMemoryService } from "../memory/canonical-service.js";
import { runMigrations } from "../state/migrations/index.js";

// Tool modules
import * as memoryTools from "./tools/memory.js";
import * as ideaTools from "./tools/ideas.js";
import * as todoTools from "./tools/todos.js";
import * as blobTools from "./tools/blob.js";
import * as sessionTools from "./tools/sessions.js";
import * as meetingTools from "./tools/meetings.js";
import * as callTools from "./tools/calls.js";

// Shared StateManager singleton — better-sqlite3 is synchronous, MCP is single-threaded
let sharedSM: StateManager | null = null;
function getSharedStateManager(): StateManager {
  if (!sharedSM) {
    sharedSM = new StateManager(PATHS.db);
    runMigrations(sharedSM.getDb());
  }
  return sharedSM;
}

// Lazy-load azure-blob to avoid startup failure if @azure/storage-blob is not installed
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

// Initialize state before the indexer so a fresh install creates the DB parent
// directory and schema before any MCP tool is advertised.
const stateManager = getSharedStateManager();
const indexer = getMemoryIndexer(PATHS.db);

// Canonical memory service
const canonicalMemory = getCanonicalMemoryService(stateManager, indexer);

// Shared dependencies for all tool modules
const deps: ToolDeps = { getSharedStateManager, indexer, getAzureBlob, canonicalMemory };

// All tool modules in dispatch order
const toolModules = [memoryTools, ideaTools, todoTools, blobTools, sessionTools, meetingTools, callTools];

const server = new Server(
  { name: "homer-memory", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

/**
 * List available tools — aggregated from all modules
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: toolModules.flatMap(m => m.definitions),
  };
});

// ── Result size budgeting ──────────────────────────────────
// Prevents large MCP responses from blowing up the context window.
// When a response exceeds the threshold, it's truncated with a note.
const RESULT_SIZE_BUDGET = {
  maxCharsPerResult: 100_000,  // Per-result threshold
  previewSize: 1_500,          // Inline preview when truncated
  // Tools that are exempt from truncation (need full content)
  exempt: new Set(["memory_read", "memory_context"]),
};

function applyResultBudget(
  toolName: string,
  result: { content: Array<{ type: string; text?: string }> }
): typeof result {
  if (RESULT_SIZE_BUDGET.exempt.has(toolName)) return result;

  for (const item of result.content) {
    if (item && item.type === "text" && "text" in item && typeof item.text === "string" && item.text.length > RESULT_SIZE_BUDGET.maxCharsPerResult) {
      const originalLength = item.text.length;
      const preview = item.text.slice(0, RESULT_SIZE_BUDGET.previewSize);
      (item as { type: string; text: string }).text = `${preview}\n\n--- TRUNCATED (${Math.round(originalLength / 1024)}KB → ${Math.round(RESULT_SIZE_BUDGET.previewSize / 1024)}KB) ---\nFull result exceeded ${Math.round(RESULT_SIZE_BUDGET.maxCharsPerResult / 1024)}KB budget. Use more specific queries or filters to reduce result size.`;
    }
  }

  return result;
}

/**
 * Handle tool calls — dispatch to the first matching module
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    for (const mod of toolModules) {
      const result = await mod.handle(name, (args ?? {}) as Record<string, unknown>, deps);
      if (result !== null) return applyResultBudget(name, result);
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
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
