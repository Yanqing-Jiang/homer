import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "crypto";
import { unlinkSync } from "fs";
import type { StateManager } from "../../state/manager.js";
import { IdeasIndexer } from "../../ideas/indexer.js";
import {
  parseIdeaFile,
  saveIdeaFile,
  getIdeasPaths,
  isIdeasMigrated,
  type ParsedIdea,
} from "../../ideas/parser.js";

let ideasIndexer: IdeasIndexer | null = null;

interface UpdateIdeaBody {
  status?: string;
  title?: string;
  notes?: string;
  content?: string;
  context?: string;
  tags?: string[];
  link?: string;
}

interface CreateIdeaBody {
  title: string;
  content: string;
  source?: string;
  context?: string;
  tags?: string[];
  link?: string;
}

/**
 * Register ideas API routes
 */
export function registerIdeasRoutes(
  server: FastifyInstance,
  stateManager: StateManager
): void {
  // Initialize ideas indexer
  ideasIndexer = new IdeasIndexer(stateManager.db);

  // Initial index on startup
  if (isIdeasMigrated()) {
    ideasIndexer.reindex();
    ideasIndexer.startWatching();
  }

  // List ideas
  server.get("/api/ideas", async (request: FastifyRequest) => {
    const query = request.query as { status?: string; limit?: string };

    if (!ideasIndexer) {
      return { ideas: [], migrated: false };
    }

    // Check if migrated
    if (!isIdeasMigrated()) {
      return { ideas: [], migrated: false, message: "Ideas not migrated. Run migration script first." };
    }

    const ideas = ideasIndexer.list({
      status: query.status,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
    });

    // Enrich with full content from files
    const enrichedIdeas = ideas.map((idea) => {
      const parsed = idea.filePath ? parseIdeaFile(idea.filePath) : null;
      return {
        ...idea,
        content: parsed?.content || "",
        context: parsed?.context || null,
        notes: parsed?.notes || null,
        link: parsed?.link || null,
        tags: idea.tags ? JSON.parse(idea.tags) : [],
      };
    });

    return { ideas: enrichedIdeas, migrated: true };
  });

  // Get single idea
  server.get("/api/ideas/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    if (!ideasIndexer) {
      reply.status(503);
      return { error: "Ideas indexer not initialized" };
    }

    const idea = ideasIndexer.get(id);
    if (!idea) {
      reply.status(404);
      return { error: "Idea not found" };
    }

    // Get full content from file
    const parsed = idea.filePath ? parseIdeaFile(idea.filePath) : null;
    const linkedThreads = idea.linkedThreadId
      ? stateManager.getThread(idea.linkedThreadId)
      : null;

    return {
      ...idea,
      content: parsed?.content || "",
      context: parsed?.context || null,
      notes: parsed?.notes || null,
      link: parsed?.link || null,
      tags: idea.tags ? JSON.parse(idea.tags) : [],
      thread: linkedThreads,
    };
  });

  // Update idea
  server.patch("/api/ideas/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as UpdateIdeaBody;

    if (!ideasIndexer) {
      reply.status(503);
      return { error: "Ideas indexer not initialized" };
    }

    const idea = ideasIndexer.get(id);
    if (!idea) {
      reply.status(404);
      return { error: "Idea not found" };
    }

    // Update file
    const parsed = idea.filePath ? parseIdeaFile(idea.filePath) : null;
    if (!parsed) {
      reply.status(500);
      return { error: "Could not read idea file" };
    }

    // Apply updates
    if (body.status !== undefined) {
      parsed.status = body.status;
    }
    if (body.title !== undefined) {
      parsed.title = body.title;
    }
    if (body.notes !== undefined) {
      parsed.notes = body.notes;
    }
    if (body.content !== undefined) {
      parsed.content = body.content;
    }
    if (body.context !== undefined) {
      parsed.context = body.context;
    }
    if (body.tags !== undefined) {
      parsed.tags = body.tags;
    }
    if (body.link !== undefined) {
      parsed.link = body.link;
    }

    // Save and reindex
    saveIdeaFile(parsed);
    ideasIndexer.updateIdea(idea.filePath!);

    return ideasIndexer.get(id);
  });

  // Delete idea
  server.delete("/api/ideas/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    if (!ideasIndexer) {
      reply.status(503);
      return { error: "Ideas indexer not initialized" };
    }

    const idea = ideasIndexer.get(id);
    if (!idea) {
      reply.status(404);
      return { error: "Idea not found" };
    }

    // Delete the file
    if (idea.filePath) {
      try {
        unlinkSync(idea.filePath);
      } catch (e) {
        reply.status(500);
        return { error: "Failed to delete idea file" };
      }
    }

    // Remove from index
    ideasIndexer.removeIdea(id);

    return { deleted: true, id };
  });

  // Create idea
  server.post("/api/ideas", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as CreateIdeaBody;

    if (!body.title || !body.content) {
      reply.status(400);
      return { error: "title and content are required" };
    }

    // Generate ID based on timestamp
    const now = new Date();
    const id = `idea_${now.toISOString().replace(/[-:T]/g, "").slice(0, 12)}`;

    const idea: ParsedIdea = {
      id,
      title: body.title,
      content: body.content,
      status: "draft",
      source: body.source || "web-ui",
      context: body.context,
      tags: body.tags || [],
      link: body.link,
      timestamp: now.toISOString(),
    };

    const filePath = saveIdeaFile(idea);

    if (ideasIndexer) {
      ideasIndexer.updateIdea(filePath);
    }

    reply.status(201);
    return { id, filePath };
  });

  // Research idea (create linked thread)
  server.post("/api/ideas/:id/research", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    if (!ideasIndexer) {
      reply.status(503);
      return { error: "Ideas indexer not initialized" };
    }

    const idea = ideasIndexer.get(id);
    if (!idea) {
      reply.status(404);
      return { error: "Idea not found" };
    }

    // Check if already has linked thread
    if (idea.linkedThreadId) {
      return {
        threadId: idea.linkedThreadId,
        message: "Idea already has a linked thread",
      };
    }

    // Create a session and thread for researching this idea
    const sessionId = randomUUID();
    stateManager.createChatSession({
      id: sessionId,
      name: `Research: ${idea.title}`,
    });

    const threadId = randomUUID();
    stateManager.createThread({
      id: threadId,
      chatSessionId: sessionId,
      title: `Researching: ${idea.title}`,
      provider: "claude",
    });

    // Link thread to idea
    stateManager.createThreadLink({
      threadId,
      linkType: "idea",
      linkId: id,
    });
    ideasIndexer.linkThread(id, threadId);

    // Update idea status to researching
    const parsed = idea.filePath ? parseIdeaFile(idea.filePath) : null;
    if (parsed) {
      parsed.status = "researching";
      saveIdeaFile(parsed);
      ideasIndexer.updateIdea(idea.filePath!);
    }

    return {
      sessionId,
      threadId,
      message: "Research thread created",
    };
  });

  // Convert idea to plan
  server.post("/api/ideas/:id/plan", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    if (!ideasIndexer) {
      reply.status(503);
      return { error: "Ideas indexer not initialized" };
    }

    const idea = ideasIndexer.get(id);
    if (!idea) {
      reply.status(404);
      return { error: "Idea not found" };
    }

    // TODO: Implement plan creation
    // This would create a new plan file in ~/memory/plans/
    // and link it to the idea

    reply.status(501);
    return { error: "Plan creation not yet implemented" };
  });

  // Reindex ideas
  server.post("/api/ideas/reindex", async () => {
    if (!ideasIndexer) {
      return { error: "Ideas indexer not initialized", indexed: 0 };
    }

    const indexed = ideasIndexer.reindex();
    return { indexed, message: "Reindex complete" };
  });

  // Check migration status
  server.get("/api/ideas/status", async () => {
    const paths = getIdeasPaths();
    return {
      migrated: isIdeasMigrated(),
      legacyFile: paths.legacyFile,
      directory: paths.directory,
    };
  });
}
