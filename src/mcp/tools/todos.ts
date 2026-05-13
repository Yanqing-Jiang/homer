/**
 * Todo MCP tools — slim surface for CLI/agent use.
 *
 *  todo_save      — create or update a todo (id present = patch, absent = create)
 *  todo_list      — read; supports id, status, category, priority filters
 *  todo_start_chat — create a thread/session linked to a todo (returns ids)
 *
 * Completion, archival, and thread linking are all flavors of `todo_save`:
 *  - Complete: todo_save({ id, status: "done", appendNotes: "## Completed ...\n..." })
 *  - Archive:  todo_save({ id, status: "archived" })
 *  - Link an existing thread: todo_save({ id, linkedThreadId })
 *
 * Only todo_start_chat is separate because it creates rows outside todo_index
 * (chat_sessions, threads, thread_messages, thread_links).
 */

import { randomUUID } from "crypto";
import { saveTodo, getTodo, listTodos, type SaveTodoInput, type TodoFilter, type TodoRow } from "../../todos/dao.js";
import type { ToolResult, ToolDeps, ToolDefinition } from "./types.js";

export const definitions: ToolDefinition[] = [
  {
    name: "todo_save",
    description:
      "Create or update a To-Do. Omit `id` to create (title required); pass `id` to patch. " +
      "Set `status` to 'done' or 'archived' to complete/archive. Use `appendNotes` to append to existing notes " +
      "(useful for a completion note). Pass `linkedThreadId` to link an existing thread.",
    inputSchema: {
      type: "object",
      properties: {
        id:              { type: "string", description: "Existing todo id (patch mode). Omit to create." },
        title:           { type: "string", description: "Title (required on create)." },
        status:          { type: "string", enum: ["open", "done", "archived"] },
        category:        { type: "string", enum: ["W", "L"], description: "W = Work, L = Life. Default W." },
        priority:        { type: "string", enum: ["P1", "P2", "P3"], description: "P1 urgent, P2 soon, P3 later (default)." },
        notes:           { type: "string", description: "Full notes body (replaces existing). Use appendNotes to append." },
        appendNotes:     { type: "string", description: "Append this to the existing notes with a blank line in front." },
        sourceIdeaId:    { type: "string", description: "If this todo was promoted from an idea, the idea id." },
        linkedThreadId:  { type: "string", description: "Existing thread id to link." },
      },
    },
  },
  {
    name: "todo_list",
    description:
      "List To-Dos. Default returns open todos sorted by priority then most-recently-updated. " +
      "Pass `id` to fetch a single todo (including its full notes).",
    inputSchema: {
      type: "object",
      properties: {
        id:           { type: "string", description: "Fetch a single todo by id (or prefix)." },
        status:       { type: "string", enum: ["open", "done", "archived", "all"], description: "Default: open" },
        category:     { type: "string", enum: ["W", "L"] },
        priority:     { type: "string", enum: ["P1", "P2", "P3"] },
        limit:        { type: "number", description: "Default 100." },
        includeNotes: { type: "boolean", description: "Default true." },
      },
    },
  },
  {
    name: "todo_start_chat",
    description:
      "Create a chat session + thread linked to a To-Do. Returns sessionId and threadId. " +
      "The thread is seeded with a system message containing the todo's title, category, priority, and notes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Todo id (or prefix)." },
      },
      required: ["id"],
    },
  },
];

export async function handle(
  name: string,
  args: Record<string, unknown>,
  deps: ToolDeps,
): Promise<ToolResult | null> {
  switch (name) {
    case "todo_save": {
      const input = args as SaveTodoInput;
      const sm = deps.getSharedStateManager();
      // Set source = 'mcp' unless the caller explicitly overrode it.
      const result = saveTodo(sm.getDb(), { ...input, source: input.source ?? "mcp" });
      if (input.id && !result) {
        return { content: [{ type: "text", text: `Todo not found: ${input.id}` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    case "todo_list": {
      const filter = args as TodoFilter;
      const sm = deps.getSharedStateManager();
      const todos = listTodos(sm.getDb(), filter);
      const summary = todos.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        category: t.category,
        priority: t.priority,
        updated_at: t.updated_at,
        notes: filter.includeNotes !== false ? t.notes : undefined,
      }));
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }

    case "todo_start_chat": {
      const { id } = args as { id: string };
      const sm = deps.getSharedStateManager();
      const todo = getTodo(sm.getDb(), id);
      if (!todo) return { content: [{ type: "text", text: `Todo not found: ${id}` }], isError: true };

      const sessionId = randomUUID();
      sm.createChatSession({ id: sessionId, name: `Work: ${todo.title}` });

      const threadId = randomUUID();
      sm.createThread({
        id: threadId,
        chatSessionId: sessionId,
        title: `Working on: ${todo.title}`,
        provider: "claude",
      });

      sm.createThreadLink({ threadId, linkType: "todo", linkId: todo.id });
      sm.createThreadMessage({
        id: randomUUID(),
        threadId,
        role: "system",
        content: buildTodoContext(todo),
      });

      // Persist the linked_thread_id on the todo for the UI / DAO.
      saveTodo(sm.getDb(), { id: todo.id, linkedThreadId: threadId });

      return {
        content: [{ type: "text", text: JSON.stringify({ sessionId, threadId, todoId: todo.id }, null, 2) }],
      };
    }

    default:
      return null;
  }
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
