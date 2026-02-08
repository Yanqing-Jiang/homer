import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join, basename } from "path";
import { createHash } from "crypto";
import YAML from "yaml";
import { logger } from "../utils/logger.js";

const MEMORY_PATH = process.env.MEMORY_PATH ?? "/Users/yj/memory";
const PLANS_DIR = join(MEMORY_PATH, "plans");

export interface ParsedTask {
  text: string;
  completed: boolean;
}

export interface ParsedPhase {
  name: string;
  status: "pending" | "in_progress" | "completed";
  tasks: ParsedTask[];
}

export interface ParsedPlan {
  id: string;               // Derived from filename (slug)
  title: string;
  status: string;           // 'planning' | 'execution' | 'completed'
  currentPhase: string | null;
  description: string | null;
  phases: ParsedPhase[];
  progress: number;         // 0.0 to 1.0
  totalTasks: number;
  completedTasks: number;
  filePath: string;
  contentHash: string;
  createdAt: string | null;
  updatedAt: string | null;
  sourceIdeaId?: string | null;
  tags?: string[];
}

function normalizeMetaString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function extractTitleFromBody(body: string): string | null {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1]?.trim() ?? null : null;
}

function parseFrontmatterBlock(content: string): { frontmatter: Record<string, unknown>; body: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  try {
    const frontmatter = (YAML.parse(match[1] ?? "") ?? {}) as Record<string, unknown>;
    const body = match[2] ?? "";
    return { frontmatter, body };
  } catch (error) {
    logger.warn({ error }, "Failed to parse plan frontmatter");
    return null;
  }
}

function extractLegacyHeader(content: string): { meta: Record<string, string>; title: string | null; body: string } {
  const lines = content.split("\n");
  let idx = 0;
  let title: string | null = null;

  if (lines[idx]?.startsWith("# ")) {
    title = lines[idx]?.slice(2).trim() ?? null;
    idx += 1;
  }

  const meta: Record<string, string> = {};
  while (idx < lines.length) {
    const line = lines[idx] ?? "";
    const match = line.match(/^\*\*(.+?):\*\*\s*(.*)$/);
    if (!match) break;
    const key = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? "").trim();
    meta[key] = value;
    idx += 1;
  }

  while (idx < lines.length && (lines[idx]?.trim() ?? "") === "") {
    idx += 1;
  }

  const body = lines.slice(idx).join("\n");
  return { meta, title, body };
}

function parsePlanBody(body: string, plan: Partial<ParsedPlan>): void {
  const lines = body.split("\n");
  let currentPhase: ParsedPhase | null = null;
  let inDescription = false;
  const descriptionLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (line.startsWith("# ")) {
      continue;
    }

    if (line.startsWith("## Description")) {
      inDescription = true;
      continue;
    }

    if (inDescription) {
      if (line.startsWith("## ")) {
        plan.description = descriptionLines.join("\n").trim();
        inDescription = false;
      } else {
        descriptionLines.push(line);
        continue;
      }
    }

    const phaseMatch = line.match(/^## (?:Phase \d+(?:\.\d+)?:\s*)?(.+)$/);
    if (phaseMatch && !line.toLowerCase().includes("description") && !line.toLowerCase().includes("feedback")) {
      if (currentPhase) {
        plan.phases!.push(currentPhase);
      }

      const phaseName = phaseMatch[1] ?? "";
      currentPhase = {
        name: phaseName,
        status: "pending",
        tasks: [],
      };

      if (plan.currentPhase && phaseName.toLowerCase().includes(plan.currentPhase.toLowerCase().replace(/phase \d+(?:\.\d+)?:\s*/i, ""))) {
        currentPhase.status = "in_progress";
      }
      continue;
    }

    if (currentPhase) {
      const taskMatch = line.match(/^[\s]*-\s*\[([ xX])\]\s*(.+)$/);
      if (taskMatch) {
        const completed = taskMatch[1]?.toLowerCase() === "x";
        const text = taskMatch[2] ?? "";
        currentPhase.tasks.push({ text, completed });
        plan.totalTasks = (plan.totalTasks ?? 0) + 1;
        if (completed) {
          plan.completedTasks = (plan.completedTasks ?? 0) + 1;
        }
      }
    }
  }

  if (currentPhase && currentPhase.tasks.length > 0) {
    plan.phases!.push(currentPhase);
  }

  if (inDescription && descriptionLines.length > 0) {
    plan.description = descriptionLines.join("\n").trim();
  }
}

/**
 * Parse a plan markdown file
 */
export function parsePlanFile(filePath: string): ParsedPlan | null {
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, "utf-8");
  const hash = createHash("md5").update(content).digest("hex");

  const plan: Partial<ParsedPlan> = {
    id: basename(filePath, ".md"),
    filePath,
    contentHash: hash,
    phases: [],
    totalTasks: 0,
    completedTasks: 0,
    description: null,
    currentPhase: null,
    status: "planning",
    createdAt: null,
    updatedAt: null,
  };

  const frontmatterBlock = parseFrontmatterBlock(content);
  if (frontmatterBlock) {
    const meta = frontmatterBlock.frontmatter;
    const metaId = normalizeMetaString(meta.id);
    if (metaId && metaId !== plan.id) {
      logger.warn({ filePath, metaId, fileId: plan.id }, "Plan frontmatter id does not match filename; using filename");
    }

    plan.title = normalizeMetaString(meta.title) ?? extractTitleFromBody(frontmatterBlock.body) ?? undefined;
    plan.status = normalizeMetaString(meta.status) ?? plan.status;
    plan.currentPhase = normalizeMetaString((meta as any).current_phase ?? (meta as any).currentPhase) ?? null;
    plan.createdAt = normalizeMetaString((meta as any).created ?? (meta as any).created_at ?? (meta as any).createdAt) ?? null;
    plan.updatedAt = normalizeMetaString((meta as any).updated ?? (meta as any).updated_at ?? (meta as any).updatedAt) ?? null;
    plan.sourceIdeaId = normalizeMetaString((meta as any).source_idea_id ?? (meta as any).sourceIdeaId) ?? null;

    if (Array.isArray((meta as any).tags)) {
      plan.tags = (meta as any).tags.map((t: unknown) => String(t));
    }

    parsePlanBody(frontmatterBlock.body ?? "", plan);
  } else {
    const legacy = extractLegacyHeader(content);
    plan.title = legacy.title ?? plan.title;
    plan.status = legacy.meta["status"] ?? plan.status;
    plan.currentPhase = legacy.meta["current phase"] ?? plan.currentPhase;
    plan.createdAt = legacy.meta["created"] ?? plan.createdAt;
    plan.updatedAt = legacy.meta["updated"] ?? plan.updatedAt;
    parsePlanBody(legacy.body, plan);
  }

  // Calculate progress
  if (plan.totalTasks && plan.totalTasks > 0) {
    plan.progress = (plan.completedTasks ?? 0) / plan.totalTasks;
  } else {
    plan.progress = 0;
  }

  // Update phase statuses based on tasks
  for (const phase of plan.phases ?? []) {
    if (phase.tasks.length === 0) {
      phase.status = "pending";
    } else if (phase.tasks.every((t) => t.completed)) {
      phase.status = "completed";
    } else if (phase.tasks.some((t) => t.completed)) {
      phase.status = "in_progress";
    }
  }

  if (!plan.title) {
    logger.warn({ filePath }, "Plan file missing title");
    return null;
  }

  return plan as ParsedPlan;
}

/**
 * Update task completion status in a plan file
 */
export function updatePlanTask(
  filePath: string,
  taskText: string,
  completed: boolean
): boolean {
  if (!existsSync(filePath)) return false;

  let content = readFileSync(filePath, "utf-8");
  const now = new Date().toISOString().split("T")[0];

  // Find and replace the task line
  const escapedText = taskText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^[\\s]*-\\s*\\[)[ xX](\\]\\s*${escapedText})$`, "m");

  const frontmatterBlock = parseFrontmatterBlock(content);
  if (frontmatterBlock) {
    let body = frontmatterBlock.body ?? "";

    if (!pattern.test(body)) {
      logger.warn({ filePath, taskText }, "Task not found in plan file");
      return false;
    }

    body = body.replace(pattern, `$1${completed ? "x" : " "}$2`);

    const frontmatter = frontmatterBlock.frontmatter ?? {};
    (frontmatter as Record<string, unknown>).updated = now;

    const yaml = YAML.stringify(frontmatter).trimEnd();
    const updatedContent = `---\n${yaml}\n---\n\n${body.trimStart()}`;
    writeFileSync(filePath, updatedContent.trimEnd() + "\n", "utf-8");
    return true;
  }

  if (!pattern.test(content)) {
    logger.warn({ filePath, taskText }, "Task not found in plan file");
    return false;
  }

  content = content.replace(pattern, `$1${completed ? "x" : " "}$2`);
  content = content.replace(/^\*\*Updated:\*\*.*$/m, `**Updated:** ${now}`);

  writeFileSync(filePath, content, "utf-8");
  return true;
}

/**
 * Load all plans from the plans directory
 */
export function loadPlansFromDir(): ParsedPlan[] {
  if (!existsSync(PLANS_DIR)) {
    return [];
  }

  const files = readdirSync(PLANS_DIR).filter((f) => f.endsWith(".md"));
  const plans: ParsedPlan[] = [];

  for (const file of files) {
    const plan = parsePlanFile(join(PLANS_DIR, file));
    if (plan) {
      plans.push(plan);
    }
  }

  return plans.sort((a, b) => {
    // Sort by status (execution first), then by updated date
    const statusOrder = { execution: 0, planning: 1, completed: 2 };
    const aOrder = statusOrder[a.status as keyof typeof statusOrder] ?? 1;
    const bOrder = statusOrder[b.status as keyof typeof statusOrder] ?? 1;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  });
}

/**
 * Get plans directory path
 */
export function getPlansPath(): string {
  return PLANS_DIR;
}

function readExistingPlanMeta(filePath: string): {
  id?: string;
  createdAt?: string | null;
  sourceIdeaId?: string | null;
  tags?: string[];
} {
  if (!existsSync(filePath)) return {};

  const content = readFileSync(filePath, "utf-8");
  const frontmatterBlock = parseFrontmatterBlock(content);
  if (frontmatterBlock) {
    const meta = frontmatterBlock.frontmatter ?? {};
    return {
      id: normalizeMetaString((meta as any).id) ?? basename(filePath, ".md"),
      createdAt: normalizeMetaString((meta as any).created ?? (meta as any).created_at ?? (meta as any).createdAt) ?? null,
      sourceIdeaId: normalizeMetaString((meta as any).source_idea_id ?? (meta as any).sourceIdeaId) ?? null,
      tags: Array.isArray((meta as any).tags) ? (meta as any).tags.map((t: unknown) => String(t)) : undefined,
    };
  }

  const legacy = extractLegacyHeader(content);
  return {
    id: basename(filePath, ".md"),
    createdAt: legacy.meta["created"] ?? null,
  };
}

/**
 * Save a plan to file (for full edits)
 */
export function savePlanFile(plan: {
  filePath: string;
  id?: string;
  title: string;
  description?: string | null;
  status?: string;
  currentPhase?: string | null;
  phases: ParsedPhase[];
  sourceIdeaId?: string | null;
  tags?: string[];
  createdAt?: string | null;
  updatedAt?: string | null;
}): void {
  const now = new Date().toISOString().split("T")[0];
  const existingMeta = readExistingPlanMeta(plan.filePath);
  const planId = plan.id ?? existingMeta.id ?? basename(plan.filePath, ".md");
  const createdAt = plan.createdAt ?? existingMeta.createdAt ?? now;
  const updatedAt = plan.updatedAt ?? now;
  const sourceIdeaId = plan.sourceIdeaId ?? existingMeta.sourceIdeaId ?? null;
  const tags = plan.tags ?? existingMeta.tags;

  const frontmatter: Record<string, unknown> = {
    id: planId,
    title: plan.title,
    status: plan.status || "planning",
    created: createdAt,
    updated: updatedAt,
  };

  if (plan.currentPhase) frontmatter.current_phase = plan.currentPhase;
  if (sourceIdeaId) frontmatter.source_idea_id = sourceIdeaId;
  if (tags && tags.length > 0) frontmatter.tags = tags;

  const yaml = YAML.stringify(frontmatter).trimEnd();

  let body = "";
  if (plan.description) {
    body += `## Description\n\n${plan.description}\n\n`;
  }

  for (let i = 0; i < plan.phases.length; i++) {
    const phase = plan.phases[i];
    if (!phase) continue;
    body += `## Phase ${i + 1}: ${phase.name}\n\n`;
    for (const task of phase.tasks) {
      body += `- [${task.completed ? "x" : " "}] ${task.text}\n`;
    }
    body += "\n";
  }

  const content = `---\n${yaml}\n---\n\n${body.trim()}\n`;
  writeFileSync(plan.filePath, content, "utf-8");
}
