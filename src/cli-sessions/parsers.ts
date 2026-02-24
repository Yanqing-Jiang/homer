import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import Database from "better-sqlite3";
import { logger } from "../utils/logger.js";
import { SONNET_MODEL } from "../models.js";

export interface ParsedMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface ParsedSession {
  sessionId: string;
  agent: "codex" | "gemini" | "kimi" | "claude" | "opencode" | "telegram" | "web";
  nativeFilePath: string;
  messages: ParsedMessage[];
  model?: string;
  project?: string;
  startedAt?: string;
  endedAt?: string;
  messageCount: number;
  tokenEstimate?: number;
  contentHash: string;
}

/**
 * Parse Codex CLI session from JSONL file
 * Location: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 */
export function parseCodexSession(filePath: string): ParsedSession | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());

    const messages: ParsedMessage[] = [];
    let sessionId = "";
    let model = "";
    let startTime = "";
    let endTime = "";

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Extract session metadata from first entry
        if (entry.type === "session_meta" && !sessionId) {
          sessionId = entry.session_id || "";
          model = entry.model_provider || "gpt-5.2-codex";
          startTime = entry.timestamp || "";
        }

        // Extract messages from response_item entries
        if (entry.type === "response_item") {
          // Handle nested payload structure
          const payload = entry.payload || entry;
          const role =
            payload.role === "user" || payload.role === "developer"
              ? "user"
              : payload.role === "assistant"
              ? "assistant"
              : "system";

          let content = "";

          // Handle various content structures
          if (typeof payload.content === "string") {
            content = payload.content;
          } else if (Array.isArray(payload.content)) {
            // Content is array of items (new format)
            for (const item of payload.content) {
              if (item.type === "input_text" && item.text) {
                content += item.text + "\n";
              } else if (item.text) {
                content += item.text + "\n";
              } else if (typeof item === "string") {
                content += item + "\n";
              }
            }
            content = content.trim();
          } else if (payload.content?.text) {
            content = payload.content.text;
          } else if (payload.content?.type === "input_text") {
            content = payload.content.text || "";
          }

          if (content) {
            messages.push({
              role,
              content,
              timestamp: entry.timestamp,
            });
            endTime = entry.timestamp || endTime;
          }
        }
      } catch (err) {
        // Skip malformed lines
        logger.debug({ error: err, line }, "Skipping malformed JSONL line");
      }
    }

    if (messages.length === 0) {
      return null;
    }

    // Generate content hash for deduplication
    const normalizedContent = messages
      .map((m) => `${m.role}:${m.content.trim().toLowerCase()}`)
      .join("\n");
    const contentHash = createHash("sha256")
      .update(normalizedContent)
      .digest("hex");

    return {
      sessionId: sessionId || `codex-${Date.now()}`,
      agent: "codex",
      nativeFilePath: filePath,
      messages,
      model,
      startedAt: startTime || undefined,
      endedAt: endTime || undefined,
      messageCount: messages.length,
      contentHash,
    };
  } catch (error) {
    logger.error({ error, filePath }, "Failed to parse Codex session");
    return null;
  }
}

/**
 * Parse Kimi CLI session from JSONL file
 * Location: ~/.kimi/sessions/{account_hash}/{session_uuid}/context.jsonl
 */
export function parseKimiSession(filePath: string): ParsedSession | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());

    const messages: ParsedMessage[] = [];

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        const role = msg.role === "user" ? "user" : msg.role === "assistant" ? "assistant" : "system";

        messages.push({
          role,
          content: msg.content || "",
          timestamp: msg.timestamp,
        });
      } catch (err) {
        logger.debug({ error: err, line }, "Skipping malformed JSONL line");
      }
    }

    if (messages.length === 0) {
      return null;
    }

    // Extract session UUID from path
    const pathParts = filePath.split("/");
    const sessionId = pathParts[pathParts.length - 2] || `kimi-${Date.now()}`;

    // Generate content hash
    const normalizedContent = messages
      .map((m) => `${m.role}:${m.content.trim().toLowerCase()}`)
      .join("\n");
    const contentHash = createHash("sha256")
      .update(normalizedContent)
      .digest("hex");

    return {
      sessionId,
      agent: "kimi",
      nativeFilePath: filePath,
      messages,
      model: "kimi-k2.5",
      startedAt: messages[0]?.timestamp,
      endedAt: messages[messages.length - 1]?.timestamp,
      messageCount: messages.length,
      contentHash,
    };
  } catch (error) {
    logger.error({ error, filePath }, "Failed to parse Kimi session");
    return null;
  }
}

/**
 * Scan for Codex session files within a date range
 */
export function scanCodexSessions(homeDir: string, sinceDays: number = 7): string[] {
  const codexDir = join(homeDir, ".codex", "sessions");
  if (!existsSync(codexDir)) {
    return [];
  }

  const cutoffTime = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const sessionFiles: string[] = [];

  try {
    const years = readdirSync(codexDir).filter((f) => /^\d{4}$/.test(f));

    for (const year of years) {
      const yearPath = join(codexDir, year);
      const months = readdirSync(yearPath).filter((f) => /^\d{2}$/.test(f));

      for (const month of months) {
        const monthPath = join(yearPath, month);
        const days = readdirSync(monthPath).filter((f) => /^\d{2}$/.test(f));

        for (const day of days) {
          const dayPath = join(monthPath, day);
          const files = readdirSync(dayPath).filter((f) => f.endsWith(".jsonl"));

          for (const file of files) {
            const filePath = join(dayPath, file);
            const stats = statSync(filePath);

            if (stats.mtimeMs >= cutoffTime) {
              sessionFiles.push(filePath);
            }
          }
        }
      }
    }
  } catch (error) {
    logger.error({ error }, "Failed to scan Codex sessions");
  }

  return sessionFiles;
}

/**
 * Scan for Kimi session files within a date range
 */
export function scanKimiSessions(homeDir: string, sinceDays: number = 7): string[] {
  const kimiDir = join(homeDir, ".kimi", "sessions");
  if (!existsSync(kimiDir)) {
    return [];
  }

  const cutoffTime = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const sessionFiles: string[] = [];

  try {
    const accountDirs = readdirSync(kimiDir);

    for (const accountDir of accountDirs) {
      const accountPath = join(kimiDir, accountDir);
      if (!statSync(accountPath).isDirectory()) continue;

      const sessionDirs = readdirSync(accountPath);

      for (const sessionDir of sessionDirs) {
        const contextPath = join(accountPath, sessionDir, "context.jsonl");
        if (!existsSync(contextPath)) continue;

        const stats = statSync(contextPath);
        if (stats.mtimeMs >= cutoffTime) {
          sessionFiles.push(contextPath);
        }
      }
    }
  } catch (error) {
    logger.error({ error }, "Failed to scan Kimi sessions");
  }

  return sessionFiles;
}

// --- OpenCode Support ---

interface OpencodeSessionMeta {
  id: string;
  slug: string;
  version: string;
  projectID: string;
  directory: string;
  title?: string;
  time: {
    created: number;
    updated?: number;
  };
  summary?: {
    additions?: number;
    deletions?: number;
    files?: number;
  };
}

interface OpencodeMessageMeta {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  time: {
    created: number;
  };
  summary?: {
    title?: string;
    diffs?: string[];
  };
  agent?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
}

interface OpencodePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text" | "reasoning" | "tool" | "step-start" | string;
  text?: string;
  callID?: string;
  tool?: string;
  state?: {
    status: string;
    input?: Record<string, unknown>;
    output?: string;
    title?: string;
    metadata?: Record<string, unknown>;
    time?: {
      start: number;
      end: number;
    };
  };
  time?: {
    start: number;
    end: number;
  };
}

/**
 * Scan for OpenCode session files within a date range
 * Location: ~/.local/share/opencode/storage/session/{project_hash}/ses_*.json
 */
export function scanOpencodeSessions(homeDir: string, sinceDays: number = 7): string[] {
  const opencodeDir = join(homeDir, ".local", "share", "opencode", "storage", "session");
  if (!existsSync(opencodeDir)) {
    return [];
  }

  const cutoffTime = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const sessionFiles: string[] = [];

  try {
    const projectDirs = readdirSync(opencodeDir);

    for (const projectDir of projectDirs) {
      const projectPath = join(opencodeDir, projectDir);
      if (!statSync(projectPath).isDirectory()) continue;

      const files = readdirSync(projectPath).filter((f) => f.startsWith("ses_") && f.endsWith(".json"));

      for (const file of files) {
        const filePath = join(projectPath, file);
        const stats = statSync(filePath);

        if (stats.mtimeMs >= cutoffTime) {
          sessionFiles.push(filePath);
        }
      }
    }
  } catch (error) {
    logger.error({ error }, "Failed to scan OpenCode sessions");
  }

  return sessionFiles;
}

/**
 * Parse OpenCode CLI session from metadata file
 * Reads session metadata, then traverses message/part structure
 */
// --- Claude Code Support ---

interface ClaudeHistoryEntry {
  display: string;
  timestamp: number;
  project: string;
  sessionId: string;
}

interface ClaudeSessionLine {
  type: "user" | "assistant" | "queue-operation";
  sessionId: string;
  timestamp: string;
  message?: { role?: string; content?: unknown; model?: string; [key: string]: unknown };
  uuid?: string;
  cwd?: string;
  version?: string;
  permissionMode?: string;
}

/**
 * Scan for Claude Code sessions within a date range
 * Reads ~/.claude/history.jsonl for session metadata, then finds matching JSONL transcripts
 */
export function scanClaudeSessions(homeDir: string, sinceDays: number = 7): string[] {
  const historyPath = join(homeDir, ".claude", "history.jsonl");
  if (!existsSync(historyPath)) {
    return [];
  }

  const cutoffTime = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const sessionFiles: string[] = [];
  const seenSessions = new Set<string>();

  try {
    const content = readFileSync(historyPath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());

    for (const line of lines) {
      try {
        const entry: ClaudeHistoryEntry = JSON.parse(line);
        if (entry.timestamp < cutoffTime) continue;
        if (seenSessions.has(entry.sessionId)) continue;
        seenSessions.add(entry.sessionId);

        // Map project path to Claude's directory-based storage
        // Claude uses format: -Users-yj (leading dash, slashes replaced with dashes)
        const projectKey = entry.project.replace(/\//g, "-");
        const sessionPath = join(
          homeDir, ".claude", "projects", projectKey, `${entry.sessionId}.jsonl`
        );

        if (existsSync(sessionPath)) {
          sessionFiles.push(sessionPath);
        }
      } catch {
        // Skip malformed history lines
      }
    }
  } catch (error) {
    logger.error({ error }, "Failed to scan Claude Code sessions");
  }

  return sessionFiles;
}

export interface ParseClaudeOptions {
  /** Skip truncation — return all messages at full length */
  archiveFidelity?: boolean;
}

/**
 * Truncate a parsed session's messages for summary use.
 * Applies message count caps and character limits.
 */
export function truncateForSummary(messages: ParsedMessage[]): ParsedMessage[] {
  const MAX_USER_MESSAGES = 20;
  const MAX_ASSISTANT_MESSAGES = 10;
  const MAX_USER_CHARS = 300;
  const MAX_ASSISTANT_CHARS = 400;

  const result: ParsedMessage[] = [];
  let userCount = 0;
  let assistantCount = 0;

  for (const msg of messages) {
    if (msg.role === "user") {
      if (userCount >= MAX_USER_MESSAGES) continue;
      result.push({ ...msg, content: msg.content.slice(0, MAX_USER_CHARS) });
      userCount++;
    } else if (msg.role === "assistant") {
      if (assistantCount >= MAX_ASSISTANT_MESSAGES) continue;
      result.push({ ...msg, content: msg.content.slice(0, MAX_ASSISTANT_CHARS) });
      assistantCount++;
    } else {
      result.push(msg);
    }
  }

  return result;
}

/**
 * Parse Claude Code session from JSONL transcript
 * Location: ~/.claude/projects/{project_key}/{sessionId}.jsonl
 *
 * @param options.archiveFidelity - If true, returns ALL messages at full length (for transcript archival)
 */
export function parseClaudeSession(filePath: string, options?: ParseClaudeOptions): ParsedSession | null {
  const archiveFidelity = options?.archiveFidelity ?? false;

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());

    const allMessages: ParsedMessage[] = [];
    let sessionId = "";
    let model = "";
    let startTime = "";
    let endTime = "";
    let project = "";

    for (const line of lines) {
      try {
        const entry: ClaudeSessionLine = JSON.parse(line);

        if (!sessionId && entry.sessionId) {
          sessionId = entry.sessionId;
        }

        if (!startTime && entry.timestamp) {
          startTime = entry.timestamp;
        }
        if (entry.timestamp) {
          endTime = entry.timestamp;
        }

        if (entry.type === "user" && entry.message) {
          let msgContent = "";
          const msgObj = entry.message;
          if (typeof msgObj.content === "string") {
            msgContent = msgObj.content;
          } else if (Array.isArray(msgObj.content)) {
            msgContent = msgObj.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n");
          }

          if (!project && entry.cwd) {
            project = entry.cwd;
          }

          if (msgContent) {
            allMessages.push({
              role: "user",
              content: msgContent,
              timestamp: entry.timestamp,
            });
          }
        } else if (entry.type === "assistant" && entry.message) {
          let msgContent = "";
          let msgModel = "";
          const msgObj = entry.message;
          if (Array.isArray(msgObj.content)) {
            msgContent = msgObj.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n");
          } else if (typeof msgObj.content === "string") {
            msgContent = msgObj.content;
          }
          if (msgObj.model) {
            msgModel = msgObj.model;
          }

          if (!model && msgModel) {
            model = msgModel;
          }

          if (msgContent) {
            allMessages.push({
              role: "assistant",
              content: msgContent,
              timestamp: entry.timestamp,
            });
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (allMessages.length === 0) {
      return null;
    }

    // Apply truncation unless archiveFidelity is requested
    const messages = archiveFidelity ? allMessages : truncateForSummary(allMessages);

    // Generate content hash from truncated messages (compatible with existing session_summaries)
    const truncatedForHash = archiveFidelity ? truncateForSummary(allMessages) : messages;
    const normalizedContent = truncatedForHash
      .map((m) => `${m.role}:${m.content.trim().toLowerCase()}`)
      .join("\n");
    const contentHash = createHash("sha256")
      .update(normalizedContent)
      .digest("hex");

    return {
      sessionId: sessionId || `claude-${Date.now()}`,
      agent: "claude",
      nativeFilePath: filePath,
      messages,
      model: model || SONNET_MODEL,
      project: project || undefined,
      startedAt: startTime || undefined,
      endedAt: endTime || undefined,
      messageCount: messages.length,
      contentHash,
    };
  } catch (error) {
    logger.error({ error, filePath }, "Failed to parse Claude Code session");
    return null;
  }
}

export function parseOpencodeSession(filePath: string): ParsedSession | null {
  try {
    // Read session metadata
    const sessionMeta: OpencodeSessionMeta = JSON.parse(readFileSync(filePath, "utf-8"));
    const sessionId = sessionMeta.id;
    const homeDir = filePath.split("/.local/share/opencode")[0] || "";

    // Build paths
    const messagesDir = join(homeDir, ".local", "share", "opencode", "storage", "message", sessionId);
    const partsDir = join(homeDir, ".local", "share", "opencode", "storage", "part");

    if (!existsSync(messagesDir)) {
      logger.warn({ sessionId, messagesDir }, "OpenCode session has no messages directory");
      return null;
    }

    // Read all messages in the session
    const messageFiles = readdirSync(messagesDir)
      .filter((f) => f.startsWith("msg_") && f.endsWith(".json"))
      .sort(); // Ensure chronological order

    const messages: ParsedMessage[] = [];
    const reasoningParts: string[] = [];

    for (const msgFile of messageFiles) {
      const msgPath = join(messagesDir, msgFile);
      const msgMeta: OpencodeMessageMeta = JSON.parse(readFileSync(msgPath, "utf-8"));

      const msgPartsDir = join(partsDir, msgMeta.id);
      if (!existsSync(msgPartsDir)) {
        continue;
      }

      // Read all parts for this message
      const partFiles = readdirSync(msgPartsDir).filter((f) => f.startsWith("prt_") && f.endsWith(".json"));
      const parts: OpencodePart[] = [];

      for (const partFile of partFiles) {
        const partPath = join(msgPartsDir, partFile);
        try {
          const part: OpencodePart = JSON.parse(readFileSync(partPath, "utf-8"));
          parts.push(part);
        } catch (err) {
          logger.debug({ error: err, partPath }, "Failed to parse OpenCode part");
        }
      }

      // Sort parts by ID for consistent ordering
      parts.sort((a, b) => a.id.localeCompare(b.id));

      // Build message content from parts
      let content = "";
      const msgReasoning: string[] = [];

      for (const part of parts) {
        if (part.type === "text" && part.text) {
          content += part.text;
        } else if (part.type === "reasoning" && part.text) {
          msgReasoning.push(part.text);
        } else if (part.type === "tool" && part.state) {
          // Include tool usage info
          const toolName = part.tool || "tool";
          const toolStatus = part.state.status || "unknown";
          const toolTitle = part.state.title || "";

          if (toolTitle) {
            content += `\n[${toolName}: ${toolTitle} (${toolStatus})]\n`;
          }

          // Include tool output if available
          if (part.state.output && typeof part.state.output === "string") {
            // Truncate long outputs
            const output = part.state.output.length > 500
              ? part.state.output.slice(0, 500) + "...\n[output truncated]"
              : part.state.output;
            content += output + "\n";
          }
        }
      }

      if (content.trim() || msgReasoning.length > 0) {
        const timestamp = msgMeta.time?.created
          ? new Date(msgMeta.time.created).toISOString()
          : undefined;

        messages.push({
          role: msgMeta.role,
          content: content.trim(),
          timestamp,
          metadata: msgReasoning.length > 0 ? { thoughts: msgReasoning.map((r) => ({ subject: "Reasoning", description: r })) } : undefined,
        });

        // Collect reasoning for the session
        reasoningParts.push(...msgReasoning);
      }
    }

    if (messages.length === 0) {
      return null;
    }

    // Generate content hash
    const normalizedContent = messages
      .map((m) => `${m.role}:${m.content.trim().toLowerCase()}`)
      .join("\n");
    const contentHash = createHash("sha256").update(normalizedContent).digest("hex");

    // Extract model info from message metadata
    let model = "opencode-unknown";

    // Format timestamps
    const startedAt = sessionMeta.time?.created
      ? new Date(sessionMeta.time.created).toISOString()
      : undefined;
    const endedAt = sessionMeta.time?.updated
      ? new Date(sessionMeta.time.updated).toISOString()
      : undefined;

    return {
      sessionId,
      agent: "opencode",
      nativeFilePath: filePath,
      messages,
      model: model || "opencode-unknown",
      startedAt,
      endedAt,
      messageCount: messages.length,
      contentHash,
    };
  } catch (error) {
    logger.error({ error, filePath }, "Failed to parse OpenCode session");
    return null;
  }
}

// --- Thread (Telegram + Web UI) Support ---

interface ThreadRow {
  id: string;
  chat_session_id: string;
  title: string | null;
  provider: string;
  model: string | null;
  last_message_at: string;
}

interface ThreadMessageRow {
  id: string;
  role: string;
  content: string;
  created_at: string;
  metadata: string | null;
}

/**
 * Scan homer.db threads table for Telegram / Web UI conversations
 * with new messages since last watermark. Returns ParsedSession[] ready
 * for the same summarize → INSERT pipeline used by CLI sessions.
 */
export function scanThreadSessions(
  db: Database.Database,
  sinceDays: number = 7,
  maxBackfillMessages: number = 50
): ParsedSession[] {
  const sessions: ParsedSession[] = [];

  try {
    // Get threads with recent activity
    const threads = db.prepare(`
      SELECT id, chat_session_id, title, provider, model, last_message_at
      FROM threads
      WHERE last_message_at > datetime('now', ?)
        AND status = 'active'
      ORDER BY last_message_at DESC
    `).all(`-${sinceDays} days`) as ThreadRow[];

    for (const thread of threads) {
      try {
        // Check watermark for this thread
        const watermark = db.prepare(
          `SELECT last_imported_message_id, total_imported FROM thread_import_watermark WHERE thread_id = ?`
        ).get(thread.id) as { last_imported_message_id: string; total_imported: number } | undefined;

        // Query new messages since watermark
        let newMessages: ThreadMessageRow[];
        if (watermark) {
          // Get the created_at of the watermark message for comparison
          const watermarkMsg = db.prepare(
            `SELECT created_at FROM thread_messages WHERE id = ?`
          ).get(watermark.last_imported_message_id) as { created_at: string } | undefined;

          if (watermarkMsg) {
            newMessages = db.prepare(`
              SELECT id, role, content, created_at, metadata
              FROM thread_messages
              WHERE thread_id = ? AND created_at > ?
              ORDER BY created_at ASC
            `).all(thread.id, watermarkMsg.created_at) as ThreadMessageRow[];
          } else {
            // Watermark message was deleted — re-import recent messages
            newMessages = db.prepare(`
              SELECT id, role, content, created_at, metadata
              FROM thread_messages
              WHERE thread_id = ?
              ORDER BY created_at DESC LIMIT ?
            `).all(thread.id, maxBackfillMessages) as ThreadMessageRow[];
            newMessages.reverse();
          }
        } else {
          // No watermark — first import, cap at maxBackfillMessages
          newMessages = db.prepare(`
            SELECT id, role, content, created_at, metadata
            FROM thread_messages
            WHERE thread_id = ?
            ORDER BY created_at DESC LIMIT ?
          `).all(thread.id, maxBackfillMessages) as ThreadMessageRow[];
          newMessages.reverse();
        }

        // Skip threads with < 2 new user/assistant messages (avoid noise)
        const substantiveMessages = newMessages.filter(
          (m) => m.role === "user" || m.role === "assistant"
        );
        if (substantiveMessages.length < 2) continue;

        // Determine agent type: tg:system = telegram, else web
        const agent: "telegram" | "web" =
          thread.chat_session_id === "tg:system" ? "telegram" : "web";

        // Build ParsedSession messages
        const messages: ParsedMessage[] = substantiveMessages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
          timestamp: m.created_at,
        }));

        // Content hash based on new messages only
        const normalizedContent = messages
          .map((m) => `${m.role}:${m.content.trim().toLowerCase()}`)
          .join("\n");
        const contentHash = createHash("sha256")
          .update(normalizedContent)
          .digest("hex");

        const firstTimestamp = newMessages[0]?.created_at || "";
        const lastTimestamp = newMessages[newMessages.length - 1]?.created_at || "";
        const lastMsgId = newMessages[newMessages.length - 1]?.id || "";

        // Extract model from thread or assistant message metadata
        let model = thread.model || thread.provider || "unknown";
        if (!thread.model) {
          const assistantMsg = newMessages.find((m) => m.role === "assistant" && m.metadata);
          if (assistantMsg?.metadata) {
            try {
              const meta = JSON.parse(assistantMsg.metadata);
              if (meta.model) model = meta.model;
            } catch { /* ignore */ }
          }
        }

        sessions.push({
          sessionId: `${thread.id}:${firstTimestamp}`,
          agent,
          nativeFilePath: `thread:${thread.id}`,
          messages,
          model,
          project: thread.title || `${agent} conversation`,
          startedAt: firstTimestamp || undefined,
          endedAt: lastTimestamp || undefined,
          messageCount: messages.length,
          contentHash,
          // Stash last message ID for watermark update (accessed via casting)
          ...(lastMsgId ? { _lastMsgId: lastMsgId, _threadId: thread.id, _newCount: substantiveMessages.length } : {}),
        });
      } catch (error) {
        logger.error({ error, threadId: thread.id }, "Failed to scan thread");
      }
    }
  } catch (error) {
    logger.error({ error }, "Failed to scan thread sessions");
  }

  return sessions;
}
