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
  appendExploration,
  type ParsedIdea,
} from "../../ideas/parser.js";
import { join } from "path";

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

  // Explore idea (create exploration thread with context)
  server.post("/api/ideas/:id/explore", async (request: FastifyRequest, reply: FastifyReply) => {
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

    // Get full idea content
    const parsed = idea.filePath ? parseIdeaFile(idea.filePath) : null;
    if (!parsed) {
      reply.status(500);
      return { error: "Could not read idea file" };
    }

    // Check if already has linked exploration thread - allow resuming
    if (parsed.linkedExplorationThreadId) {
      // Check if thread still exists
      const existingThread = stateManager.getThread(parsed.linkedExplorationThreadId);
      if (existingThread) {
        return {
          sessionId: existingThread.chatSessionId,
          threadId: parsed.linkedExplorationThreadId,
          message: "Resuming existing exploration thread",
          resumed: true,
        };
      }
    }

    // Create a session and thread for exploring this idea
    const sessionId = randomUUID();
    stateManager.createChatSession({
      id: sessionId,
      name: `Explore: ${idea.title}`,
    });

    const threadId = randomUUID();
    stateManager.createThread({
      id: threadId,
      chatSessionId: sessionId,
      title: `Exploring: ${idea.title}`,
      provider: "claude",
    });

    // Build exploration system message
    const systemMessage = `# Exploration Context

You are helping explore and develop this idea into an actionable plan.

## Idea Details
**Title:** ${parsed.title}
**Content:** ${parsed.content}
${parsed.context ? `**Context:** ${parsed.context}` : ""}
${parsed.link ? `**Link:** ${parsed.link}` : ""}

## Your Role

Have a freeform conversation to understand this idea. Explore:
- Goals & Outcomes - What does success look like?
- Scope - What's in scope vs out of scope?
- Phases - How might this break down into phases?
- Resources - What's needed?
- Risks & Dependencies

When the user indicates they're ready ("ready", "create plan", "let's do it"),
generate a structured plan and offer to save it.`;

    // Add system message to thread
    stateManager.createThreadMessage({
      id: randomUUID(),
      threadId,
      role: "system",
      content: systemMessage,
    });

    // Link thread to idea
    stateManager.createThreadLink({
      threadId,
      linkType: "idea",
      linkId: id,
    });

    // Update idea with exploration thread link
    parsed.linkedExplorationThreadId = threadId;
    parsed.status = "exploring";
    saveIdeaFile(parsed);
    ideasIndexer.updateIdea(idea.filePath!);

    return {
      sessionId,
      threadId,
      message: "Exploration thread created",
      resumed: false,
    };
  });

  // Convert idea to plan
  interface CreatePlanBody {
    title: string;
    description?: string;
    phases?: Array<{
      name: string;
      tasks?: string[];
    }>;
    explorationSummary?: string;
  }

  server.post("/api/ideas/:id/plan", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as CreatePlanBody;

    if (!ideasIndexer) {
      reply.status(503);
      return { error: "Ideas indexer not initialized" };
    }

    const idea = ideasIndexer.get(id);
    if (!idea) {
      reply.status(404);
      return { error: "Idea not found" };
    }

    // Get full idea content
    const parsed = idea.filePath ? parseIdeaFile(idea.filePath) : null;
    if (!parsed) {
      reply.status(500);
      return { error: "Could not read idea file" };
    }

    // Use provided title or idea title
    const planTitle = body.title || parsed.title;
    const planDescription = body.description || parsed.content;

    // Create slug from title
    const slug = planTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    // Build plan file content
    const now = new Date().toISOString().split("T")[0];
    const MEMORY_PATH = process.env.MEMORY_PATH ?? "/Users/yj/memory";
    const PLANS_DIR = join(MEMORY_PATH, "plans");
    const planPath = join(PLANS_DIR, `${slug}.md`);

    let planContent = `# ${planTitle}

**Status:** planning
**Created:** ${now}
**Updated:** ${now}
**Source Idea:** ${parsed.id}
`;

    if (body.phases && body.phases.length > 0) {
      planContent += `**Current Phase:** ${body.phases[0]?.name || "Phase 1"}\n`;
    }

    planContent += `\n## Description\n\n${planDescription}\n`;

    // Add phases with tasks
    if (body.phases && body.phases.length > 0) {
      for (let i = 0; i < body.phases.length; i++) {
        const phase = body.phases[i];
        if (!phase) continue;
        planContent += `\n## Phase ${i + 1}: ${phase.name}\n\n`;
        if (phase.tasks && phase.tasks.length > 0) {
          for (const task of phase.tasks) {
            planContent += `- [ ] ${task}\n`;
          }
        } else {
          planContent += `- [ ] Define tasks for this phase\n`;
        }
      }
    } else {
      // Default phases if none provided
      planContent += `\n## Phase 1: Planning\n\n- [ ] Define detailed requirements\n- [ ] Identify resources needed\n`;
      planContent += `\n## Phase 2: Execution\n\n- [ ] Implement core functionality\n- [ ] Test and validate\n`;
      planContent += `\n## Phase 3: Review\n\n- [ ] Review outcomes\n- [ ] Document learnings\n`;
    }

    // Ensure plans directory exists
    const { mkdirSync, existsSync, writeFileSync } = await import("fs");
    if (!existsSync(PLANS_DIR)) {
      mkdirSync(PLANS_DIR, { recursive: true });
    }

    // Write plan file
    writeFileSync(planPath, planContent, "utf-8");

    // Append exploration summary to idea if provided
    if (body.explorationSummary && idea.filePath) {
      appendExploration(idea.filePath, `**Plan Created:** ${slug}\n\n${body.explorationSummary}`);
    }

    // Update idea status and link to plan
    const updatedParsed = parseIdeaFile(idea.filePath!);
    if (updatedParsed) {
      updatedParsed.status = "planning";
      updatedParsed.linkedPlanId = slug;
      saveIdeaFile(updatedParsed);
    }

    // Update index
    ideasIndexer.linkPlan(id, slug);
    ideasIndexer.updateIdea(idea.filePath!);

    reply.status(201);
    return {
      planId: slug,
      planPath,
      message: "Plan created successfully",
    };
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
