/**
 * To-Dos web API.
 *
 *   GET    /api/todos                   — list (filters: status, category, priority, id)
 *   POST   /api/todos                   — create
 *   PATCH  /api/todos/:id               — update (status='archived' is soft-archive; status='done' completes)
 *   DELETE /api/todos/:id               — hard delete (irreversible; UI gates with a confirm popup)
 *   POST   /api/todos/:id/thread        — create chat session/thread linked to this todo
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "crypto";
import type { StateManager } from "../../state/manager.js";
import { saveTodo, getTodo, listTodos, hardDeleteTodo, type SaveTodoInput, type TodoFilter, type TodoRow } from "../../todos/dao.js";

export function registerTodosRoutes(server: FastifyInstance, stateManager: StateManager): void {
  // ── List ──────────────────────────────────────────────────────
  server.get("/api/todos", async (request: FastifyRequest) => {
    const q = request.query as {
      id?: string;
      status?: TodoFilter["status"];
      category?: TodoFilter["category"];
      priority?: TodoFilter["priority"];
      limit?: string;
      includeNotes?: string;
    };
    const todos = listTodos(stateManager.getDb(), {
      id: q.id,
      status: q.status,
      category: q.category,
      priority: q.priority,
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
      includeNotes: q.includeNotes !== "false",
    });
    return { todos };
  });

  // ── Create ────────────────────────────────────────────────────
  server.post("/api/todos", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as SaveTodoInput;
    if (!body || !body.title || body.title.trim().length === 0) {
      reply.status(400);
      return { error: "title is required" };
    }
    const todo = saveTodo(stateManager.getDb(), { ...body, id: undefined, source: body.source ?? "web" });
    return { todo };
  });

  // ── Update (patch) ────────────────────────────────────────────
  server.patch("/api/todos/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as SaveTodoInput;
    const todo = saveTodo(stateManager.getDb(), { ...body, id, source: body.source ?? "web" });
    if (!todo) {
      reply.status(404);
      return { error: "Todo not found" };
    }
    return { todo };
  });

  // ── Hard delete ───────────────────────────────────────────────
  // Irreversible. The UI requires an explicit confirm popup before calling this.
  server.delete("/api/todos/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const deleted = hardDeleteTodo(stateManager.getDb(), id);
    if (!deleted) {
      reply.status(404);
      return { error: "Todo not found" };
    }
    return { deleted: true, id };
  });

  // ── Start chat thread linked to this todo ─────────────────────
  server.post("/api/todos/:id/thread", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const todo = getTodo(stateManager.getDb(), id);
    if (!todo) {
      reply.status(404);
      return { error: "Todo not found" };
    }

    const sessionId = randomUUID();
    stateManager.createChatSession({ id: sessionId, name: `Work: ${todo.title}` });

    const threadId = randomUUID();
    stateManager.createThread({
      id: threadId,
      chatSessionId: sessionId,
      title: `Working on: ${todo.title}`,
      provider: "claude",
    });

    stateManager.createThreadLink({ threadId, linkType: "todo", linkId: todo.id });
    stateManager.createThreadMessage({
      id: randomUUID(),
      threadId,
      role: "system",
      content: buildTodoContext(todo),
    });

    // Persist the linked_thread_id on the todo so the UI shows the link.
    saveTodo(stateManager.getDb(), { id: todo.id, linkedThreadId: threadId, source: "web" });

    return { sessionId, threadId, todoId: todo.id };
  });
}

function buildTodoContext(t: TodoRow): string {
  const parts = [
    `# To-Do: ${t.title}`,
    "",
    `- Category: ${t.category === "W" ? "Work" : "Life"}`,
    `- Priority: ${t.priority}`,
    `- Status: ${t.status}`,
    "",
  ];
  if (t.notes && t.notes.length > 0) {
    parts.push("## Notes", "", t.notes, "");
  }
  parts.push("---", "You are helping Yanqing work through this to-do. Stay focused on what it asks.");
  return parts.join("\n");
}
