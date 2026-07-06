#!/usr/bin/env node
/**
 * Session Bridge: Web UI Thread → Claude Code CLI
 *
 * Converts Homer web UI threads into Claude Code JSONL session files,
 * enabling `claude --resume <uuid>` to pick up a web conversation locally.
 *
 * Usage:
 *   npx tsx ~/homer/src/cli-sessions/bridge.ts <thread-id>
 *   npx tsx ~/homer/src/cli-sessions/bridge.ts --list
 *   npx tsx ~/homer/src/cli-sessions/bridge.ts --latest
 */

import { randomUUID } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { StateManager, type ThreadMessage, type Thread } from "../state/manager.js";
import { runMigrations } from "../state/migrations/index.js";
import Database from "better-sqlite3";
import { logger } from "../utils/logger.js";
import { getRuntimePaths } from "../utils/runtime-paths.js";

const runtimePaths = getRuntimePaths();
const CLAUDE_PROJECTS_DIR = join(runtimePaths.claudeDir, "projects", runtimePaths.homeDir.replace(/\//g, "-"));
const CLAUDE_CODE_VERSION = "2.1.63";
const DEFAULT_CWD = runtimePaths.homeDir;

export interface BridgeResult {
  sessionId: string;
  command: string;
  messageCount: number;
  mode: "full" | "summarized";
  jsonlPath: string;
}

interface ClaudeJSONLEvent {
  type: "queue-operation" | "user" | "assistant";
  sessionId: string;
  timestamp: string;
  uuid: string;
  parentUuid: string | null;
  [key: string]: unknown;
}

interface SessionsIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  summary: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
  isSidechain: boolean;
}

interface SessionsIndex {
  version: number;
  entries: SessionsIndexEntry[];
}

/**
 * Build a single JSONL event line for a user message
 */
function buildUserEvent(
  content: string,
  sessionId: string,
  parentUuid: string | null,
  timestamp: string,
): ClaudeJSONLEvent {
  return {
    parentUuid,
    isSidechain: false,
    userType: "external",
    cwd: DEFAULT_CWD,
    sessionId,
    version: CLAUDE_CODE_VERSION,
    gitBranch: "HEAD",
    type: "user",
    message: { role: "user", content },
    uuid: randomUUID(),
    timestamp,
    permissionMode: "default",
  };
}

/**
 * Build a single JSONL event line for an assistant message
 */
function buildAssistantEvent(
  content: string,
  sessionId: string,
  parentUuid: string | null,
  timestamp: string,
  model: string,
): ClaudeJSONLEvent {
  return {
    parentUuid,
    isSidechain: false,
    userType: "external",
    cwd: DEFAULT_CWD,
    sessionId,
    version: CLAUDE_CODE_VERSION,
    gitBranch: "HEAD",
    type: "assistant",
    message: {
      model,
      id: `msg_synthetic_${randomUUID().slice(0, 12)}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: content }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    requestId: `req_synthetic_${randomUUID().slice(0, 12)}`,
    uuid: randomUUID(),
    timestamp,
  };
}

/**
 * Build queue operation events (enqueue + dequeue)
 */
function buildQueueEvents(
  sessionId: string,
  firstPrompt: string,
  timestamp: string,
): string[] {
  const enqueue = {
    type: "queue-operation",
    operation: "enqueue",
    timestamp,
    sessionId,
    content: firstPrompt,
  };
  const dequeue = {
    type: "queue-operation",
    operation: "dequeue",
    timestamp,
    sessionId,
  };
  return [JSON.stringify(enqueue), JSON.stringify(dequeue)];
}

/**
 * Sanitize message content for JSONL (handle images, attachments)
 */
function sanitizeContent(content: string, role: string): string {
  if (!content) return role === "user" ? "(empty message)" : "(no response)";
  return content;
}

/**
 * Convert thread messages to Claude Code JSONL content.
 *
 * Full mode: all messages become JSONL events.
 * Summarized mode: older messages summarized, recent 10 kept verbatim.
 */
function messagesToJSONL(
  messages: ThreadMessage[],
  sessionId: string,
  model: string,
  summary?: string,
): { jsonlContent: string; mode: "full" | "summarized" } {
  const lines: string[] = [];
  const substantive = messages.filter((m) => m.role === "user" || m.role === "assistant");

  if (substantive.length === 0) {
    throw new Error("No messages to bridge");
  }

  const firstUserMsg = substantive.find((m) => m.role === "user");
  const firstPrompt = firstUserMsg?.content.slice(0, 200) || "Web UI conversation";
  const firstTimestamp = substantive[0]!.createdAt;

  // Queue operations
  lines.push(...buildQueueEvents(sessionId, firstPrompt, firstTimestamp));

  let mode: "full" | "summarized" = "full";
  let messagesToConvert = substantive;

  // If > 30 messages and we have a summary, use summarized mode
  if (substantive.length > 30 && summary) {
    mode = "summarized";
    const recentMessages = substantive.slice(-10);

    // Create a synthetic summary as the first exchange
    const summaryUserEvent = buildUserEvent(
      "(This session was bridged from Homer web UI. Earlier conversation summarized below.)",
      sessionId,
      null,
      firstTimestamp,
    );
    lines.push(JSON.stringify(summaryUserEvent));

    const summaryAssistantEvent = buildAssistantEvent(
      `**Conversation Summary (${substantive.length - 10} earlier messages):**\n\n${summary}`,
      sessionId,
      summaryUserEvent.uuid,
      firstTimestamp,
      model,
    );
    lines.push(JSON.stringify(summaryAssistantEvent));

    // Now add recent messages with proper parent chain
    let lastUuid = summaryAssistantEvent.uuid;
    for (const msg of recentMessages) {
      const content = sanitizeContent(msg.content, msg.role);
      let event: ClaudeJSONLEvent;

      if (msg.role === "user") {
        event = buildUserEvent(content, sessionId, lastUuid, msg.createdAt);
      } else {
        event = buildAssistantEvent(content, sessionId, lastUuid, msg.createdAt, model);
      }

      lines.push(JSON.stringify(event));
      lastUuid = event.uuid;
    }
  } else {
    // Full mode — convert all messages
    let lastUuid: string | null = null;

    for (const msg of messagesToConvert) {
      const content = sanitizeContent(msg.content, msg.role);
      let event: ClaudeJSONLEvent;

      if (msg.role === "user") {
        event = buildUserEvent(content, sessionId, lastUuid, msg.createdAt);
      } else {
        event = buildAssistantEvent(content, sessionId, lastUuid, msg.createdAt, model);
      }

      lines.push(JSON.stringify(event));
      lastUuid = event.uuid;
    }
  }

  return { jsonlContent: lines.join("\n") + "\n", mode };
}

/**
 * Update sessions-index.json with the new synthetic session
 */
function updateSessionsIndex(
  sessionId: string,
  jsonlPath: string,
  firstPrompt: string,
  messageCount: number,
  created: string,
  modified: string,
): void {
  const indexPath = join(CLAUDE_PROJECTS_DIR, "sessions-index.json");
  let index: SessionsIndex = { version: 1, entries: [] };

  if (existsSync(indexPath)) {
    try {
      const parsed = JSON.parse(readFileSync(indexPath, "utf-8"));
      if (parsed && Array.isArray(parsed.entries)) {
        index = parsed as SessionsIndex;
      }
    } catch {
      // If corrupted, Claude Code will rebuild it
      index = { version: 1, entries: [] };
    }
  }

  // Remove existing entry for this session if re-bridging
  index.entries = index.entries.filter((e) => e.sessionId !== sessionId);

  index.entries.push({
    sessionId,
    fullPath: jsonlPath,
    fileMtime: Date.now(),
    firstPrompt: firstPrompt.slice(0, 200),
    summary: `Bridged from Homer web UI`,
    messageCount,
    created,
    modified,
    gitBranch: "",
    projectPath: DEFAULT_CWD,
    isSidechain: false,
  });

  writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

/**
 * Bridge a Homer web UI thread into a Claude Code session.
 *
 * If the thread already has an external_session_id and the JSONL exists,
 * returns the existing session (unless force=true).
 */
export async function bridgeThread(
  stateManager: StateManager,
  threadId: string,
  options?: { force?: boolean; summary?: string },
): Promise<BridgeResult> {
  const thread = stateManager.getThread(threadId);
  if (!thread) {
    throw new Error(`Thread not found: ${threadId}`);
  }

  // Check for existing bridge (idempotency)
  if (!options?.force && thread.externalSessionId) {
    const existingPath = join(CLAUDE_PROJECTS_DIR, `${thread.externalSessionId}.jsonl`);
    if (existsSync(existingPath)) {
      // Count messages in existing JSONL
      const content = readFileSync(existingPath, "utf-8");
      const msgCount = content.split("\n").filter((l) => {
        if (!l.trim()) return false;
        try {
          const parsed = JSON.parse(l);
          return parsed.type === "user" || parsed.type === "assistant";
        } catch {
          return false;
        }
      }).length;

      return {
        sessionId: thread.externalSessionId,
        command: `claude --resume ${thread.externalSessionId}`,
        messageCount: msgCount,
        mode: "full",
        jsonlPath: existingPath,
      };
    }
  }

  // Fetch all messages (high limit to avoid truncation — web UI threads rarely exceed a few hundred)
  const messages = stateManager.listThreadMessages(threadId, { limit: 10000 });
  const substantive = messages.filter((m) => m.role === "user" || m.role === "assistant");

  if (substantive.length === 0) {
    throw new Error("No messages to bridge");
  }

  // Determine model from thread metadata
  const model = thread.model || "claude-sonnet-4-6";

  // Generate session ID
  const sessionId = randomUUID();

  // Generate summary for long threads if not provided
  let summary = options?.summary;
  if (substantive.length > 30 && !summary) {
    // Build a simple summary from message content
    const firstFew = substantive.slice(0, 5).map((m) => `${m.role}: ${m.content.slice(0, 100)}`).join("\n");
    summary = `Conversation started with:\n${firstFew}\n\n(${substantive.length} total messages, recent 10 shown in full below)`;
  }

  // Convert to JSONL
  const { jsonlContent, mode } = messagesToJSONL(substantive, sessionId, model, summary);

  // Ensure projects dir exists
  mkdirSync(CLAUDE_PROJECTS_DIR, { recursive: true });

  // Write JSONL file
  const jsonlPath = join(CLAUDE_PROJECTS_DIR, `${sessionId}.jsonl`);
  writeFileSync(jsonlPath, jsonlContent);

  // Update sessions-index.json
  const firstPrompt = substantive.find((m) => m.role === "user")?.content.slice(0, 200) || "Web UI conversation";
  const created = substantive[0]!.createdAt;
  const modified = substantive[substantive.length - 1]!.createdAt;

  updateSessionsIndex(sessionId, jsonlPath, firstPrompt, substantive.length, created, modified);

  // Update thread's external_session_id
  stateManager.updateThread(threadId, { externalSessionId: sessionId });

  return {
    sessionId,
    command: `claude --resume ${sessionId}`,
    messageCount: substantive.length,
    mode,
    jsonlPath,
  };
}

/**
 * Format thread context as readable markdown (for MCP thread_load)
 */
export function formatThreadAsMarkdown(
  thread: Thread,
  messages: ThreadMessage[],
): string {
  const lines: string[] = [];
  lines.push(`# ${thread.title || "Untitled Thread"}`);
  lines.push(`**Provider:** ${thread.provider} | **Model:** ${thread.model || "unknown"} | **Status:** ${thread.status}`);
  lines.push(`**Created:** ${thread.createdAt}\n`);
  lines.push("---\n");

  for (const msg of messages) {
    if (msg.role === "system") continue;
    const roleLabel = msg.role === "user" ? "**User**" : `**${thread.provider}**`;
    lines.push(`${roleLabel} (${msg.createdAt}):\n`);
    lines.push(msg.content);
    lines.push("\n---\n");
  }

  return lines.join("\n");
}

// --- CLI Entry Point ---

async function listRecentThreads(sm: StateManager): Promise<void> {
  const sessions = sm.listChatSessions({ limit: 10 });
  let threadCount = 0;

  console.log("Recent active threads:\n");

  for (const session of sessions) {
    const threads = sm.listThreads(session.id);
    for (const thread of threads) {
      if (thread.status !== "active") continue;
      const messages = sm.listThreadMessages(thread.id, { limit: 1000 });
      const msgCount = messages.filter((m) => m.role === "user" || m.role === "assistant").length;
      if (msgCount === 0) continue;

      const bridged = thread.externalSessionId ? " [bridged]" : "";
      console.log(`  ${thread.id}  ${thread.title || "Untitled"}  (${msgCount} msgs, ${thread.provider})${bridged}`);
      threadCount++;

      if (threadCount >= 15) break;
    }
    if (threadCount >= 15) break;
  }

  if (threadCount === 0) {
    console.log("  No active threads found.");
  }
}

async function main() {
  const args = process.argv.slice(2);

  const dbPath = runtimePaths.databasePath;
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");

  try {
    runMigrations(db);
  } catch (error) {
    logger.error({ error }, "Failed to run migrations");
    process.exit(1);
  }

  const sm = new StateManager(dbPath);

  if (args.includes("--list")) {
    await listRecentThreads(sm);
    db.close();
    return;
  }

  if (args.includes("--latest")) {
    // Find the most recent active thread with messages
    const sessions = sm.listChatSessions({ limit: 5 });
    let latestThread: Thread | null = null;

    for (const session of sessions) {
      const threads = sm.listThreads(session.id);
      for (const thread of threads) {
        if (thread.status !== "active") continue;
        const msgs = sm.listThreadMessages(thread.id, { limit: 10 });
        const hasSubstantive = msgs.some((m) => m.role === "user" || m.role === "assistant");
        if (hasSubstantive) {
          latestThread = thread;
          break;
        }
      }
      if (latestThread) break;
    }

    if (!latestThread) {
      console.error("No active threads found.");
      db.close();
      process.exit(1);
    }

    args[0] = latestThread.id;
  }

  const threadId = args[0];
  if (!threadId) {
    console.log("Usage:");
    console.log("  npx tsx ~/homer/src/cli-sessions/bridge.ts <thread-id>");
    console.log("  npx tsx ~/homer/src/cli-sessions/bridge.ts --list");
    console.log("  npx tsx ~/homer/src/cli-sessions/bridge.ts --latest");
    db.close();
    process.exit(1);
  }

  const force = args.includes("--force");

  try {
    const result = await bridgeThread(sm, threadId, { force });
    const thread = sm.getThread(threadId);
    const title = thread?.title || "Untitled";

    console.log(`Bridged thread "${title}" (${result.messageCount} messages, ${result.mode} fidelity)`);
    console.log(`-> ${result.command}`);
  } catch (error) {
    console.error(`Failed to bridge: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

// Run CLI if invoked directly
const isMainModule = process.argv[1]?.endsWith("bridge.ts") || process.argv[1]?.endsWith("bridge.js");
if (isMainModule) {
  main().catch(console.error);
}
