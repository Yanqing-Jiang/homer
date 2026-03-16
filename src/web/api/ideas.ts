import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "crypto";
import type { StateManager } from "../../state/manager.js";
import { IdeasIndexer } from "../../ideas/indexer.js";
import {
  getIdeasPaths,
  isIdeasMigrated,
  type ParsedIdea,
} from "../../ideas/parser.js";
import * as dao from "../../ideas/dao.js";
import { join } from "path";
import { recordFeedback } from "../../feedback/events.js";
import { PATHS } from "../../config/paths.js";
import { webLane } from "../../utils/lanes.js";

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
  const db = stateManager.db;

  // Initialize ideas indexer (backward compat — chokidar watcher kept for now)
  ideasIndexer = new IdeasIndexer(db);
  if (isIdeasMigrated()) {
    ideasIndexer.reindex();
    ideasIndexer.startWatching();
  }

  // List ideas
  server.get("/api/ideas", async (request: FastifyRequest) => {
    const query = request.query as { status?: string; limit?: string };

    const ideas = dao.getAllIdeas(db, {
      status: query.status,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
    });

    return {
      ideas: ideas.map((idea) => ({
        id: idea.id,
        title: idea.title,
        status: idea.status,
        source: idea.source,
        tags: idea.tags ?? [],
        content: idea.content || "",
        context: idea.context || null,
        notes: idea.notes || null,
        link: idea.link || null,
        filePath: idea.filePath || null,
        contentHash: idea.contentHash || null,
        createdAt: idea.timestamp || null,
        linkedThreadId: idea.linkedExplorationThreadId || null,
        linkedExplorationThreadId: idea.linkedExplorationThreadId || null,
        linkedPlanId: idea.linkedPlanId || null,
        exploration: idea.exploration || null,
      })),
      migrated: true,
    };
  });

  // Get single idea
  server.get("/api/ideas/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const idea = dao.getIdea(db, id);
    if (!idea) {
      reply.status(404);
      return { error: "Idea not found" };
    }

    const linkedThread = idea.linkedExplorationThreadId
      ? stateManager.getThread(idea.linkedExplorationThreadId)
      : null;

    return {
      id: idea.id,
      title: idea.title,
      status: idea.status,
      source: idea.source,
      tags: idea.tags ?? [],
      content: idea.content || "",
      context: idea.context || null,
      notes: idea.notes || null,
      link: idea.link || null,
      filePath: idea.filePath || null,
      contentHash: idea.contentHash || null,
      createdAt: idea.timestamp || null,
      linkedThreadId: idea.linkedExplorationThreadId || null,
      linkedPlanId: idea.linkedPlanId || null,
      thread: linkedThread,
    };
  });

  // Update idea
  server.patch("/api/ideas/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as UpdateIdeaBody;

    const existing = dao.getIdea(db, id);
    if (!existing) {
      reply.status(404);
      return { error: "Idea not found" };
    }

    const updated = dao.updateIdea(db, existing.id, {
      status: body.status,
      title: body.title,
      notes: body.notes !== undefined
        ? (existing.notes ? `${existing.notes}; ${body.notes}` : body.notes)
        : undefined,
      content: body.content,
      context: body.context,
      tags: body.tags,
      link: body.link,
    });

    if (!updated) {
      reply.status(500);
      return { error: "Failed to update idea" };
    }

    // Record feedback on status change
    if (body.status && body.status !== existing.status) {
      const statusDeltaMap: Record<string, number> = {
        archived: -0.1,
        planning: 0.15,
        execution: 0.2,
      };
      try {
        recordFeedback(db, {
          contentType: "idea",
          contentId: existing.id,
          action: "status_change",
          source: "web_ui",
          delta: statusDeltaMap[body.status] ?? 0,
          metadata: { from: existing.status, to: body.status },
        });
      } catch { /* best-effort */ }
    }

    return {
      id: updated.id,
      title: updated.title,
      status: updated.status,
      source: updated.source,
      tags: updated.tags ?? [],
      content: updated.content || "",
      context: updated.context || null,
      notes: updated.notes || null,
      link: updated.link || null,
      createdAt: updated.timestamp || null,
      linkedThreadId: updated.linkedExplorationThreadId || null,
      linkedExplorationThreadId: updated.linkedExplorationThreadId || null,
      linkedPlanId: updated.linkedPlanId || null,
      exploration: updated.exploration || null,
    };
  });

  // Delete idea
  server.delete("/api/ideas/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const deleted = dao.deleteIdea(db, id);
    if (!deleted) {
      reply.status(404);
      return { error: "Idea not found" };
    }

    try {
      recordFeedback(db, {
        contentType: "idea",
        contentId: id,
        action: "delete",
        source: "web_ui",
        delta: -0.15,
      });
    } catch { /* best-effort */ }

    return { deleted: true, id };
  });

  // Create idea
  server.post("/api/ideas", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as CreateIdeaBody;

    if (!body.title || !body.content) {
      reply.status(400);
      return { error: "title and content are required" };
    }

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

    const saved = dao.createIdea(db, idea);

    reply.status(201);
    return { id: saved.id, filePath: saved.filePath };
  });

  // Research idea (create linked thread)
  server.post("/api/ideas/:id/research", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const idea = dao.getIdea(db, id);
    if (!idea) {
      reply.status(404);
      return { error: "Idea not found" };
    }

    // Check if already has linked thread
    if (idea.linkedExplorationThreadId) {
      return {
        threadId: idea.linkedExplorationThreadId,
        message: "Idea already has a linked thread",
      };
    }

    // Create a session and thread
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

    stateManager.createThreadLink({
      threadId,
      linkType: "idea",
      linkId: idea.id,
    });

    // Update idea
    dao.updateIdea(db, idea.id, {
      status: "researching",
      linkedExplorationThreadId: threadId,
    });

    try {
      recordFeedback(db, {
        contentType: "idea",
        contentId: idea.id,
        action: "research",
        source: "web_ui",
        delta: 0.15,
      });
    } catch { /* best-effort */ }

    return {
      sessionId,
      threadId,
      message: "Research thread created",
    };
  });

  // Explore idea
  server.post("/api/ideas/:id/explore", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    const idea = dao.getIdea(db, id);
    if (!idea) {
      reply.status(404);
      return { error: "Idea not found" };
    }

    // Check if already has linked exploration thread - allow resuming
    if (idea.linkedExplorationThreadId) {
      const existingThread = stateManager.getThread(idea.linkedExplorationThreadId);
      if (existingThread) {
        return {
          sessionId: existingThread.chatSessionId,
          threadId: idea.linkedExplorationThreadId,
          message: "Resuming existing exploration thread",
          resumed: true,
        };
      }
    }

    const sessionId = randomUUID();
    stateManager.createChatSession({
      id: sessionId,
      name: `Idea Explorer: ${idea.title}`,
    });

    const threadId = randomUUID();
    stateManager.createThread({
      id: threadId,
      chatSessionId: sessionId,
      title: `Idea Explorer: ${idea.title}`,
      provider: "claude",
      model: "sonnet[1m]",
    });

    // Set executor to Sonnet for this session's lane
    const lane = webLane(sessionId);
    stateManager.setCurrentExecutor(lane, "claude", "sonnet[1m]");

    // System message — hidden from UI but included as anchor context for the model
    const enrichment = idea.enrichment ? JSON.parse(idea.enrichment) : null;
    const systemMessage = `# Idea Exploration — ${idea.id}

You are Homer, helping Yanqing explore and develop this idea. Idea ID: \`${idea.id}\`.

## Who Yanqing Is
- Senior Analytics Manager at P&G (Amazon Team), targeting $250K–$350K "Director of Agents" roles
- Building Homer: a personal AI operating system (Node.js/TypeScript daemon + multi-agent orchestration)
- Active projects: Shadow Data Pulse (DuckDB analytics), ProfitSphere ($100MM+ chargeback prevention), MAHORAGA (quant trading), Career OS (job automation), PICE (content engine — 2 posts/week)
- Content strategy: LinkedIn/Medium thought leadership on multi-agent systems, intent engineering, harness engineering
- Preferences: direct, actionable, no fluff. Bullet points > paragraphs. Systems thinking > point solutions.

## Homer Platform Capabilities
Homer is a macOS launchd daemon (Node.js/TypeScript, SQLite 122 tables) with these interfaces:
- **Telegram Bot:** grammY-based — text, voice, approvals, plans, ideas, overnight summaries, reminders, search
- **Web UI:** Fastify :3000 — chat sessions, idea explorer, plan manager, job dashboard, meeting viewer, trading dashboard. Served via Azure Blob Storage + Cloudflare tunnel
- **Phone/Voice:** ElevenLabs TTS/STT, Twilio SMS webhooks, WebSocket voice gateway for real-time conversation
- **MCP Server:** stdio process sharing SQLite — exposes memory, ideas, plans, blobs, sessions, meetings to Claude Code
- **Multi-Executor Orchestration:** Claude (primary) → Codex → Kimi → Gemini fallback chain. Resumable sessions, process registry, timeout enforcement
- **Scheduler:** 28 cron jobs + 3 system jobs — idea pipeline (ingest→deep-link→synthesize→dedup→review), memory pipeline (harvest→promote→embed→reindex), content scraping, morning briefs, nightly code push
- **Idea Pipeline:** Link inbox → content scraping → deep-linker enrichment → synthesizer → dedup → Telegram review → explore/plan. Sources: GitHub trending, X bookmarks, YouTube, Medium, manual
- **Memory System:** 3-tier (canonical files, session summaries, embeddings). FTS5 + vector hybrid search. Nightly promotion, weekly consolidation
- **Career OS:** Stagehand browser agents for job auto-submission, hr-breaker resume optimization
- **MAHORAGA Trading:** IBKR paper trading, regime filters (MA+TSMOM), circuit breakers, veto consensus
- **Docker:** Containerized services monitored by watchdog with layered recovery
- **OpenClaw-Inspired:** Proposal/approval workflow for autonomous improvements — Homer generates improvement ideas, presents for human approval before execution

When exploring ideas, consider which Homer capabilities could be leveraged or extended.

## The Idea
**${idea.title}** (${idea.status})
${idea.link ? `**Link:** ${idea.link}` : ""}${idea.tags?.length ? `**Tags:** ${idea.tags.join(", ")}` : ""}

${idea.content}
${idea.context ? `\n### Context\n${idea.context}` : ""}${idea.notes ? `\n### Notes\n${idea.notes}` : ""}${idea.exploration ? `\n### Previous Exploration\n${idea.exploration}` : ""}${enrichment ? `\n### Enrichment Data\n${JSON.stringify(enrichment, null, 2)}` : ""}

## Your Role
1. On first message, provide 2-3 sharp insights connecting this idea to Yanqing's goals/projects and Homer's capabilities
2. Explore through conversation: actionable angles, scope, effort estimate, risks
3. Always think about: content angle (PICE), career angle (Director of Agents), Homer integration angle, monetization angle
4. When Yanqing says "ready" or "create plan", generate a structured implementation plan
5. Be opinionated — recommend what to do, not just list options`;

    stateManager.createThreadMessage({
      id: randomUUID(),
      threadId,
      role: "system",
      content: systemMessage,
    });

    // Greeting message — visible in chat UI showing the full idea content
    const tagLine = idea.tags?.length ? `*${idea.tags.join(" · ")}*\n` : "";
    const linkLine = idea.link ? `[Source](${idea.link})\n` : "";
    const notesLine = idea.notes ? `\n**Notes:** ${idea.notes}` : "";
    const enrichmentSummary = enrichment?.deep_links
      ? `\n\n**Connections:** ${(enrichment.deep_links as string[]).slice(0, 3).join(" · ")}`
      : "";
    const greeting = `## ${idea.title}
${tagLine}${linkLine}
${idea.content}${notesLine}${enrichmentSummary}

---
Send a message to start exploring — I'll kick off with insights on how this connects to your current work.`;

    stateManager.createThreadMessage({
      id: randomUUID(),
      threadId,
      role: "assistant",
      content: greeting,
    });

    stateManager.createThreadLink({
      threadId,
      linkType: "idea",
      linkId: idea.id,
    });

    dao.updateIdea(db, idea.id, {
      status: "exploring",
      linkedExplorationThreadId: threadId,
    });

    try {
      recordFeedback(db, {
        contentType: "idea",
        contentId: idea.id,
        action: "explore",
        source: "web_ui",
        delta: 0.15,
      });
    } catch { /* best-effort */ }

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

    const idea = dao.getIdea(db, id);
    if (!idea) {
      reply.status(404);
      return { error: "Idea not found" };
    }

    const planTitle = body.title || idea.title;
    const planDescription = body.description || idea.content;

    const slug = planTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    const now = new Date().toISOString().split("T")[0];
    const PLANS_DIR = PATHS.plans;
    const planPath = join(PLANS_DIR, `${slug}.md`);

    let planContent = `# ${planTitle}

**Status:** planning
**Created:** ${now}
**Updated:** ${now}
**Source Idea:** ${idea.id}
`;

    if (body.phases && body.phases.length > 0) {
      planContent += `**Current Phase:** ${body.phases[0]?.name || "Phase 1"}\n`;
    }

    planContent += `\n## Description\n\n${planDescription}\n`;

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
      planContent += `\n## Phase 1: Planning\n\n- [ ] Define detailed requirements\n- [ ] Identify resources needed\n`;
      planContent += `\n## Phase 2: Execution\n\n- [ ] Implement core functionality\n- [ ] Test and validate\n`;
      planContent += `\n## Phase 3: Review\n\n- [ ] Review outcomes\n- [ ] Document learnings\n`;
    }

    const { mkdirSync, existsSync, writeFileSync } = await import("fs");
    if (!existsSync(PLANS_DIR)) {
      mkdirSync(PLANS_DIR, { recursive: true });
    }
    writeFileSync(planPath, planContent, "utf-8");

    // Append exploration summary
    if (body.explorationSummary) {
      dao.appendExplorationNotes(db, idea.id, `**Plan Created:** ${slug}\n\n${body.explorationSummary}`);
    }

    // Update idea status and link to plan
    dao.updateIdea(db, idea.id, {
      status: "planning",
      linkedPlanId: slug,
    });

    try {
      recordFeedback(db, {
        contentType: "idea",
        contentId: idea.id,
        action: "plan_create",
        source: "web_ui",
        delta: 0.2,
        metadata: { planId: slug },
      });
    } catch { /* best-effort */ }

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
