import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "crypto";
import type { StateManager } from "../../state/manager.js";
import { bridgeThread } from "../../cli-sessions/bridge.js";

interface CreateSessionBody {
  name: string;
}

interface UpdateSessionBody {
  name?: string;
  archived?: boolean;
}

interface CreateThreadBody {
  title?: string;
  provider: "claude" | "gemini" | "codex" | "kimi" | "chatgpt" | "opencode";
  model?: string;
  parentThreadId?: string;
  branchPointMessageId?: string;
}

interface UpdateThreadBody {
  title?: string;
  status?: "active" | "expired" | "archived";
}

interface CreateMessageBody {
  content: string;
  role?: "user" | "assistant" | "system";
  metadata?: Record<string, unknown>;
}

interface SearchResultRow {
  id: string;
  name: string;
  updatedAt: string;
  threadCount?: number;
  snippet?: string | null;
  rank?: number;
}

interface SessionSearchResult {
  id: string;
  name: string;
  updatedAt: string;
  threadCount: number;
  snippet: string | null;
  matchType: "name" | "content";
}

function mergeSearchResults(
  nameHits: SearchResultRow[],
  ftsHits: SearchResultRow[],
  limit: number
): SessionSearchResult[] {
  const seen = new Map<string, SessionSearchResult>();

  for (const row of nameHits) {
    if (!seen.has(row.id)) {
      seen.set(row.id, {
        id: row.id,
        name: row.name,
        updatedAt: row.updatedAt,
        threadCount: row.threadCount ?? 0,
        snippet: null,
        matchType: "name",
      });
    }
  }

  for (const row of ftsHits) {
    const existing = seen.get(row.id);
    if (!existing) {
      seen.set(row.id, {
        id: row.id,
        name: row.name,
        updatedAt: row.updatedAt,
        threadCount: row.threadCount ?? 0,
        snippet: row.snippet ?? null,
        matchType: "content",
      });
    } else if (!existing.snippet && row.snippet) {
      existing.snippet = row.snippet;
    }
  }

  const results = Array.from(seen.values());
  results.sort((a, b) => {
    if (a.matchType !== b.matchType) {
      return a.matchType === "name" ? -1 : 1;
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  return results.slice(0, limit);
}

export function registerSessionRoutes(
  server: FastifyInstance,
  stateManager: StateManager
): void {
  // ============================================
  // Session Search (must be before /:id route)
  // ============================================

  server.get("/api/chat-sessions/search", async (request: FastifyRequest) => {
    const query = request.query as { q?: string; limit?: string; includeArchived?: string };

    const searchQuery = (query.q ?? "").trim();
    if (searchQuery.length < 2) {
      return { sessions: [], query: searchQuery, totalMatches: 0 };
    }

    const limit = Math.min(parseInt(query.limit ?? "10", 10), 30);
    const includeArchived = query.includeArchived === "true";
    const db = stateManager.getDb();

    const tokens = searchQuery
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => t.replace(/[*()":^${}[\]\\]/g, ""))
      .filter((t) => t.length > 0)
      .slice(0, 10);

    if (tokens.length === 0) {
      return { sessions: [], query: searchQuery, totalMatches: 0 };
    }

    const archivedClause = includeArchived ? "" : "AND cs.archived_at IS NULL";

    // Query 1: Session name matches (per-token LIKE with AND)
    const nameLikeConditions = tokens.map(() => "lower(cs.name) LIKE ?").join(" AND ");
    const nameLikeParams = tokens.map(
      (t) => `%${t.toLowerCase().replace(/%/g, "\\%").replace(/_/g, "\\_")}%`
    );

    const nameHits = db
      .prepare(
        `SELECT
          cs.id,
          cs.name,
          cs.updated_at AS updatedAt,
          (SELECT COUNT(*) FROM threads th WHERE th.chat_session_id = cs.id) AS threadCount
        FROM chat_sessions cs
        WHERE ${nameLikeConditions}
          ${archivedClause}
        ORDER BY cs.updated_at DESC
        LIMIT ?`
      )
      .all(...nameLikeParams, limit) as SearchResultRow[];

    // Query 2: FTS5 content matches
    const ftsMatchExpr = tokens.join(" AND ");
    let ftsHits: SearchResultRow[] = [];
    try {
      ftsHits = db
        .prepare(
          `SELECT
            cs.id,
            cs.name,
            cs.updated_at AS updatedAt,
            snippet(thread_messages_fts, 0, '<mark>', '</mark>', '...', 24) AS snippet,
            bm25(thread_messages_fts) AS rank
          FROM thread_messages_fts
          JOIN thread_messages tm ON thread_messages_fts.rowid = tm.rowid
          JOIN threads th ON th.id = tm.thread_id
          JOIN chat_sessions cs ON cs.id = th.chat_session_id
          WHERE thread_messages_fts MATCH ?
            ${archivedClause}
          ORDER BY bm25(thread_messages_fts)
          LIMIT 50`
        )
        .all(ftsMatchExpr) as SearchResultRow[];
    } catch {
      // FTS5 MATCH can fail on edge-case inputs; degrade gracefully
      ftsHits = [];
    }

    const results = mergeSearchResults(nameHits, ftsHits, limit);
    const totalMatches = new Set([
      ...nameHits.map((r) => r.id),
      ...ftsHits.map((r) => r.id),
    ]).size;

    return { sessions: results, query: searchQuery, totalMatches };
  });

  // ============================================
  // Chat Sessions
  // ============================================

  // List sessions
  server.get("/api/chat-sessions", async (request: FastifyRequest) => {
    const query = request.query as {
      includeArchived?: string;
      limit?: string;
      cursor?: string;
    };

    const sessions = stateManager.listChatSessions({
      includeArchived: query.includeArchived === "true",
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      cursor: query.cursor,
    });

    // Get thread counts for each session
    const sessionsWithCounts = sessions.map((session) => {
      const threads = stateManager.listThreads(session.id);
      return {
        ...session,
        threadCount: threads.length,
        activeThreadCount: threads.filter((t) => t.status === "active").length,
      };
    });

    return {
      sessions: sessionsWithCounts,
      nextCursor: sessions.length > 0 ? sessions[sessions.length - 1]?.updatedAt ?? null : null,
    };
  });

  // Create session
  server.post("/api/chat-sessions", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as CreateSessionBody;

    if (!body.name || typeof body.name !== "string") {
      reply.status(400);
      return { error: "name is required" };
    }

    const session = stateManager.createChatSession({
      id: randomUUID(),
      name: body.name.trim(),
    });

    reply.status(201);
    return session;
  });

  // Get session
  server.get("/api/chat-sessions/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const session = stateManager.getChatSession(id);

    if (!session) {
      reply.status(404);
      return { error: "Session not found" };
    }

    const threads = stateManager.listThreads(id);
    return {
      ...session,
      threads,
    };
  });

  // Update session
  server.patch("/api/chat-sessions/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as UpdateSessionBody;

    const session = stateManager.getChatSession(id);
    if (!session) {
      reply.status(404);
      return { error: "Session not found" };
    }

    const updates: { name?: string; archivedAt?: string | null } = {};

    if (body.name !== undefined) {
      updates.name = body.name.trim();
    }

    if (body.archived !== undefined) {
      updates.archivedAt = body.archived ? new Date().toISOString() : null;
    }

    stateManager.updateChatSession(id, updates);
    return stateManager.getChatSession(id);
  });

  // Delete session
  server.delete("/api/chat-sessions/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const session = stateManager.getChatSession(id);
    if (!session) {
      reply.status(404);
      return { error: "Session not found" };
    }

    stateManager.deleteChatSession(id);
    reply.status(204);
    return;
  });

  // ============================================
  // Threads
  // ============================================

  // List threads for a session
  server.get(
    "/api/chat-sessions/:sessionId/threads",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { sessionId } = request.params as { sessionId: string };

      const session = stateManager.getChatSession(sessionId);
      if (!session) {
        reply.status(404);
        return { error: "Session not found" };
      }

      const threads = stateManager.listThreads(sessionId);

      // Get message count for each thread
      const threadsWithCounts = threads.map((thread) => {
        const messages = stateManager.listThreadMessages(thread.id, { limit: 1000 });
        return {
          ...thread,
          messageCount: messages.length,
        };
      });

      return { threads: threadsWithCounts };
    }
  );

  // Create thread
  server.post(
    "/api/chat-sessions/:sessionId/threads",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { sessionId } = request.params as { sessionId: string };
      const body = request.body as CreateThreadBody;

      const session = stateManager.getChatSession(sessionId);
      if (!session) {
        reply.status(404);
        return { error: "Session not found" };
      }

      if (!body.provider || !["claude", "gemini", "codex", "kimi", "chatgpt", "opencode"].includes(body.provider)) {
        reply.status(400);
        return { error: "provider must be one of: claude, gemini, codex, kimi, chatgpt, opencode" };
      }

      const thread = stateManager.createThread({
        id: randomUUID(),
        chatSessionId: sessionId,
        title: body.title,
        provider: body.provider,
        model: body.model,
        parentThreadId: body.parentThreadId,
        branchPointMessageId: body.branchPointMessageId,
      });

      reply.status(201);
      return thread;
    }
  );

  // Get thread
  server.get("/api/threads/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const thread = stateManager.getThread(id);

    if (!thread) {
      reply.status(404);
      return { error: "Thread not found" };
    }

    const messages = stateManager.listThreadMessages(id);
    const links = stateManager.getThreadLinks(id);

    return {
      ...thread,
      messages,
      links,
    };
  });

  // Update thread
  server.patch("/api/threads/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as UpdateThreadBody;

    const thread = stateManager.getThread(id);
    if (!thread) {
      reply.status(404);
      return { error: "Thread not found" };
    }

    stateManager.updateThread(id, body);
    return stateManager.getThread(id);
  });

  // ============================================
  // Messages
  // ============================================

  // List messages
  server.get("/api/threads/:threadId/messages", async (request: FastifyRequest, reply: FastifyReply) => {
    const { threadId } = request.params as { threadId: string };
    const query = request.query as { limit?: string; beforeId?: string };

    const thread = stateManager.getThread(threadId);
    if (!thread) {
      reply.status(404);
      return { error: "Thread not found" };
    }

    const messages = stateManager.listThreadMessages(threadId, {
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      beforeId: query.beforeId,
    });

    return { messages };
  });

  // Create message (non-streaming)
  server.post("/api/threads/:threadId/messages", async (request: FastifyRequest, reply: FastifyReply) => {
    const { threadId } = request.params as { threadId: string };
    const body = request.body as CreateMessageBody;

    const thread = stateManager.getThread(threadId);
    if (!thread) {
      reply.status(404);
      return { error: "Thread not found" };
    }

    if (!body.content || typeof body.content !== "string") {
      reply.status(400);
      return { error: "content is required" };
    }

    const message = stateManager.createThreadMessage({
      id: randomUUID(),
      threadId,
      role: body.role ?? "user",
      content: body.content,
      metadata: body.metadata,
    });

    reply.status(201);
    return message;
  });

  // ============================================
  // Bridge (Web UI → Claude Code CLI)
  // ============================================

  server.post("/api/threads/:threadId/bridge", async (request: FastifyRequest, reply: FastifyReply) => {
    const { threadId } = request.params as { threadId: string };
    const query = request.query as { force?: string };

    const thread = stateManager.getThread(threadId);
    if (!thread) {
      reply.status(404);
      return { error: "Thread not found" };
    }

    try {
      const result = await bridgeThread(stateManager, threadId, {
        force: query.force === "true",
      });

      return {
        sessionId: result.sessionId,
        command: result.command,
        messageCount: result.messageCount,
        mode: result.mode,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Bridge failed";
      const isClientError = message.includes("not found") || message.includes("No messages");
      reply.status(isClientError ? 400 : 500);
      return { error: message };
    }
  });
}
