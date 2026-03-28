/**
 * Parse raw plan text (from Claude/Codex output) into a structured GeneratedPlan.
 * Handles various plan formats: "## Implementation Plan", "### Step N:", "### Phase N:", etc.
 */

import type { GeneratedPlan, PlanPhase } from "./review-types.js";

/**
 * Generate a plan ID from title and timestamp.
 */
function generatePlanId(title: string): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 30);
  return `plan_${date}_${slug}`;
}

/**
 * Extract risk level from plan text.
 */
function extractRiskLevel(text: string): "low" | "medium" | "high" {
  // Strip markdown bold/italic so "**Risk:** medium" becomes "Risk: medium"
  const lower = text.replace(/\*+/g, "").toLowerCase();
  if (/\b(high risk|risk:\s*high|🔴)\b/i.test(lower)) return "high";
  if (/\b(medium risk|risk:\s*medium|moderate risk|🟡)\b/i.test(lower)) return "medium";
  return "low";
}

/**
 * Extract file paths from plan text.
 */
function extractFiles(text: string): string[] {
  const files = new Set<string>();
  // Match src/... and similar paths
  const pathRegex = /(?:^|\s|`)((?:src|lib|test|packages)\/[\w./-]+\.(?:ts|js|sql|json|md))/gm;
  let match;
  while ((match = pathRegex.exec(text)) !== null) {
    files.add(match[1]!);
  }
  // Match **Files:** or **Files to Modify** sections
  const filesSection = text.match(/\*\*Files(?:\s+to\s+Modify)?[*:]*\*?\*?\s*\n((?:[-*]\s+.+\n?)+)/i);
  if (filesSection) {
    for (const line of filesSection[1]!.split("\n")) {
      const filePath = line.match(/[-*]\s+`?([^\s`]+\.\w+)`?/);
      if (filePath) files.add(filePath[1]!);
    }
  }
  return [...files].slice(0, 15);
}

/**
 * Extract risks from plan text.
 */
function extractRisks(text: string): string[] {
  const risks: string[] = [];
  // Look for risk sections
  const riskSection = text.match(/(?:##?\s*Risks?|##?\s*Risk Assessment)[^\n]*\n((?:[-*]\s+.+\n?)+)/i);
  if (riskSection) {
    for (const line of riskSection[1]!.split("\n")) {
      const risk = line.match(/[-*]\s+(.+)/);
      if (risk?.[1]?.trim()) risks.push(risk[1].trim());
    }
  }
  // Also check **Risk:** inline markers
  const inlineRisk = text.match(/\*\*Risk:\*\*\s*(.+)/i);
  if (inlineRisk?.[1] && risks.length === 0) {
    risks.push(inlineRisk[1].trim());
  }
  return risks.slice(0, 5);
}

/**
 * Parse phases from "### Step N:" or "### Phase N:" or numbered headers.
 */
function parsePhases(text: string): PlanPhase[] {
  const phases: PlanPhase[] = [];

  // Try "### Step N:" or "### Phase N:" patterns
  const phaseRegex = /###\s+(?:Step|Phase)\s+(\d+)[.:]\s*(.+?)(?=\n###\s+(?:Step|Phase)\s+\d+|\n##\s|\n\*\*Risk|\n\*\*Files|$)/gs;
  let match;
  while ((match = phaseRegex.exec(text)) !== null) {
    const header = match[2]!.trim();
    const body = match[0]!.slice(match[0]!.indexOf("\n") + 1);
    phases.push(parsePhaseBody(header, body));
  }

  if (phases.length > 0) return phases;

  // Try "**Phase N:**" or "**N.**" patterns
  const boldRegex = /\*\*(?:Phase\s+)?(\d+)[.):]\*?\*?\s*(.+?)(?=\n\*\*(?:Phase\s+)?\d+|\n##|\n\*\*Risk|$)/gs;
  while ((match = boldRegex.exec(text)) !== null) {
    const header = match[2]!.trim().replace(/\*\*/g, "");
    const body = match[0]!.slice(match[0]!.indexOf("\n") + 1);
    phases.push(parsePhaseBody(header, body));
  }

  if (phases.length > 0) return phases;

  // Fallback: treat entire plan as one phase
  const title = text.match(/##\s+Implementation Plan[:\s]*(.*)/i)?.[1]?.trim() || "Implementation";
  phases.push({
    name: title,
    summary: "See plan details",
    steps: extractBulletPoints(text).slice(0, 5),
    files: extractFiles(text).slice(0, 5),
  });

  return phases;
}

function parsePhaseBody(header: string, body: string): PlanPhase {
  // Split header into name and summary
  const parts = header.split(/\s*[—–-]\s*/);
  const name = (parts[0] ?? "").replace(/\*\*/g, "").trim();
  const summary = parts.slice(1).join(" — ").trim() || name;

  const steps = extractBulletPoints(body).slice(0, 6);
  const files = extractFiles(body).slice(0, 5);

  return { name, summary: summary.slice(0, 120), steps, files: files.length > 0 ? files : undefined };
}

function extractBulletPoints(text: string): string[] {
  const points: string[] = [];
  for (const line of text.split("\n")) {
    const bullet = line.match(/^\s*[-*]\s+(.+)/);
    if (bullet) {
      const clean = bullet[1]!.replace(/\*\*/g, "").replace(/`/g, "").trim();
      if (clean.length > 5 && clean.length < 200) points.push(clean);
    }
  }
  return points;
}

/**
 * Extract title from plan text.
 */
function extractTitle(text: string): string {
  // Try "## Implementation Plan" or "# Plan:" headers
  const header = text.match(/##?\s+(?:Implementation Plan[:\s]*)?(.+)/i);
  if (header) {
    const title = header[1]!.replace(/\*\*/g, "").trim();
    if (title && title.length > 3 && title.length < 150) return title;
  }
  // Try "### Description" section
  const desc = text.match(/###\s+Description\s*\n(.+)/i);
  if (desc) return desc[1]!.trim().slice(0, 100);
  // Fallback
  return "Implementation Plan";
}

/**
 * Extract one-line goal from plan text.
 */
function extractGoal(text: string): string {
  // First non-header paragraph after title
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("**") || trimmed.startsWith("-")) continue;
    if (trimmed.length > 20 && trimmed.length < 200) return trimmed;
  }
  return "See plan for details";
}

/**
 * Main entry: parse raw output text into a GeneratedPlan.
 */
export function parsePlanFromOutput(output: string, source = "scheduler-job"): GeneratedPlan {
  const title = extractTitle(output);
  return {
    id: generatePlanId(title),
    title,
    goal: extractGoal(output),
    riskLevel: extractRiskLevel(output),
    files: extractFiles(output),
    risks: extractRisks(output),
    phases: parsePhases(output),
    whyThisPlan: undefined,
    revisionNumber: 1,
    source,
    rawText: output,
  };
}
