import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import type { StateManager } from "../../state/manager.js";
import { PlansIndexer } from "../../plans/indexer.js";
import {
  parsePlanFile,
  updatePlanTask,
  savePlanFile,
  getPlansPath,
  type ParsedPhase,
} from "../../plans/parser.js";

let plansIndexer: PlansIndexer | null = null;

interface UpdateTaskBody {
  taskText: string;
  completed: boolean;
}

interface UpdatePlanBody {
  title?: string;
  description?: string;
  status?: string;
  currentPhase?: string;
  phases?: ParsedPhase[];
}

/**
 * Register plans API routes
 */
export function registerPlansRoutes(
  server: FastifyInstance,
  stateManager: StateManager
): void {
  // Initialize plans indexer
  plansIndexer = new PlansIndexer(stateManager.db);

  // Check if plans directory exists
  const plansDir = getPlansPath();
  if (existsSync(plansDir)) {
    plansIndexer.reindex();
    plansIndexer.startWatching();
  }

  // List plans
  server.get("/api/plans", async (request: FastifyRequest) => {
    const query = request.query as { status?: string; limit?: string };

    if (!plansIndexer) {
      return { plans: [] };
    }

    const plans = plansIndexer.list({
      status: query.status,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
    });

    // Enrich with phase data from files
    const enrichedPlans = plans.map((plan) => {
      const parsed = plan.filePath ? parsePlanFile(plan.filePath) : null;
      return {
        ...plan,
        phases: parsed?.phases || [],
      };
    });

    return { plans: enrichedPlans };
  });

  // Get single plan with full details
  server.get("/api/plans/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    if (!plansIndexer) {
      reply.status(503);
      return { error: "Plans indexer not initialized" };
    }

    const plan = plansIndexer.get(id);
    if (!plan) {
      reply.status(404);
      return { error: "Plan not found" };
    }

    // Get full content from file
    const parsed = plan.filePath ? parsePlanFile(plan.filePath) : null;
    const linkedThreads = stateManager.getLinkedThreads("plan", id);

    return {
      ...plan,
      phases: parsed?.phases || [],
      description: parsed?.description || null,
      threads: linkedThreads.map((threadId) => stateManager.getThread(threadId)).filter(Boolean),
    };
  });

  // Update plan (full edit)
  server.patch("/api/plans/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as UpdatePlanBody;

    if (!plansIndexer) {
      reply.status(503);
      return { error: "Plans indexer not initialized" };
    }

    const plan = plansIndexer.get(id);
    if (!plan) {
      reply.status(404);
      return { error: "Plan not found" };
    }

    // Get current plan data
    const parsed = plan.filePath ? parsePlanFile(plan.filePath) : null;
    if (!parsed) {
      reply.status(500);
      return { error: "Could not read plan file" };
    }

    // Apply updates
    savePlanFile({
      filePath: plan.filePath,
      title: body.title ?? parsed.title,
      description: body.description ?? parsed.description,
      status: body.status ?? parsed.status,
      currentPhase: body.currentPhase ?? parsed.currentPhase,
      phases: body.phases ?? parsed.phases,
    });

    // Reindex
    plansIndexer.updatePlan(plan.filePath);

    // Return updated plan
    const updated = plansIndexer.get(id);
    const updatedParsed = plan.filePath ? parsePlanFile(plan.filePath) : null;

    return {
      ...updated,
      phases: updatedParsed?.phases || [],
      description: updatedParsed?.description || null,
    };
  });

  // Toggle task completion
  server.patch("/api/plans/:id/task", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as UpdateTaskBody;

    if (!plansIndexer) {
      reply.status(503);
      return { error: "Plans indexer not initialized" };
    }

    const plan = plansIndexer.get(id);
    if (!plan) {
      reply.status(404);
      return { error: "Plan not found" };
    }

    if (!body.taskText) {
      reply.status(400);
      return { error: "taskText is required" };
    }

    // Update the file
    const updated = updatePlanTask(plan.filePath, body.taskText, body.completed);
    if (!updated) {
      reply.status(400);
      return { error: "Task not found in plan" };
    }

    // Reindex this plan
    plansIndexer.updatePlan(plan.filePath);

    // Return updated plan
    return plansIndexer.get(id);
  });

  // Create thread for working on a plan
  server.post("/api/plans/:id/work", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    if (!plansIndexer) {
      reply.status(503);
      return { error: "Plans indexer not initialized" };
    }

    const plan = plansIndexer.get(id);
    if (!plan) {
      reply.status(404);
      return { error: "Plan not found" };
    }

    // Get full plan content for context
    const parsed = plan.filePath ? parsePlanFile(plan.filePath) : null;
    if (!parsed) {
      reply.status(500);
      return { error: "Could not read plan file" };
    }

    // Create a session and thread
    const sessionId = randomUUID();
    stateManager.createChatSession({
      id: sessionId,
      name: `Work: ${plan.title}`,
    });

    const threadId = randomUUID();
    stateManager.createThread({
      id: threadId,
      chatSessionId: sessionId,
      title: `Working on: ${plan.title}`,
      provider: "claude",
    });

    // Link thread to plan
    stateManager.createThreadLink({
      threadId,
      linkType: "plan",
      linkId: id,
    });

    // Add plan context as system message
    const contextContent = buildPlanContext(parsed);
    stateManager.createThreadMessage({
      id: randomUUID(),
      threadId,
      role: "system",
      content: contextContent,
    });

    return {
      sessionId,
      threadId,
      message: "Work thread created with plan context",
    };
  });

  // Reindex plans
  server.post("/api/plans/reindex", async () => {
    if (!plansIndexer) {
      return { error: "Plans indexer not initialized", indexed: 0 };
    }

    const indexed = plansIndexer.reindex();
    return { indexed, message: "Reindex complete" };
  });
}

/**
 * Build context message from plan for thread
 */
function buildPlanContext(plan: {
  title: string;
  description: string | null;
  currentPhase: string | null;
  phases: Array<{ name: string; status: string; tasks: Array<{ text: string; completed: boolean }> }>;
}): string {
  let context = `# Plan Context: ${plan.title}\n\n`;

  if (plan.description) {
    context += `## Description\n${plan.description}\n\n`;
  }

  if (plan.currentPhase) {
    context += `## Current Phase\n${plan.currentPhase}\n\n`;
  }

  context += `## Tasks\n`;
  for (const phase of plan.phases) {
    context += `\n### ${phase.name} (${phase.status})\n`;
    for (const task of phase.tasks) {
      context += `- [${task.completed ? "x" : " "}] ${task.text}\n`;
    }
  }

  context += `\n---\n`;
  context += `You are helping work on this plan. Focus on the current phase and incomplete tasks.\n`;

  return context;
}
