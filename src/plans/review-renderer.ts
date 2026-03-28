/**
 * Render GeneratedPlan objects as Telegram HTML cards.
 * Follows the morning idea packet pattern: scannable on mobile, decision-ready.
 */

import { escapeHtml } from "../utils/telegram-format.js";
import type { GeneratedPlan } from "./review-types.js";

const SUMMARY_HARD_CAP = 2500;
const DETAIL_HARD_CAP = 3800;

const RISK_EMOJI: Record<string, string> = {
  low: "🟢",
  medium: "🟡",
  high: "🔴",
};

/**
 * Render the main plan review card (summary). Stays under 2500 chars.
 */
export function renderPlanCard(plan: GeneratedPlan): string {
  const parts: string[] = [];
  const risk = RISK_EMOJI[plan.riskLevel] || "🟡";
  const version = plan.revisionNumber > 1 ? ` (v${plan.revisionNumber})` : "";

  parts.push(`📋 <b>Plan Review${version}</b>`);
  parts.push(`<b>${escapeHtml(plan.title)}</b>`);
  parts.push("");
  parts.push(`<i>${escapeHtml(plan.goal.slice(0, 150))}</i>`);
  parts.push("");

  // Verdict line
  const totalSteps = plan.phases.reduce((n, p) => n + p.steps.length, 0);
  parts.push(`${risk} <b>${capitalize(plan.riskLevel)} Risk</b> · ${plan.files.length} files · ${plan.phases.length} phases · ${totalSteps} steps`);
  parts.push("");

  // Phases (top 3)
  const maxPhases = 3;
  for (let i = 0; i < Math.min(plan.phases.length, maxPhases); i++) {
    const p = plan.phases[i]!;
    parts.push(`<b>${i + 1}. ${escapeHtml(p.name)}</b> — ${escapeHtml(p.summary)}`);
  }
  if (plan.phases.length > maxPhases) {
    parts.push(`<i>+${plan.phases.length - maxPhases} more phases</i>`);
  }
  parts.push("");

  // Files (top 3)
  const topFiles = plan.files.slice(0, 3);
  if (topFiles.length > 0) {
    parts.push("<b>Files</b>");
    for (const f of topFiles) {
      parts.push(`<code>${escapeHtml(f)}</code>`);
    }
    if (plan.files.length > 3) {
      parts.push(`<i>+${plan.files.length - 3} more</i>`);
    }
    parts.push("");
  }

  // Risks (top 2)
  if (plan.risks.length > 0) {
    parts.push("<b>Risks</b>");
    for (const r of plan.risks.slice(0, 2)) {
      parts.push(`- ${escapeHtml(r)}`);
    }
    parts.push("");
  }

  // Why
  if (plan.whyThisPlan) {
    parts.push(`<b>Why</b> ${escapeHtml(plan.whyThisPlan.slice(0, 200))}`);
    parts.push("");
  }

  parts.push(`<code>${escapeHtml(plan.id)}</code>`);

  let card = parts.join("\n");
  if (card.length > SUMMARY_HARD_CAP) {
    card = card.slice(0, SUMMARY_HARD_CAP - 10) + "\n...";
  }
  return card;
}

/**
 * Render detail messages, split by phase. Returns array of message strings.
 * Only needed when plan has >3 phases or caller wants full details.
 */
export function renderPlanDetails(plan: GeneratedPlan): string[] {
  if (plan.phases.length <= 3) return [];

  const messages: string[] = [];
  let current = `<b>Plan Details</b>\n<b>${escapeHtml(plan.title)}</b>\n`;

  for (let i = 0; i < plan.phases.length; i++) {
    const p = plan.phases[i]!;
    let phaseBlock = `\n<b>${i + 1}. ${escapeHtml(p.name)}</b>\n`;
    for (const step of p.steps.slice(0, 4)) {
      phaseBlock += `- ${escapeHtml(step)}\n`;
    }
    if (p.steps.length > 4) {
      phaseBlock += `<i>+${p.steps.length - 4} more steps</i>\n`;
    }
    if (p.files && p.files.length > 0) {
      for (const f of p.files.slice(0, 3)) {
        phaseBlock += `<code>${escapeHtml(f)}</code>\n`;
      }
    }

    if (current.length + phaseBlock.length > DETAIL_HARD_CAP) {
      messages.push(current.trim());
      current = `<b>Plan Details (cont.)</b>\n`;
    }
    current += phaseBlock;
  }

  if (current.trim().length > 30) {
    messages.push(current.trim());
  }

  return messages;
}

/**
 * Render the revision prompt message.
 */
export function renderRevisionPrompt(plan: GeneratedPlan): string {
  return [
    `✏️ <b>Revision Requested</b>`,
    `<b>${escapeHtml(plan.title)}</b>`,
    "",
    `<i>Reply to this message with what to change. Short is fine.</i>`,
    "",
    `Examples: reduce scope, split into 2 phases, skip LinkedIn, add tests first`,
    "",
    `<code>${escapeHtml(plan.id)}</code>`,
  ].join("\n");
}

/**
 * Render the approved status card (replaces original card).
 */
export function renderApproved(plan: GeneratedPlan): string {
  const totalSteps = plan.phases.reduce((n, p) => n + p.steps.length, 0);
  return [
    `✅ <b>Plan Approved</b>`,
    `<b>${escapeHtml(plan.title)}</b>`,
    "",
    `<i>Executing...</i>`,
    `${plan.phases.length} phases · ${totalSteps} steps · ${plan.files.length} files`,
    "",
    `<code>${escapeHtml(plan.id)}</code>`,
  ].join("\n");
}

/**
 * Render the denied status card.
 */
export function renderDenied(plan: GeneratedPlan): string {
  return [
    `❌ <b>Plan Denied</b>`,
    `<b>${escapeHtml(plan.title)}</b>`,
    "",
    `<i>Cancelled. Reply with a reason if you want Homer to learn from it.</i>`,
    "",
    `<code>${escapeHtml(plan.id)}</code>`,
  ].join("\n");
}

/**
 * Render the superseded status card (old version after revision).
 */
export function renderSuperseded(plan: GeneratedPlan, newVersion: number): string {
  return [
    `🔄 <b>Superseded by v${newVersion}</b>`,
    `<b>${escapeHtml(plan.title)}</b>`,
    "",
    `<code>${escapeHtml(plan.id)}</code>`,
  ].join("\n");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
