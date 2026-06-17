#!/usr/bin/env node
/**
 * Homer Memory MCP Server — local stdio transport.
 *
 * Thin wrapper over the shared factory in ./server.ts. The full toolset is
 * exposed with no allowlist and no remote policy (this is the trusted local
 * Mac mini surface). The remote HTTP surface lives in homer-web's /mcp route,
 * which calls the same factory with a narrow allowlist + RemotePolicy.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHomerMcpServer, initMcpState } from "./server.js";

async function main() {
  // Initialize state before serving so a fresh install creates the DB parent
  // directory and schema before any MCP tool is advertised.
  initMcpState();
  const server = createHomerMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Homer Memory MCP server running on stdio");
}

main().catch(console.error);
