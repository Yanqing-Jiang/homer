/**
 * Plan management tools: plan_create, plan_update, plan_list, plan_archive, plan_add_task
 */

import { existsSync } from "fs";
import { mkdir, rename } from "fs/promises";
import { savePlanFile, parsePlanFile, loadPlansFromDir, type ParsedPhase } from "../../plans/parser.js";
import { PATHS } from "../../config/paths.js";
import type { ToolResult, ToolDeps, ToolDefinition } from "./types.js";

const PLANS_DIR = PATHS.plans;

export const definitions: ToolDefinition[] = [
  {
    name: "plan_create",
    description: "Create a new plan file with YAML frontmatter and task checkboxes.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Plan title" },
        description: { type: "string", description: "Plan description and goals" },
        phases: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Phase name" },
              tasks: { type: "array", items: { type: "string" }, description: "Task descriptions for this phase" },
            },
            required: ["name", "tasks"],
          },
          description: "Phases with task lists",
        },
        status: { type: "string", enum: ["planning", "execution", "completed"], description: "Initial status (default: planning)" },
        ideaId: { type: "string", description: "ID of the source idea (optional)" },
      },
      required: ["title", "description"],
    },
  },
  {
    name: "plan_update",
    description: "Update a plan's status or phase.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Plan slug (filename without .md)" },
        status: { type: "string", enum: ["planning", "execution", "completed"], description: "New status" },
        currentPhase: { type: "string", description: "Current phase name" },
        notes: { type: "string", description: "Notes to append to feedback log" },
      },
      required: ["slug"],
    },
  },
  {
    name: "plan_list",
    description: "List all plans with their current status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "plan_archive",
    description: "Archive a completed plan. Sets status to 'completed' and moves to archive folder.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Plan slug (filename without .md)" },
      },
      required: ["slug"],
    },
  },
  {
    name: "plan_add_task",
    description: "Add a task to an existing plan phase. Creates the phase if it doesn't exist.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Plan slug (filename without .md)" },
        task: { type: "string", description: "Task text to add as a checkbox item" },
        phase: { type: "string", description: "Phase name (if omitted, adds to first phase)" },
      },
      required: ["slug", "task"],
    },
  },
];

export async function handle(
  name: string,
  args: Record<string, unknown>,
  _deps: ToolDeps
): Promise<ToolResult | null> {
  switch (name) {
    case "plan_create": {
      const { title, description, phases, status, ideaId } = args as {
        title: string; description: string; phases?: Array<{ name: string; tasks: string[] }>;
        status?: string; ideaId?: string;
      };
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const planPath = `${PLANS_DIR}/${slug}.md`;
      if (!existsSync(PLANS_DIR)) await mkdir(PLANS_DIR, { recursive: true });
      const parsedPhases: ParsedPhase[] = phases
        ? phases.map((p) => ({ name: p.name, status: "pending" as const, tasks: p.tasks.map((t) => ({ text: t, completed: false })) }))
        : [];
      const currentPhase = parsedPhases.length > 0 ? parsedPhases[0]!.name : null;
      savePlanFile({
        filePath: planPath, title, description: description || null,
        status: status || "planning", currentPhase, phases: parsedPhases, sourceIdeaId: ideaId || null,
      });
      return { content: [{ type: "text", text: `Created plan: ${title} (${planPath})` }] };
    }

    case "plan_update": {
      const { slug, status, currentPhase, notes } = args as {
        slug: string; status?: "planning" | "execution" | "completed"; currentPhase?: string; notes?: string;
      };
      const planPath = `${PLANS_DIR}/${slug}.md`;
      const parsed = parsePlanFile(planPath);
      if (!parsed) return { content: [{ type: "text", text: `Plan not found: ${slug}` }], isError: true };
      const updatedNotes = [...parsed.notes];
      if (notes) {
        const now = new Date().toISOString().slice(0, 10);
        updatedNotes.push({ date: now, content: notes });
      }
      savePlanFile({
        filePath: planPath, title: parsed.title, description: parsed.description,
        status: status || parsed.status, currentPhase: currentPhase || parsed.currentPhase,
        phases: parsed.phases, notes: updatedNotes, sourceIdeaId: parsed.sourceIdeaId,
        tags: parsed.tags, createdAt: parsed.createdAt,
      });
      return { content: [{ type: "text", text: `Updated plan: ${slug}` }] };
    }

    case "plan_list": {
      const plans = loadPlansFromDir();
      const summary = plans.map((p) => ({
        id: p.id, title: p.title, status: p.status, currentPhase: p.currentPhase || "Unknown",
        progress: `${p.completedTasks}/${p.totalTasks}`, createdAt: p.createdAt || "Unknown", updatedAt: p.updatedAt || "Unknown",
      }));
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }

    case "plan_archive": {
      const { slug } = args as { slug: string };
      const planPath = `${PLANS_DIR}/${slug}.md`;
      const archiveDir = `${PLANS_DIR}/archive`;
      const archivePath = `${archiveDir}/${slug}.md`;
      const parsed = parsePlanFile(planPath);
      if (!parsed) return { content: [{ type: "text", text: `Plan not found: ${slug}` }], isError: true };
      const now = new Date().toISOString().slice(0, 10);
      const archiveNotes = [...parsed.notes, { date: now, content: "Archived. Plan completed and moved to archive." }];
      savePlanFile({
        filePath: planPath, title: parsed.title, description: parsed.description,
        status: "completed", currentPhase: parsed.currentPhase, phases: parsed.phases,
        notes: archiveNotes, sourceIdeaId: parsed.sourceIdeaId, tags: parsed.tags, createdAt: parsed.createdAt,
      });
      await mkdir(archiveDir, { recursive: true });
      await rename(planPath, archivePath);
      return { content: [{ type: "text", text: `Archived plan: ${slug} → plans/archive/${slug}.md` }] };
    }

    case "plan_add_task": {
      const { slug, task, phase: phaseName } = args as { slug: string; task: string; phase?: string };
      const planPath = `${PLANS_DIR}/${slug}.md`;
      if (!existsSync(planPath)) return { content: [{ type: "text", text: `Plan not found: ${slug}` }], isError: true };
      const parsed = parsePlanFile(planPath);
      if (!parsed) return { content: [{ type: "text", text: `Failed to parse plan: ${slug}` }], isError: true };
      let targetPhase: ParsedPhase | undefined;
      if (phaseName) {
        targetPhase = parsed.phases.find((p) => p.name.toLowerCase() === phaseName.toLowerCase());
        if (!targetPhase) { targetPhase = { name: phaseName, status: "pending", tasks: [] }; parsed.phases.push(targetPhase); }
      } else {
        targetPhase = parsed.phases[0];
        if (!targetPhase) { targetPhase = { name: "Tasks", status: "pending", tasks: [] }; parsed.phases.push(targetPhase); }
      }
      targetPhase.tasks.push({ text: task, completed: false });
      savePlanFile({
        filePath: planPath, title: parsed.title, description: parsed.description,
        status: parsed.status, currentPhase: parsed.currentPhase, phases: parsed.phases,
        sourceIdeaId: parsed.sourceIdeaId, tags: parsed.tags, createdAt: parsed.createdAt,
      });
      return { content: [{ type: "text", text: `Added task to ${slug} (phase: ${targetPhase.name}): ${task}` }] };
    }

    default:
      return null;
  }
}
