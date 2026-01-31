import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join, basename } from "path";
import { createHash } from "crypto";
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
}

/**
 * Parse a plan markdown file
 */
export function parsePlanFile(filePath: string): ParsedPlan | null {
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, "utf-8");
  const hash = createHash("md5").update(content).digest("hex");
  const lines = content.split("\n");

  const plan: Partial<ParsedPlan> = {
    id: basename(filePath, ".md"),
    filePath,
    contentHash: hash,
    phases: [],
    totalTasks: 0,
    completedTasks: 0,
  };

  // Parse header metadata
  let currentPhase: ParsedPhase | null = null;
  let inDescription = false;
  let descriptionLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // Title (# Title)
    if (line.startsWith("# ") && !plan.title) {
      plan.title = line.slice(2).trim();
      continue;
    }

    // Metadata lines at top
    if (line.startsWith("**") && line.includes(":**")) {
      const match = line.match(/^\*\*(.+?):\*\*\s*(.*)$/);
      if (match) {
        const key = (match[1] ?? "").toLowerCase();
        const value = match[2] ?? "";
        switch (key) {
          case "created":
            plan.createdAt = value;
            break;
          case "updated":
            plan.updatedAt = value;
            break;
          case "status":
            plan.status = value;
            break;
          case "current phase":
            plan.currentPhase = value;
            break;
        }
      }
      continue;
    }

    // Description section
    if (line.startsWith("## Description")) {
      inDescription = true;
      continue;
    }

    if (inDescription) {
      // End of description at next ## heading
      if (line.startsWith("## ")) {
        plan.description = descriptionLines.join("\n").trim();
        inDescription = false;
      } else {
        descriptionLines.push(line);
        continue;
      }
    }

    // Phase header (## Phase N: Name or just ## Name)
    const phaseMatch = line.match(/^## (?:Phase \d+(?:\.\d+)?:\s*)?(.+)$/);
    if (phaseMatch && !line.toLowerCase().includes("description") && !line.toLowerCase().includes("feedback")) {
      // Save previous phase
      if (currentPhase) {
        plan.phases!.push(currentPhase);
      }

      const phaseName = phaseMatch[1] ?? "";
      currentPhase = {
        name: phaseName,
        status: "pending",
        tasks: [],
      };

      // Detect if this is the current phase
      if (plan.currentPhase && phaseName.toLowerCase().includes(plan.currentPhase.toLowerCase().replace(/phase \d+(?:\.\d+)?:\s*/i, ""))) {
        currentPhase.status = "in_progress";
      }
      continue;
    }

    // Task (- [ ] or - [x])
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

  // Save last phase
  if (currentPhase && currentPhase.tasks.length > 0) {
    plan.phases!.push(currentPhase);
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

  // Set description if we captured it but didn't save
  if (inDescription && descriptionLines.length > 0) {
    plan.description = descriptionLines.join("\n").trim();
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

  // Find and replace the task line
  const escapedText = taskText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^[\\s]*-\\s*\\[)[ xX](\\]\\s*${escapedText})$`, "m");

  if (!pattern.test(content)) {
    logger.warn({ filePath, taskText }, "Task not found in plan file");
    return false;
  }

  content = content.replace(pattern, `$1${completed ? "x" : " "}$2`);

  // Update the Updated timestamp
  const now = new Date().toISOString().split("T")[0];
  content = content.replace(
    /^\*\*Updated:\*\*.*$/m,
    `**Updated:** ${now}`
  );

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

/**
 * Save a plan to file (for full edits)
 */
export function savePlanFile(plan: {
  filePath: string;
  title: string;
  description?: string | null;
  status?: string;
  currentPhase?: string | null;
  phases: ParsedPhase[];
}): void {
  const now = new Date().toISOString().split("T")[0];

  let content = `# ${plan.title}\n\n`;
  content += `**Status:** ${plan.status || "planning"}\n`;

  // Try to preserve original created date
  if (existsSync(plan.filePath)) {
    const existing = readFileSync(plan.filePath, "utf-8");
    const createdMatch = existing.match(/^\*\*Created:\*\*\s*(.+)$/m);
    if (createdMatch) {
      content += `**Created:** ${createdMatch[1]}\n`;
    } else {
      content += `**Created:** ${now}\n`;
    }
  } else {
    content += `**Created:** ${now}\n`;
  }

  content += `**Updated:** ${now}\n`;

  if (plan.currentPhase) {
    content += `**Current Phase:** ${plan.currentPhase}\n`;
  }

  content += "\n";

  if (plan.description) {
    content += `## Description\n\n${plan.description}\n\n`;
  }

  for (let i = 0; i < plan.phases.length; i++) {
    const phase = plan.phases[i];
    if (!phase) continue;
    content += `## Phase ${i + 1}: ${phase.name}\n\n`;
    for (const task of phase.tasks) {
      content += `- [${task.completed ? "x" : " "}] ${task.text}\n`;
    }
    content += "\n";
  }

  writeFileSync(plan.filePath, content.trim() + "\n", "utf-8");
}
