/**
 * Telegram Approval Flow for HOMER's Proposal System
 *
 * Handles discovery proposals with inline buttons and quick commands.
 * Integrates with ideas and plans systems for lifecycle management.
 */

import { Bot, InlineKeyboard } from "grammy";
import { logger } from "../../utils/logger.js";
import { config } from "../../config/index.js";
import type { StateManager } from "../../state/manager.js";

// =============================================================================
// Types
// =============================================================================

export type ProposalRisk = "Low" | "Medium" | "High";
export type ProposalStatus = "pending" | "approved" | "snoozed" | "rejected";

export interface Proposal {
  id: string;
  title: string;
  summary: string;
  effort: string;
  expectedOutcome: string;
  risk: ProposalRisk;
  source: string;
  link?: string;
  createdAt: number;
  telegramMessageId?: number;
  status: ProposalStatus;
  snoozeUntil?: number;
  rejectionReason?: string;
}

export interface ProposalAction {
  proposalId: string;
  action: "approve" | "snooze" | "reject" | "details";
  timestamp: number;
  reason?: string;
}

// Track recent proposals for quick commands
const recentProposals: Map<number, Proposal[]> = new Map(); // chatId -> proposals
const RECENT_LIMIT = 10;
const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// =============================================================================
// Message Templates
// =============================================================================

/**
 * Format a proposal for Telegram display
 */
export function formatProposalMessage(proposal: Proposal): string {
  const riskEmoji = {
    Low: "🟢",
    Medium: "🟡",
    High: "🔴",
  }[proposal.risk];

  // Escape markdown special characters
  const escape = (text: string): string =>
    text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");

  return `🔍 *Discovery: ${escape(proposal.title)}*

${escape(proposal.summary)}

*Est\\. effort:* ${escape(proposal.effort)}
*Expected outcome:* ${escape(proposal.expectedOutcome)}
*Risk:* ${riskEmoji} ${proposal.risk}${proposal.link ? `\n*Link:* ${proposal.link}` : ""}

ID: \`${proposal.id}\``;
}

/**
 * Format approval confirmation message
 */
export function formatApprovalConfirmation(proposal: Proposal, planId?: string): string {
  const escape = (text: string): string =>
    text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");

  let msg = `✅ *Approved: ${escape(proposal.title)}*\n\n`;
  msg += `_Idea archived\\. Creating implementation plan\\.\\.\\._`;

  if (planId) {
    msg += `\n\nPlan ID: \`${planId}\``;
  }

  return msg;
}

/**
 * Format snooze confirmation message
 */
export function formatSnoozeConfirmation(proposal: Proposal, until: Date): string {
  const escape = (text: string): string =>
    text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");

  const timeStr = until.toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });

  return `⏸️ *Snoozed: ${escape(proposal.title)}*\n\n_Will resurface ${timeStr}_`;
}

/**
 * Format rejection confirmation message
 */
export function formatRejectionConfirmation(proposal: Proposal, reason?: string): string {
  const escape = (text: string): string =>
    text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");

  let msg = `❌ *Rejected: ${escape(proposal.title)}*`;

  if (reason) {
    msg += `\n\n_Reason: ${escape(reason)}_`;
  }

  msg += `\n\n_Logged for preference learning\\._`;

  return msg;
}

/**
 * Format details link message
 */
export function formatDetailsLink(proposal: Proposal, webUrl: string): string {
  const escape = (text: string): string =>
    text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");

  return `❓ *Details: ${escape(proposal.title)}*\n\n[Open in Web UI](${webUrl})\n\n_Use the planning Q&A to refine this proposal\\._`;
}

// =============================================================================
// Inline Keyboard Builder
// =============================================================================

/**
 * Create inline keyboard for proposal approval
 */
export function createProposalKeyboard(proposalId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Approve", `proposal:approve:${proposalId}`)
    .text("⏸️ Snooze", `proposal:snooze:${proposalId}`)
    .row()
    .text("❌ Reject", `proposal:reject:${proposalId}`)
    .text("❓ Details", `proposal:details:${proposalId}`);
}

/**
 * Create compact keyboard for batch operations
 */
export function createBatchKeyboard(proposalIds: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // Approve all button
  keyboard.text("✅ Approve All", `proposal:approve_all:${proposalIds.join(",")}`);

  // Snooze all button
  keyboard.text("⏸️ Snooze All", `proposal:snooze_all:${proposalIds.join(",")}`);

  return keyboard;
}

// =============================================================================
// Callback Handler Logic
// =============================================================================

/**
 * Handle approval callback from inline button
 * Advances proposal stage: idea → research → plan
 */
export async function handleApprovalCallback(
  proposalId: string,
  stateManager: StateManager
): Promise<{ success: boolean; message: string; planId?: string }> {
  try {
    // Get current proposal state
    const proposal = stateManager.db.prepare(`
      SELECT id, title, stage, version FROM proposals WHERE id = ?
    `).get(proposalId) as { id: string; title: string; stage: string; version: number } | undefined;

    if (proposal) {
      // Determine next stage: idea → research → plan → archived
      const stageMap: Record<string, string> = {
        idea: "research",
        research: "plan",
        plan: "archived",
      };
      const nextStage = stageMap[proposal.stage] || "archived";

      // Update proposal stage with optimistic locking
      const result = stateManager.db.prepare(`
        UPDATE proposals
        SET stage = ?,
            approval_status = 'approved',
            approved_at = CURRENT_TIMESTAMP,
            version = version + 1
        WHERE id = ? AND version = ?
      `).run(nextStage, proposalId, proposal.version);

      if (result.changes === 0) {
        return { success: false, message: "Proposal was modified by another process" };
      }

      logger.info({ proposalId, from: proposal.stage, to: nextStage }, "Proposal stage advanced");
    }

    // Legacy: Also try to archive from ideas table
    const archiveResult = await archiveIdea(proposalId, stateManager);

    // Create a plan record if we have idea data
    const planId = archiveResult.idea
      ? await createPlan(proposalId, archiveResult.idea, stateManager)
      : undefined;

    logger.info({ proposalId, planId }, "Proposal approved");

    return {
      success: true,
      message: `Approved: ${proposal?.title || archiveResult.idea?.title || proposalId}`,
      planId,
    };
  } catch (error) {
    logger.error({ error, proposalId }, "Failed to approve proposal");
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Handle snooze callback from inline button
 */
export async function handleSnoozeCallback(
  proposalId: string,
  durationMs: number = SNOOZE_DURATION_MS,
  stateManager: StateManager
): Promise<{ success: boolean; message: string; snoozeUntil?: Date }> {
  try {
    const snoozeUntil = new Date(Date.now() + durationMs);

    // Update proposal snooze_until column (approval_status remains pending)
    // Proposal will be hidden from queries until snooze_until passes
    stateManager.db.prepare(`
      UPDATE proposals
      SET snooze_until = ?, version = version + 1
      WHERE id = ?
    `).run(snoozeUntil.toISOString(), proposalId);

    logger.info({ proposalId, snoozeUntil }, "Proposal snoozed");

    return {
      success: true,
      message: `Snoozed until ${snoozeUntil.toLocaleString()}`,
      snoozeUntil,
    };
  } catch (error) {
    logger.error({ error, proposalId }, "Failed to snooze proposal");
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Handle rejection callback from inline button
 */
export async function handleRejectionCallback(
  proposalId: string,
  reason: string | undefined,
  stateManager: StateManager
): Promise<{ success: boolean; message: string }> {
  try {
    // Update proposal stage and approval_status (correct column names)
    stateManager.db.prepare(`
      UPDATE proposals
      SET stage = 'rejected',
          approval_status = 'rejected',
          rejection_reason = ?,
          version = version + 1
      WHERE id = ?
    `).run(reason || null, proposalId);

    // Log to deny history for preference learning
    await logDenyHistory(proposalId, reason, stateManager);

    logger.info({ proposalId, reason }, "Proposal rejected");

    return {
      success: true,
      message: `Rejected${reason ? `: ${reason}` : ""}`,
    };
  } catch (error) {
    logger.error({ error, proposalId }, "Failed to reject proposal");
    return {
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Generate web link for proposal details/planning
 */
export function generateWebLink(proposalId: string): string {
  const baseUrl = config.web?.baseUrl || "http://localhost:3000";
  // Include auth token for secure access
  const token = generateProposalToken(proposalId);
  return `${baseUrl}/proposals/${proposalId}?token=${token}`;
}

// =============================================================================
// Integration with Proposal Lifecycle
// =============================================================================

interface ArchivedIdea {
  id: string;
  title: string;
  content: string;
  source: string;
  link?: string;
}

/**
 * Archive an idea after approval
 */
async function archiveIdea(
  proposalId: string,
  stateManager: StateManager
): Promise<{ success: boolean; message: string; idea?: ArchivedIdea }> {
  try {
    // Get proposal/idea from database
    const idea = stateManager.db.prepare(`
      SELECT id, title, content, source, link
      FROM ideas
      WHERE id = ? OR id LIKE ?
    `).get(proposalId, `${proposalId}%`) as ArchivedIdea | undefined;

    if (!idea) {
      return { success: false, message: `Idea not found: ${proposalId}` };
    }

    // Update status to archived
    stateManager.db.prepare(`
      UPDATE ideas
      SET status = 'archived', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(idea.id);

    return { success: true, message: "Archived", idea };
  } catch (error) {
    logger.error({ error, proposalId }, "Failed to archive idea");
    return {
      success: false,
      message: error instanceof Error ? error.message : "Archive failed",
    };
  }
}

/**
 * Create a plan record from an approved proposal
 */
async function createPlan(
  proposalId: string,
  idea: ArchivedIdea | undefined,
  stateManager: StateManager
): Promise<string> {
  const planId = `plan_${Date.now().toString(36)}`;

  if (!idea) {
    logger.warn({ proposalId }, "No idea data for plan creation");
    return planId;
  }

  try {
    // Insert plan into database
    stateManager.db.prepare(`
      INSERT INTO plans (id, title, description, status, source_idea_id, created_at)
      VALUES (?, ?, ?, 'planning', ?, CURRENT_TIMESTAMP)
    `).run(planId, idea.title, idea.content, idea.id);

    // Link plan to original idea
    stateManager.db.prepare(`
      UPDATE ideas
      SET linked_plan_id = ?
      WHERE id = ?
    `).run(planId, idea.id);

    logger.info({ planId, ideaId: idea.id }, "Plan created from approved proposal");
  } catch (error) {
    // Tables might not exist yet - log and continue
    logger.warn({ error, planId }, "Could not persist plan to database");
  }

  return planId;
}

/**
 * Log rejection to deny history for preference learning
 */
async function logDenyHistory(
  proposalId: string,
  reason: string | undefined,
  stateManager: StateManager
): Promise<void> {
  try {
    stateManager.db.prepare(`
      INSERT INTO deny_history (proposal_id, reason, created_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `).run(proposalId, reason || "No reason provided");
  } catch {
    // Table might not exist yet
    logger.debug({ proposalId }, "Could not log to deny_history table");
  }
}

/**
 * Generate secure token for web access
 */
function generateProposalToken(proposalId: string): string {
  // Simple HMAC-style token for now
  const secret = config.web?.secret || "homer-default-secret";
  const data = `${proposalId}:${Math.floor(Date.now() / 3600000)}`; // Hour-based
  const crypto = require("crypto");
  return crypto.createHmac("sha256", secret).update(data).digest("hex").slice(0, 16);
}

// =============================================================================
// Quick Commands Implementation
// =============================================================================

/**
 * Register quick command handlers
 */
export function registerQuickCommands(bot: Bot, stateManager: StateManager): void {
  // /a - Approve most recent proposal
  bot.command("a", async (ctx) => {
    const chatId = ctx.chat.id;
    const proposals = recentProposals.get(chatId);

    if (!proposals || proposals.length === 0) {
      await ctx.reply("No recent proposals to approve.");
      return;
    }

    const proposal = proposals[0];
    if (!proposal) {
      await ctx.reply("No proposals found.");
      return;
    }
    const result = await handleApprovalCallback(proposal.id, stateManager);

    if (result.success) {
      await ctx.reply(formatApprovalConfirmation(proposal, result.planId), {
        parse_mode: "MarkdownV2",
      });
      // Remove from recent
      proposals.shift();
    } else {
      await ctx.reply(`Failed to approve: ${result.message}`);
    }
  });

  // /r - Reject most recent proposal
  bot.command("r", async (ctx) => {
    const chatId = ctx.chat.id;
    const reason = ctx.match?.trim() || undefined;
    const proposals = recentProposals.get(chatId);

    if (!proposals || proposals.length === 0) {
      await ctx.reply("No recent proposals to reject.");
      return;
    }

    const proposal = proposals[0];
    if (!proposal) {
      await ctx.reply("No proposals found.");
      return;
    }
    const result = await handleRejectionCallback(proposal.id, reason, stateManager);

    if (result.success) {
      await ctx.reply(formatRejectionConfirmation(proposal, reason), {
        parse_mode: "MarkdownV2",
      });
      proposals.shift();
    } else {
      await ctx.reply(`Failed to reject: ${result.message}`);
    }
  });

  // /aa - Approve all pending proposals
  bot.command("aa", async (ctx) => {
    const chatId = ctx.chat.id;
    const proposals = recentProposals.get(chatId);

    if (!proposals || proposals.length === 0) {
      await ctx.reply("No pending proposals to approve.");
      return;
    }

    let approved = 0;
    let failed = 0;

    for (const proposal of proposals) {
      const result = await handleApprovalCallback(proposal.id, stateManager);
      if (result.success) {
        approved++;
      } else {
        failed++;
      }
    }

    // Clear the list
    recentProposals.set(chatId, []);

    await ctx.reply(
      `Batch approval complete:\n✅ ${approved} approved\n${failed > 0 ? `❌ ${failed} failed` : ""}`
    );
  });

  // /s - Snooze most recent proposal
  bot.command("s", async (ctx) => {
    const chatId = ctx.chat.id;
    const proposals = recentProposals.get(chatId);

    if (!proposals || proposals.length === 0) {
      await ctx.reply("No recent proposals to snooze.");
      return;
    }

    const proposal = proposals[0];
    if (!proposal) {
      await ctx.reply("No proposals found.");
      return;
    }
    const result = await handleSnoozeCallback(proposal.id, SNOOZE_DURATION_MS, stateManager);

    if (result.success && result.snoozeUntil) {
      await ctx.reply(formatSnoozeConfirmation(proposal, result.snoozeUntil), {
        parse_mode: "MarkdownV2",
      });
      proposals.shift();
    } else {
      await ctx.reply(`Failed to snooze: ${result.message}`);
    }
  });

  // /proposals - List pending proposals
  bot.command("proposals", async (ctx) => {
    const chatId = ctx.chat.id;
    const proposals = recentProposals.get(chatId);

    if (!proposals || proposals.length === 0) {
      await ctx.reply("No pending proposals.");
      return;
    }

    let msg = `*Pending Proposals* (${proposals.length})\n\n`;
    for (let i = 0; i < Math.min(proposals.length, 5); i++) {
      const p = proposals[i];
      if (!p) continue;
      const escape = (text: string): string =>
        text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
      msg += `${i + 1}\\. *${escape(p.title)}*\n`;
      msg += `   Risk: ${p.risk} \\| Effort: ${escape(p.effort)}\n`;
      msg += `   ID: \`${p.id}\`\n\n`;
    }

    msg += `_Quick: /a \\(approve\\), /r \\(reject\\), /s \\(snooze\\), /aa \\(approve all\\)_`;

    try {
      await ctx.reply(msg, { parse_mode: "MarkdownV2" });
    } catch {
      await ctx.reply(msg.replace(/\\/g, ""));
    }
  });

  logger.info("Quick commands registered: /a, /r, /aa, /s, /proposals");
}

// =============================================================================
// Callback Handler Registration
// =============================================================================

/**
 * Register all proposal-related callback handlers
 */
export function registerProposalCallbacks(bot: Bot, stateManager: StateManager): void {
  // Approve button
  bot.callbackQuery(/^proposal:approve:(.+)$/, async (ctx) => {
    const proposalId = ctx.match?.[1];
    if (!proposalId) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }

    const proposal = await getProposal(proposalId, stateManager);
    const result = await handleApprovalCallback(proposalId, stateManager);

    if (result.success && proposal) {
      await ctx.editMessageText(formatApprovalConfirmation(proposal, result.planId), {
        parse_mode: "MarkdownV2",
      });
    } else {
      await ctx.editMessageText(`❌ ${result.message}`);
    }

    await ctx.answerCallbackQuery(result.success ? "Approved!" : "Failed");
  });

  // Snooze button
  bot.callbackQuery(/^proposal:snooze:(.+)$/, async (ctx) => {
    const proposalId = ctx.match?.[1];
    if (!proposalId) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }

    const proposal = await getProposal(proposalId, stateManager);
    const result = await handleSnoozeCallback(proposalId, SNOOZE_DURATION_MS, stateManager);

    if (result.success && proposal && result.snoozeUntil) {
      await ctx.editMessageText(formatSnoozeConfirmation(proposal, result.snoozeUntil), {
        parse_mode: "MarkdownV2",
      });
    } else {
      await ctx.editMessageText(`❌ ${result.message}`);
    }

    await ctx.answerCallbackQuery(result.success ? "Snoozed for 24h" : "Failed");
  });

  // Reject button - prompts for reason
  bot.callbackQuery(/^proposal:reject:(.+)$/, async (ctx) => {
    const proposalId = ctx.match?.[1];
    if (!proposalId) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }

    const proposal = await getProposal(proposalId, stateManager);
    if (!proposal) {
      await ctx.editMessageText(`❌ Proposal not found: ${proposalId}`);
      await ctx.answerCallbackQuery();
      return;
    }

    // Show rejection reason options
    const keyboard = new InlineKeyboard()
      .text("Not relevant", `proposal:reject_reason:${proposalId}:not_relevant`)
      .text("Too complex", `proposal:reject_reason:${proposalId}:too_complex`)
      .row()
      .text("Low priority", `proposal:reject_reason:${proposalId}:low_priority`)
      .text("Already done", `proposal:reject_reason:${proposalId}:already_done`)
      .row()
      .text("Skip reason", `proposal:reject_reason:${proposalId}:skip`);

    await ctx.editMessageText(
      `❌ *Rejecting:* ${proposal.title}\n\nSelect a reason:`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );

    await ctx.answerCallbackQuery();
  });

  // Reject with reason
  bot.callbackQuery(/^proposal:reject_reason:(.+):(.+)$/, async (ctx) => {
    const proposalId = ctx.match?.[1];
    const reasonKey = ctx.match?.[2];
    if (!proposalId || !reasonKey) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }

    const reasonMap: Record<string, string> = {
      not_relevant: "Not relevant to current goals",
      too_complex: "Too complex for now",
      low_priority: "Low priority",
      already_done: "Already done or exists",
      skip: "",
    };

    const reason = reasonMap[reasonKey];
    const proposal = await getProposal(proposalId, stateManager);
    const result = await handleRejectionCallback(proposalId, reason || undefined, stateManager);

    if (result.success && proposal) {
      await ctx.editMessageText(formatRejectionConfirmation(proposal, reason || undefined), {
        parse_mode: "MarkdownV2",
      });
    } else {
      await ctx.editMessageText(`❌ ${result.message}`);
    }

    await ctx.answerCallbackQuery(result.success ? "Rejected" : "Failed");
  });

  // Details button
  bot.callbackQuery(/^proposal:details:(.+)$/, async (ctx) => {
    const proposalId = ctx.match?.[1];
    if (!proposalId) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }

    const proposal = await getProposal(proposalId, stateManager);
    if (!proposal) {
      await ctx.editMessageText(`❌ Proposal not found: ${proposalId}`);
      await ctx.answerCallbackQuery();
      return;
    }

    const webUrl = generateWebLink(proposalId);

    // Keep original message but add details link
    await ctx.editMessageText(
      formatProposalMessage(proposal) + `\n\n[🔗 Open Details](${webUrl})`,
      {
        parse_mode: "MarkdownV2",
        reply_markup: createProposalKeyboard(proposalId),
      }
    );

    await ctx.answerCallbackQuery("Opening details...");
  });

  // Approve all button
  bot.callbackQuery(/^proposal:approve_all:(.+)$/, async (ctx) => {
    const idsStr = ctx.match?.[1];
    if (!idsStr) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }

    const proposalIds = idsStr.split(",");
    let approved = 0;

    for (const id of proposalIds) {
      const result = await handleApprovalCallback(id, stateManager);
      if (result.success) approved++;
    }

    await ctx.editMessageText(`✅ Batch approved ${approved}/${proposalIds.length} proposals`);
    await ctx.answerCallbackQuery(`Approved ${approved} proposals`);
  });

  // Snooze all button
  bot.callbackQuery(/^proposal:snooze_all:(.+)$/, async (ctx) => {
    const idsStr = ctx.match?.[1];
    if (!idsStr) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }

    const proposalIds = idsStr.split(",");
    let snoozed = 0;

    for (const id of proposalIds) {
      const result = await handleSnoozeCallback(id, SNOOZE_DURATION_MS, stateManager);
      if (result.success) snoozed++;
    }

    await ctx.editMessageText(`⏸️ Batch snoozed ${snoozed}/${proposalIds.length} proposals`);
    await ctx.answerCallbackQuery(`Snoozed ${snoozed} proposals`);
  });

  logger.info("Proposal callback handlers registered");
}

// =============================================================================
// Send Proposal for Approval
// =============================================================================

/**
 * Send a single proposal for approval
 */
export async function sendProposalForApproval(
  bot: Bot,
  chatId: number,
  proposal: Proposal
): Promise<number | undefined> {
  try {
    const message = await bot.api.sendMessage(chatId, formatProposalMessage(proposal), {
      parse_mode: "MarkdownV2",
      reply_markup: createProposalKeyboard(proposal.id),
    });

    // Track for quick commands
    const chatProposals = recentProposals.get(chatId) || [];
    chatProposals.unshift(proposal);
    if (chatProposals.length > RECENT_LIMIT) {
      chatProposals.pop();
    }
    recentProposals.set(chatId, chatProposals);

    // Return message ID for tracking
    return message.message_id;
  } catch (error) {
    logger.error({ error, proposalId: proposal.id }, "Failed to send proposal message");
    return undefined;
  }
}

/**
 * Send multiple proposals as a batch
 */
export async function sendProposalBatch(
  bot: Bot,
  chatId: number,
  proposals: Proposal[]
): Promise<void> {
  if (proposals.length === 0) {
    await bot.api.sendMessage(chatId, "No new proposals to review.");
    return;
  }

  // Send header
  await bot.api.sendMessage(
    chatId,
    `🔍 *${proposals.length} New Discoveries*\n\nReview each proposal below:`,
    { parse_mode: "Markdown" }
  );

  // Send each proposal with its keyboard
  for (const proposal of proposals) {
    await sendProposalForApproval(bot, chatId, proposal);
    // Small delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Send batch actions if multiple proposals
  if (proposals.length > 1) {
    const proposalIds = proposals.map((p) => p.id);
    await bot.api.sendMessage(
      chatId,
      "_Batch actions available:_",
      {
        parse_mode: "Markdown",
        reply_markup: createBatchKeyboard(proposalIds),
      }
    );
  }
}

/**
 * Update an existing proposal message (e.g., after status change)
 */
export async function updateProposalMessage(
  bot: Bot,
  chatId: number,
  messageId: number,
  proposal: Proposal,
  newStatus: string
): Promise<void> {
  try {
    const statusMessages: Record<string, string> = {
      approved: formatApprovalConfirmation(proposal),
      snoozed: formatSnoozeConfirmation(proposal, new Date(proposal.snoozeUntil || Date.now())),
      rejected: formatRejectionConfirmation(proposal, proposal.rejectionReason),
    };

    const message = statusMessages[newStatus] || formatProposalMessage(proposal);

    await bot.api.editMessageText(chatId, messageId, message, {
      parse_mode: "MarkdownV2",
    });
  } catch (error) {
    logger.warn({ error, messageId }, "Failed to update proposal message");
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get proposal from database or cache
 */
async function getProposal(proposalId: string, stateManager: StateManager): Promise<Proposal | null> {
  try {
    // First check recent proposals cache
    for (const proposals of recentProposals.values()) {
      const found = proposals.find((p) => p.id === proposalId);
      if (found) return found;
    }

    // Then check database (using correct column names from schema)
    const row = stateManager.db.prepare(`
      SELECT id, title, summary, effort_estimate, content, risk_level, source, source_url,
             created_at, message_id, approval_status, snooze_until, rejection_reason
      FROM proposals
      WHERE id = ? OR id LIKE ?
    `).get(proposalId, `${proposalId}%`) as {
      id: string;
      title: string;
      summary: string;
      effort_estimate: string | null;
      content: string;
      risk_level: string;
      source: string;
      source_url: string | null;
      created_at: string;
      message_id: number | null;
      approval_status: string;
      snooze_until: string | null;
      rejection_reason: string | null;
    } | undefined;

    if (!row) return null;

    // Map DB columns to Proposal interface
    return {
      id: row.id,
      title: row.title,
      summary: row.summary || row.content.slice(0, 200),
      effort: row.effort_estimate || "Unknown",
      expectedOutcome: "See details",
      risk: (row.risk_level === "low" ? "Low" : row.risk_level === "medium" ? "Medium" : "High") as ProposalRisk,
      source: row.source,
      link: row.source_url || undefined,
      createdAt: new Date(row.created_at).getTime(),
      telegramMessageId: row.message_id || undefined,
      status: row.approval_status as ProposalStatus,
      snoozeUntil: row.snooze_until ? new Date(row.snooze_until).getTime() : undefined,
      rejectionReason: row.rejection_reason || undefined,
    };
  } catch {
    // Table might not exist yet
    return null;
  }
}

/**
 * Check for snoozed proposals that should resurface
 */
export async function checkSnoozedProposals(
  bot: Bot,
  chatId: number,
  stateManager: StateManager
): Promise<void> {
  try {
    const nowIso = new Date().toISOString();

    // Find proposals where snooze_until has passed (using correct column names)
    const rows = stateManager.db.prepare(`
      SELECT id, title, summary, effort_estimate, content, risk_level, source, source_url
      FROM proposals
      WHERE approval_status = 'pending'
        AND snooze_until IS NOT NULL
        AND snooze_until <= ?
    `).all(nowIso) as Array<{
      id: string;
      title: string;
      summary: string | null;
      effort_estimate: string | null;
      content: string;
      risk_level: string;
      source: string;
      source_url: string | null;
    }>;

    if (rows.length === 0) return;

    // Clear snooze_until to resurface them
    stateManager.db.prepare(`
      UPDATE proposals
      SET snooze_until = NULL, version = version + 1
      WHERE approval_status = 'pending'
        AND snooze_until IS NOT NULL
        AND snooze_until <= ?
    `).run(nowIso);

    // Map to Proposal interface
    const proposals: Proposal[] = rows.map((row) => ({
      id: row.id,
      title: row.title,
      summary: row.summary || row.content.slice(0, 200),
      effort: row.effort_estimate || "Unknown",
      expectedOutcome: "See details",
      risk: (row.risk_level === "low" ? "Low" : row.risk_level === "medium" ? "Medium" : "High") as ProposalRisk,
      source: row.source,
      link: row.source_url || undefined,
      createdAt: Date.now(),
      status: "pending" as ProposalStatus,
    }));

    await bot.api.sendMessage(chatId, `*${proposals.length} snoozed proposal${proposals.length > 1 ? "s" : ""} resurfacing:*`, {
      parse_mode: "Markdown",
    });

    await sendProposalBatch(bot, chatId, proposals);

    logger.info({ count: proposals.length }, "Resurfaced snoozed proposals");
  } catch (error) {
    logger.warn({ error }, "Failed to check snoozed proposals");
  }
}
