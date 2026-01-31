import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  getSessions,
  getSession,
  getSessionCount,
  type ClaudeSession,
} from "../../claude-history/parser.js";

/**
 * Register Claude Code history API routes
 */
export function registerClaudeHistoryRoutes(server: FastifyInstance): void {
  // List all Claude Code sessions
  server.get("/api/claude-history", async (request: FastifyRequest) => {
    const query = request.query as { limit?: string };
    const limit = query.limit ? parseInt(query.limit, 10) : 50;

    const sessions = getSessions(limit);
    const total = getSessionCount();

    return {
      sessions: sessions.map(formatSession),
      total,
    };
  });

  // Get a single session with all prompts
  server.get("/api/claude-history/:sessionId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { sessionId } = request.params as { sessionId: string };

    const session = getSession(sessionId);
    if (!session) {
      reply.status(404);
      return { error: "Session not found" };
    }

    return {
      ...formatSession(session),
      prompts: session.prompts.map(p => ({
        display: p.display,
        timestamp: p.timestamp,
        formattedTime: new Date(p.timestamp).toISOString(),
      })),
    };
  });
}

function formatSession(session: ClaudeSession) {
  return {
    sessionId: session.sessionId,
    project: session.project,
    projectName: session.project.split("/").pop() || session.project,
    startTime: session.startTime,
    endTime: session.endTime,
    formattedStart: new Date(session.startTime).toISOString(),
    formattedEnd: new Date(session.endTime).toISOString(),
    promptCount: session.promptCount,
    firstPrompt: session.prompts[0]?.display.slice(0, 100) || "",
    lastPrompt: session.prompts[session.prompts.length - 1]?.display.slice(0, 100) || "",
  };
}
