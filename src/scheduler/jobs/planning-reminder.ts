/**
 * Planning Reminder — Internal handler
 *
 * Reads plan files and pending review ideas, formats a status message.
 * Replaces the Claude CLI-based planning-reminder job.
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { loadIdeasFromDir } from "../../ideas/parser.js";
import { logger } from "../../utils/logger.js";
import { PATHS } from "../../config/paths.js";

const PLANS_DIR = PATHS.plans;

interface PlanStatus {
  title: string;
  status: string;
  currentPhase: string | null;
}

function parsePlanFrontmatter(filePath: string): PlanStatus | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;

    const fm = fmMatch[1] ?? "";
    let title = "";
    let status = "planning";
    let currentPhase: string | null = null;

    for (const line of fm.split("\n")) {
      const match = line.match(/^(\w+):\s*(.*)$/);
      if (!match) continue;
      const key = match[1]?.toLowerCase() ?? "";
      const value = match[2] ?? "";
      if (key === "title") title = value;
      if (key === "status") status = value;
      if (key === "currentphase") currentPhase = value;
    }

    if (!title) return null;
    return { title, status, currentPhase };
  } catch {
    return null;
  }
}

export async function runPlanningReminder(): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  try {
    const today = new Date().toISOString().slice(0, 10);

    // Read plans
    const plans: PlanStatus[] = [];
    if (existsSync(PLANS_DIR)) {
      const files = readdirSync(PLANS_DIR).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        const plan = parsePlanFrontmatter(join(PLANS_DIR, file));
        if (plan && plan.status !== "completed") {
          plans.push(plan);
        }
      }
    }

    // Count ideas in review
    const ideas = loadIdeasFromDir();
    const reviewIdeas = ideas.filter((i) => i.status === "review");

    // Format message
    const parts: string[] = [];
    parts.push(`Planning Status - ${today}`);
    parts.push("");

    if (plans.length > 0) {
      parts.push("Active Plans:");
      for (const plan of plans) {
        const phase = plan.currentPhase ? ` (${plan.currentPhase})` : "";
        parts.push(`- ${plan.title} [${plan.status}]${phase}`);
      }
    } else {
      parts.push("No active plans.");
    }

    parts.push("");

    if (reviewIdeas.length > 0) {
      parts.push(`Pending Decisions: ${reviewIdeas.length} idea${reviewIdeas.length > 1 ? "s" : ""} in review`);
    } else {
      parts.push("All clear! No pending decisions.");
    }

    const output = parts.join("\n");
    logger.info({ plans: plans.length, reviewIdeas: reviewIdeas.length }, "Planning reminder generated");

    return { success: true, output };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, "Planning reminder failed");
    return { success: false, output: "", error: msg };
  }
}
