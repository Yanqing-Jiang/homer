import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "crypto";
import type { StateManager } from "../../state/manager.js";
import {
  getIdeasPaths,
  isIdeasMigrated,
  type ParsedIdea,
} from "../../ideas/parser.js";
import * as dao from "../../ideas/dao.js";
import * as packetDao from "../../ideas/source-packets.js";
import * as discussionDao from "../../ideas/discussions.js";
import { recordFeedback } from "../../feedback/events.js";
import { webLane } from "../../utils/lanes.js";
import { getCurrentFocus } from "../../memory/session-bootstrap.js";

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

    // Load linked source packet for full context
    let packetContext = "";
    try {
      const row = db.prepare("SELECT source_packet_id FROM ideas WHERE id = ?").get(idea.id) as { source_packet_id: string | null } | undefined;
      if (row?.source_packet_id) {
        const packet = packetDao.getPacket(db, row.source_packet_id);
        if (packet) {
          const parts: string[] = [];
          if (packet.rawContent) parts.push(`## Original Source Content\n${packet.rawContent}`);
          if (packet.deepFetchContent) parts.push(`## Deep-Fetched Content\n${packet.deepFetchContent}`);
          if (packet.metadata?.externalUrls?.length) {
            parts.push(`## External Links\n${packet.metadata.externalUrls.join("\n")}`);
          }
          if (packet.metadata?.extractedTopics?.length) {
            parts.push(`## Extracted Topics\n${packet.metadata.extractedTopics.join(", ")}`);
          }
          if (packet.enrichment?.deepDive?.coreClaim) {
            parts.push(`## Core Claim\n${packet.enrichment.deepDive.coreClaim}`);
          }
          if (packet.enrichment?.deepLinks?.length) {
            parts.push(`## Connections\n${packet.enrichment.deepLinks.map((l: any) => `- ${l.target} (${l.relationship})`).join("\n")}`);
          }
          packetContext = parts.join("\n\n");
        }
      }
    } catch { /* best-effort packet loading */ }

    // System message — hidden from UI but included as anchor context for the model
    const enrichment = idea.enrichment ? JSON.parse(idea.enrichment) : null;

    // Pull current focus from the canonical session-bootstrap projection so paused
    // projects (MAHORAGA, Career OS automation) never leak into "Who Yanqing Is"
    // as if they were active. Falls back to a static line if parsing fails.
    let activeFocusLine = "Wedding planning, external job search, P&G analytics work, Homer automation";
    let pausedFocusLine = "MAHORAGA quant trading, Homer Career OS automation build-out";
    try {
      const focus = await getCurrentFocus();
      const activeBits = [
        ...focus.active.map((s) => s.split("—")[0]!.trim()),
        ...focus.activeProjects,
      ].filter(Boolean);
      if (activeBits.length > 0) activeFocusLine = activeBits.slice(0, 8).join(", ");
      const pausedBits = [
        ...focus.paused.map((s) => s.split("—")[0]!.trim()),
        ...focus.pausedProjects,
      ].filter(Boolean);
      if (pausedBits.length > 0) pausedFocusLine = pausedBits.slice(0, 6).join(", ");
    } catch { /* fall back to static defaults above */ }

    const systemMessage = `# Idea Exploration — ${idea.id}

You are Homer, helping Yanqing read and think through an idea before jumping to application. Idea ID: \`${idea.id}\`.

## Conversation Objective
Use a strict 3-phase flow:
1. Summary
2. Exploration
3. Extension

This order matters. Do not jump to Yanqing's goals, projects, career positioning, Homer capabilities, monetization, or content angles before Phase 3 unless Yanqing explicitly asks for that jump.

## Phase Rules

### Phase 1 — Summary
On your first substantive reply, summarize the source in the author's own framing.

Extract only the core idea:
- thesis or core claim
- key arguments, mechanisms, or structure
- evidence, examples, or reasoning used
- conclusion or implication in the source's own frame

Rules for Phase 1:
- NO connections to Yanqing's work, goals, projects, career, PICE, monetization, or Homer
- NO "what this means for you" section
- Stay faithful to the source's wording and logic when possible
- Distinguish source claims from your own inference if the material is incomplete, noisy, or ambiguous
- If the source is long, compress hard without losing the core argument
- If the source is short or fragmentary, say so directly and summarize only what is actually there

### Phase 2 — Exploration
After the summary, stay in pure idea exploration for the next 2-3 user turns by default.

In Phase 2:
- answer Yanqing's questions about the idea itself
- unpack assumptions, structure, tradeoffs, hidden premises, technical details, and counterarguments
- fill gaps in the reasoning and explain jargon when asked
- challenge weak evidence or missing steps if relevant

Still forbidden in Phase 2:
- linking to Yanqing's projects, goals, or personal context
- suggesting Homer features, workflows, or automations
- jumping to PICE, career, monetization, implementation ideas, or "what should I do with this?"

### Phase 3 — Extension
Only enter Phase 3 when at least one of these is true:
- Yanqing explicitly asks for application or connection, for example: "connect this", "how does this apply", "link to my work", "what can I do with this", "how should I use this", "how can Homer use this", "monetization angle", "career angle", "content angle", "PICE angle", "implementation ideas"
- Yanqing says "ready" or "create plan"
- After roughly 3 user turns of Phase 2, you may offer a transition in one short sentence, such as: "Want to connect this to your work or keep exploring the idea itself?" Do not transition automatically unless Yanqing accepts that move

In Phase 3, you may:
- connect the idea to Yanqing's goals, projects, and workflows
- use Homer capabilities, enrichment data, deep links, prior exploration notes, and source connections
- suggest applications, implementation paths, content angles, career positioning, or monetization
- generate a structured implementation plan when asked

## High-Priority Behavior
- Treat the "Who Yanqing Is" section, the "Homer Platform Capabilities" section, enrichment data, deep links, source-packet connections, and prior exploration notes as Phase 3-only context
- Keep that context available, but ignore it during Phases 1-2 unless Yanqing explicitly asks to connect the idea to his world
- If Yanqing immediately asks for connections or applications on the first user turn, skip directly to Phase 3
- If Yanqing says "ready" or "create plan", preserve the existing behavior and generate a structured implementation plan
- Be direct, structured, and concrete. Prefer clean bullets over fluffy prose
- When uncertain, clearly separate what the source says from what you are inferring

## Edge Cases
- Short ideas, tweets, and fragments: summarize the exact claim, note the missing evidence, and use Phase 2 to interrogate assumptions instead of inventing depth
- YouTube transcripts or messy source text: extract the real thesis, recurring arguments, and concrete examples while ignoring filler, ads, and transcript noise
- Conflicting or messy packet content: prioritize the clearest original claim, mention ambiguity, and avoid false precision
- Previous exploration notes can help with continuity, but do not surface prior recommendations or connections before Phase 3 unless Yanqing asks

## The Idea
**${idea.title}** (${idea.status})
${idea.link ? `**Link:** ${idea.link}` : ""}${idea.tags?.length ? `**Tags:** ${idea.tags.join(", ")}` : ""}

${packetContext || idea.content}
${!packetContext && idea.context ? `\n### Context\n${idea.context}` : ""}${idea.notes ? `\n### Notes\n${idea.notes}` : ""}${idea.exploration ? `\n### Previous Exploration\n${idea.exploration}` : ""}${enrichment ? `\n### Enrichment Data\n${JSON.stringify(enrichment, null, 2)}` : ""}

## Who Yanqing Is
- Senior Analytics Manager at P&G (Amazon Team), targeting $250K–$350K "Director of Agents" roles
- Building Homer: a personal AI operating system (Node.js/TypeScript daemon + multi-agent orchestration)
- Active focus: ${activeFocusLine}
- Paused (context only — do not prioritize): ${pausedFocusLine}
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
- **OpenClaw-Inspired:** Proposal/approval workflow for autonomous improvements — Homer generates improvement ideas, presents for human approval before execution`;

    stateManager.createThreadMessage({
      id: randomUUID(),
      threadId,
      role: "system",
      content: systemMessage,
    });

    // Greeting message — visible in chat UI as a lightweight conversation entry point
    const linkLine = idea.link ? `[Source](${idea.link})\n` : "";
    const greeting = `## ${idea.title}
${linkLine}
Phase 1 first: I'll summarize the source in its own framing before we connect it to your work.

Ask a question, challenge an assumption, or say "connect this" when you want to move into applications.`;

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

  // Promote an idea to a To-Do (replaces the legacy /:id/plan route).
  // Body shape kept compatible with the old plan-promotion call so old clients
  // can still call this endpoint; phases/tasks collapse into the todo notes body.
  interface PromoteTodoBody {
    title?: string;
    description?: string;
    category?: "W" | "L";
    priority?: "P1" | "P2" | "P3";
    phases?: Array<{ name: string; tasks?: string[] }>;
    explorationSummary?: string;
  }

  server.post("/api/ideas/:id/plan", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as PromoteTodoBody;

    const idea = dao.getIdea(db, id);
    if (!idea) {
      reply.status(404);
      return { error: "Idea not found" };
    }

    const title = body.title || idea.title;
    const description = body.description || idea.content || "";

    const notesParts: string[] = [];
    if (description) notesParts.push(description);
    if (body.phases && body.phases.length > 0) {
      const checklist: string[] = [];
      for (const phase of body.phases) {
        if (!phase) continue;
        checklist.push(`### ${phase.name}`);
        for (const task of phase.tasks ?? []) {
          checklist.push(`- [ ] ${task}`);
        }
      }
      if (checklist.length > 0) notesParts.push(checklist.join("\n"));
    }
    const notes = notesParts.join("\n\n");

    const { saveTodo } = await import("../../todos/dao.js");
    const todo = saveTodo(db, {
      title,
      notes,
      category: body.category ?? "W",
      priority: body.priority ?? "P2",
      source: "idea",
      sourceIdeaId: idea.id,
    });

    if (body.explorationSummary && todo) {
      dao.appendExplorationNotes(db, idea.id, `**Promoted to To-Do:** ${todo.id}\n\n${body.explorationSummary}`);
    }

    dao.updateIdea(db, idea.id, { status: "planning" });

    try {
      recordFeedback(db, {
        contentType: "idea",
        contentId: idea.id,
        action: "plan_create",
        source: "web_ui",
        delta: 0.2,
        metadata: { todoId: todo?.id },
      });
    } catch { /* best-effort */ }

    reply.status(201);
    return {
      // Legacy fields preserved so old clients keep working.
      planId: todo?.id,
      planPath: null,
      todoId: todo?.id,
      message: "Idea promoted to To-Do",
    };
  });

  // Reindex endpoint (deprecated — DAO is now the canonical write path; ideas table is source of truth).
  // Retained as a no-op for clients that still call it; returns current ideas count for sanity.
  server.post("/api/ideas/reindex", async () => {
    const count = dao.getAllIdeas(db).length;
    return { indexed: count, message: "Reindex is a no-op (DAO already keeps ideas table in sync)" };
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

  // ============================================
  // Source Packets API
  // ============================================

  // List source packets
  server.get("/api/packets", async (request: FastifyRequest) => {
    const query = request.query as { status?: string; limit?: string; source_type?: string };
    const statusFilter = query.status?.split(",") as packetDao.PacketStatus[] | undefined;

    const packets = packetDao.getPackets(db, {
      status: statusFilter && statusFilter.length === 1 ? statusFilter[0] : statusFilter as any,
      sourceType: query.source_type,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
    });

    return {
      packets: packets.map(p => ({
        id: p.id,
        clusterId: p.clusterId,
        sourceType: p.sourceType,
        primaryUrl: p.primaryUrl,
        title: p.title,
        summary: p.summary,
        status: p.status,
        promotedIdeaId: p.promotedIdeaId,
        enrichment: p.enrichment,
        metadata: p.metadata,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        reviewedAt: p.reviewedAt,
        promotedAt: p.promotedAt,
      })),
    };
  });

  // Get single packet with full content
  server.get("/api/packets/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const packet = packetDao.getPacket(db, id);
    if (!packet) {
      reply.status(404);
      return { error: "Packet not found" };
    }

    const scrapeIds = packetDao.getPacketScrapeIds(db, packet.id);
    const discussions = discussionDao.getDiscussions(db, { packetId: packet.id });

    return {
      ...packet,
      scrapeIds,
      discussions: discussions.map(d => ({
        id: d.id,
        title: d.title,
        status: d.status,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })),
    };
  });

  // Update packet status
  server.patch("/api/packets/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { status?: string; title?: string; summary?: string };

    const updated = packetDao.updatePacket(db, id, {
      status: body.status as packetDao.PacketStatus,
      title: body.title,
      summary: body.summary,
    });

    if (!updated) {
      reply.status(404);
      return { error: "Packet not found" };
    }

    return { id: updated.id, status: updated.status, title: updated.title };
  });

  // Promote packet to idea
  server.post("/api/packets/:id/promote", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { title?: string; content?: string; tags?: string[] } | undefined;

    const result = packetDao.promotePacket(db, id, body);
    if (!result) {
      reply.status(400);
      return { error: "Failed to promote packet" };
    }

    return {
      packetId: result.packetId,
      ideaId: result.ideaId,
      message: "Packet promoted to idea",
    };
  });

  // Get packet stats
  server.get("/api/packets/stats", async () => {
    return packetDao.countByStatus(db);
  });

  // Search packets
  server.get("/api/packets/search", async (request: FastifyRequest) => {
    const { q, limit } = request.query as { q?: string; limit?: string };
    if (!q) return { packets: [] };

    const packets = packetDao.searchPackets(db, q, limit ? parseInt(limit, 10) : 10);
    return {
      packets: packets.map(p => ({
        id: p.id,
        title: p.title,
        summary: p.summary,
        status: p.status,
        sourceType: p.sourceType,
        createdAt: p.createdAt,
      })),
    };
  });

  // ============================================
  // Discussions API
  // ============================================

  // List discussions
  server.get("/api/discussions", async (request: FastifyRequest) => {
    const query = request.query as { status?: string; packet_id?: string; idea_id?: string; limit?: string };

    const discussions = discussionDao.getDiscussions(db, {
      status: query.status as discussionDao.DiscussionStatus,
      packetId: query.packet_id,
      ideaId: query.idea_id,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
    });

    return { discussions };
  });

  // Get discussion with messages
  server.get("/api/discussions/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const discussion = discussionDao.getDiscussionWithMessages(db, id);
    if (!discussion) {
      reply.status(404);
      return { error: "Discussion not found" };
    }
    return discussion;
  });

  // Create or resume discussion
  server.post("/api/discussions", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { packetId?: string; ideaId?: string; title?: string };

    const discussion = discussionDao.getOrCreateDiscussion(db, {
      packetId: body.packetId,
      ideaId: body.ideaId,
      title: body.title,
    });

    reply.status(201);
    return discussion;
  });

  // Add message to discussion
  server.post("/api/discussions/:id/messages", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { role?: string; content: string; metadata?: Record<string, unknown> };

    const discussion = discussionDao.getDiscussion(db, id);
    if (!discussion) {
      reply.status(404);
      return { error: "Discussion not found" };
    }

    const message = discussionDao.addMessage(db, {
      discussionId: id,
      role: (body.role as discussionDao.MessageRole) ?? "user",
      content: body.content,
      metadata: body.metadata,
    });

    reply.status(201);
    return message;
  });

  // Update discussion status
  server.patch("/api/discussions/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { status?: string; title?: string };

    const updated = discussionDao.updateDiscussion(db, id, {
      status: body.status as discussionDao.DiscussionStatus,
      title: body.title,
    });

    if (!updated) {
      reply.status(404);
      return { error: "Discussion not found" };
    }

    return updated;
  });
}
