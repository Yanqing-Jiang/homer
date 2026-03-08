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

// Tool modules
import * as memoryTools from "./tools/memory.js";
import * as ideaTools from "./tools/ideas.js";
import * as planTools from "./tools/plans.js";
import * as blobTools from "./tools/blob.js";
import * as sessionTools from "./tools/sessions.js";
import * as meetingTools from "./tools/meetings.js";

// Shared StateManager singleton — better-sqlite3 is synchronous, MCP is single-threaded
let sharedSM: StateManager | null = null;
function getSharedStateManager(): StateManager {
  if (!sharedSM) {
    sharedSM = new StateManager(PATHS.db);
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

// Initialize indexer
const indexer = getMemoryIndexer();

// Canonical memory service
const canonicalMemory = getCanonicalMemoryService(getSharedStateManager(), indexer);

// Shared dependencies for all tool modules
const deps: ToolDeps = { getSharedStateManager, indexer, getAzureBlob, canonicalMemory };

// All tool modules in dispatch order
const toolModules = [memoryTools, ideaTools, planTools, blobTools, sessionTools, meetingTools];

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

/**
 * Handle tool calls — dispatch to the first matching module
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    for (const mod of toolModules) {
      const result = await mod.handle(name, (args ?? {}) as Record<string, unknown>, deps);
      if (result !== null) return result;
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
