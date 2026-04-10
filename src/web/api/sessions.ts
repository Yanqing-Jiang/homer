import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "crypto";
import type { StateManager, ThreadMessage } from "../../state/manager.js";
import { bridgeThread } from "../../cli-sessions/bridge.js";
import { sessionEvents, type SessionEvent } from "../../events/session-events.js";
import { logger } from "../../utils/logger.js";

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
  threadId?: string | null;
  snippet?: string | null;
  rank?: number;
}

/** Project metadata.attachments to a top-level field for API consumers */
function projectAttachments(messages: ThreadMessage[]) {
  return messages.map((m) => {
    const attachments = m.metadata?.attachments;
    return attachments ? { ...m, attachments } : m;
  });
}

interface SessionSearchResult {
  id: string;
  name: string;
  updatedAt: string;
  threadCount: number;
  threadId: string | null;
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
        threadId: null,
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
        threadId: row.threadId ?? null,
        snippet: row.snippet ?? null,
        matchType: "content",
      });
    } else {
      if (!existing.snippet && row.snippet) existing.snippet = row.snippet;
      if (!existing.threadId && row.threadId) existing.threadId = row.threadId;
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
  // Session-Level SSE (must be before /:id route)
  // ============================================

  server.get("/api/chat-sessions/events", async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const origin = request.headers.origin;
    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    };
    if (origin) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Credentials"] = "true";
    }

    reply.raw.writeHead(200, headers);

    // Send initial connected event
    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ type: "connected" })}\n\n`);

    // Subscribe to session events
    const unsubscribe = sessionEvents.onSessionEvent((event: SessionEvent) => {
      try {
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Client disconnected
      }
    });

    // Heartbeat
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`:heartbeat\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 30000);

    // Cleanup on disconnect
    request.raw.on("close", () => {
      unsubscribe();
      clearInterval(heartbeat);
      logger.debug("Session SSE client disconnected");
    });
  });

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
            th.id AS threadId,
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

  // List sessions (single aggregate query — no N+1)
  server.get("/api/chat-sessions", async (request: FastifyRequest) => {
    const query = request.query as {
      includeArchived?: string;
      limit?: string;
      cursor?: string;
    };

    const limit = Math.min(parseInt(query.limit ?? "50", 10), 100);
    const includeArchived = query.includeArchived === "true";
    const cursor = query.cursor;
    const db = stateManager.getDb();

    const whereClauses: string[] = [];
    const params: Array<string | number> = [];

    if (!includeArchived) {
      whereClauses.push("cs.archived_at IS NULL");
    }
    if (cursor) {
      whereClauses.push("COALESCE(cs.activity_at, cs.updated_at) < ?");
      params.push(cursor);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const enriched = db.prepare(`
      SELECT
        cs.id, cs.name, cs.created_at as createdAt, cs.updated_at as updatedAt,
        cs.archived_at as archivedAt, cs.activity_at as activityAt,
        sr.read_at as lastReadAt,
        COUNT(DISTINCT th.id) as threadCount,
        COUNT(DISTINCT CASE WHEN th.status = 'active' THEN th.id END) as activeThreadCount,
        MAX(cr.id) as activeRunId,
        MAX(cr.status) as runStatus,
        MAX(cr.executor) as runExecutor,
        MAX(cr.started_at) as runStartedAt
      FROM chat_sessions cs
      LEFT JOIN session_reads sr ON sr.session_id = cs.id
      LEFT JOIN threads th ON th.chat_session_id = cs.id
      LEFT JOIN cli_runs cr ON cr.lane = ('web:' || cs.id) AND cr.status = 'running'
      ${whereSql}
      GROUP BY cs.id
      ORDER BY COALESCE(cs.activity_at, cs.updated_at) DESC
      LIMIT ?
    `).all(...params, limit) as Array<{
      id: string; name: string; createdAt: string; updatedAt: string;
      archivedAt: string | null; activityAt: string | null;
      lastReadAt: string | null; threadCount: number; activeThreadCount: number;
      activeRunId: string | null; runStatus: string | null;
      runExecutor: string | null; runStartedAt: string | null;
    }>;

    const sessions = enriched.map(s => ({
      ...s,
      hasUnread: s.activityAt != null && s.activityAt > (s.lastReadAt ?? s.createdAt),
    }));

    return {
      sessions,
      nextCursor: sessions.length > 0
        ? (sessions[sessions.length - 1]?.activityAt ?? sessions[sessions.length - 1]?.updatedAt ?? null)
        : null,
    };
  });

  // Mark session as read (server-authoritative)
  server.post("/api/chat-sessions/:id/read", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    stateManager.markSessionRead(id);
    reply.status(204);
    return;
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

  // Get thread (includes active run + step events for replay)
  server.get("/api/threads/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const thread = stateManager.getThread(id);

    if (!thread) {
      reply.status(404);
      return { error: "Thread not found" };
    }

    const messages = projectAttachments(stateManager.listThreadMessages(id));
    const links = stateManager.getThreadLinks(id);

    // Check for active run on this thread's session
    const activeRun = stateManager.getActiveCliRunForLane(`web:${thread.chatSessionId}`);
    const runEvents = activeRun ? stateManager.getRunEvents(activeRun.id) : [];

    return {
      ...thread,
      messages,
      links,
      activeRun: activeRun ? {
        id: activeRun.id,
        status: activeRun.status,
        executor: activeRun.executor,
        startedAt: activeRun.startedAt,
        streamText: activeRun.streamText,
        streamPhase: activeRun.streamPhase,
        streamSeq: activeRun.streamSeq,
        streamUpdatedAt: activeRun.streamUpdatedAt,
        events: runEvents,
      } : null,
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

    const messages = projectAttachments(stateManager.listThreadMessages(threadId, {
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      beforeId: query.beforeId,
    }));

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
