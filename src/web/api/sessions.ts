import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "crypto";
import type { StateManager } from "../../state/manager.js";

interface CreateSessionBody {
  name: string;
}

interface UpdateSessionBody {
  name?: string;
  archived?: boolean;
}

interface CreateThreadBody {
  title?: string;
  provider: "claude" | "chatgpt" | "gemini";
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

export function registerSessionRoutes(
  server: FastifyInstance,
  stateManager: StateManager
): void {
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

      if (!body.provider || !["claude", "chatgpt", "gemini"].includes(body.provider)) {
        reply.status(400);
        return { error: "provider must be one of: claude, chatgpt, gemini" };
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
}
