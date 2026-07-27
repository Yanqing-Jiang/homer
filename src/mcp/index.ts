#!/usr/bin/env node
/**
 * Homer Memory MCP Server — local stdio transport.
 *
 * Thin wrapper over the shared factory in ./server.ts. The full toolset is
 * exposed (this is the trusted local Mac mini surface). There is no remote MCP
 * transport — the HTTP route and its allowlist/policy were deleted with the
 * work-laptop path.
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
