/**
 * Idea management tools: idea_add, idea_update, idea_list
 */

import { type ParsedIdea } from "../../ideas/parser.js";
import * as ideaDao from "../../ideas/dao.js";
import type { ToolResult, ToolDeps, ToolDefinition } from "./types.js";

export const definitions: ToolDefinition[] = [
  {
    name: "idea_add",
    description: "Add a new idea to ideas.md with source and context.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the idea" },
        content: { type: "string", description: "Main content/description of the idea" },
        source: { type: "string", description: "Source of the idea (e.g., github-trending, bookmark, moltbot)" },
        context: { type: "string", description: "Why this is relevant (optional)" },
        link: { type: "string", description: "URL reference (optional)" },
      },
      required: ["title", "content", "source"],
    },
  },
  {
    name: "idea_update",
    description: "Update an existing idea's status or add notes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Idea ID (first 8 chars of UUID or timestamp)" },
        status: { type: "string", enum: ["draft", "review", "planning", "execution", "archived"], description: "New status for the idea" },
        notes: { type: "string", description: "Additional notes to add" },
      },
      required: ["id"],
    },
  },
  {
    name: "idea_list",
    description: "List ideas filtered by status.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["draft", "review", "planning", "execution", "archived", "all"], description: "Filter by status (default: draft)" },
      },
    },
  },
];

export async function handle(
  name: string,
  args: Record<string, unknown>,
  deps: ToolDeps
): Promise<ToolResult | null> {
  switch (name) {
    case "idea_add": {
      const { title, content, source, context, link } = args as {
        title: string; content: string; source: string; context?: string; link?: string;
      };
      const now = new Date();
      const timestamp = now.toISOString().slice(0, 16).replace("T", " ");
      const timestampId = `idea_${now.toISOString().replace(/[-:T]/g, "").slice(0, 12)}`;
      const idea: ParsedIdea = { id: timestampId, title, content, status: "draft", source, context, link, tags: [], timestamp };
      const sm = deps.getSharedStateManager();
      const saved = ideaDao.createIdea(sm.getDb(), idea);
      return { content: [{ type: "text", text: `Added idea: ${title} (ID: ${timestampId}, file: ${saved.filePath})` }] };
    }

    case "idea_update": {
      const { id, status, notes } = args as { id: string; status?: string; notes?: string };
      const sm = deps.getSharedStateManager();
      const existingIdea = ideaDao.getIdea(sm.getDb(), id);
      if (!existingIdea) return { content: [{ type: "text", text: `Idea not found: ${id}` }], isError: true };
      const updateFields: Partial<Pick<ParsedIdea, "status" | "notes">> = {};
      if (status) updateFields.status = status;
      if (notes) updateFields.notes = (existingIdea.notes ? existingIdea.notes + "; " : "") + notes;
      ideaDao.updateIdea(sm.getDb(), existingIdea.id, updateFields);
      return { content: [{ type: "text", text: `Updated idea: ${existingIdea.title} (status: ${status ?? existingIdea.status})` }] };
    }

    case "idea_list": {
      const { status } = args as { status?: string };
      const filterStatus = status || "draft";
      const sm = deps.getSharedStateManager();
      const ideas = filterStatus === "all"
        ? ideaDao.getAllIdeas(sm.getDb())
        : ideaDao.getAllIdeas(sm.getDb(), { status: filterStatus });
      if (ideas.length === 0) return { content: [{ type: "text", text: `No ideas with status: ${filterStatus}` }] };
      const summary = ideas.map(i => ({ id: i.id, title: i.title, source: i.source, status: i.status, timestamp: i.timestamp, filePath: i.filePath }));
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }

    default:
      return null;
  }
}
