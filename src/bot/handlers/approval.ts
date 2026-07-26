import { Bot, InlineKeyboard } from "grammy";
import { logger } from "../../utils/logger.js";
import type { StateManager } from "../../state/manager.js";
import { staleMapCleaner } from "../../utils/stale-map-cleaner.js";
import { escapeHtml } from "../../utils/telegram-format.js";
import { recordFeedback } from "../../feedback/events.js";
import { config } from "../../config/index.js";

// Track pending instruction replies (messageId -> pending plan)
interface PendingInstruction {
  type: "plan";
  id: string;
  title?: string;
  createdAt: number;
}
const pendingInstructionRequests = new Map<number, PendingInstruction>();

// Register Maps for cleanup via shared StaleMapCleaner (30min interval, replaces per-module setInterval)
staleMapCleaner.register(pendingInstructionRequests, "approval:instructions");

export function registerApprovalHandlers(bot: Bot, stateManager: StateManager): void {

  // Handle instruction or reject reason replies
  bot.on("message:text", async (ctx, next) => {
    const replyTo = ctx.message.reply_to_message?.message_id;
    if (!replyTo) {
      return next();
    }

    // Plan review revision replies
    if (pendingPlanRevisions.has(replyTo)) {
      const chatId = ctx.chat?.id;
      if (chatId) {
        const consumed = await handlePlanRevisionReply(
          bot, stateManager, replyTo, ctx.message.text.trim(), chatId,
        );
        if (consumed) return;
      }
    }

    if (pendingInstructionRequests.has(replyTo)) {
      const pending = pendingInstructionRequests.get(replyTo);
      if (!pending) return next();

      const instructions = ctx.message.text.trim();
      if (!instructions) {
        await ctx.reply("❌ Instructions cannot be empty.");
        return;
      }

      try {
        const plan = stateManager.getPendingPlan(pending.id);
        if (!plan) {
          await ctx.reply(`❌ Plan not found: ${escapeHtml(pending.id)}`, { parse_mode: "HTML" });
        } else {
          const now = new Date();
          const year = now.getFullYear();
          const month = String(now.getMonth() + 1).padStart(2, "0");
          const day = String(now.getDate()).padStart(2, "0");
          const hours = String(now.getHours()).padStart(2, "0");
          const mins = String(now.getMinutes()).padStart(2, "0");
          const timestamp = `${year}-${month}-${day} ${hours}:${mins}`;
          const updated = `${plan}\n\n## User Instructions (${timestamp})\n${instructions}\n`;
          stateManager.savePendingPlan(pending.id, updated);
          await ctx.reply(
            `✅ <b>Instructions saved</b>\n<b>Plan ID:</b> <code>${escapeHtml(pending.id)}</code>`,
            { parse_mode: "HTML" }
          );
        }
      } catch (error) {
        logger.error({ error, id: pending.id, type: pending.type }, "Failed to save instructions");
        await ctx.reply(
          `❌ Error: ${escapeHtml(error instanceof Error ? error.message : "Unknown")}`,
          { parse_mode: "HTML" }
        );
      } finally {
        pendingInstructionRequests.delete(replyTo);
      }
      return;
    }

    return next();
  });

  logger.info("Approval handlers registered");
}

// ============================================
// Plan Review Cards (Structured Approve/Revise/Deny)
// ============================================

import type { GeneratedPlan } from "../../plans/review-types.js";
import { renderPlanCard, renderPlanDetails, renderRevisionPrompt, renderApproved, renderDenied } from "../../plans/review-renderer.js";
import { parsePlanFromOutput } from "../../plans/review-parser.js";

// Track pending revision replies (telegram messageId -> plan context)
interface PendingPlanRevision {
  planId: string;
  chatId: number;
  createdAt: number;
}
const pendingPlanRevisions = new Map<number, PendingPlanRevision>();
staleMapCleaner.register(pendingPlanRevisions, "plan-revisions", {
  maxAgeMs: 2 * 60 * 60 * 1000,  // 2 hours
  timestampKey: "createdAt",
});

/**
 * Create inline keyboard for plan review card.
 * Uses plan:* namespace to avoid collision with existing a:p:* handlers.
 */
export function createPlanReviewKeyboard(planId: string): InlineKeyboard {
  // Telegram 64-byte limit for callback_data
  const maxIdLen = 64 - "plan:approve:".length;
  const id = planId.length > maxIdLen ? planId.slice(0, maxIdLen) : planId;
  return new InlineKeyboard()
    .text("✅ Approve", `plan:approve:${id}`)
    .text("✏️ Revise", `plan:revise:${id}`)
    .text("❌ Deny", `plan:deny:${id}`);
}

/**
 * Send a structured plan review card to Telegram.
 * Can be called from scheduler, Claude sessions, or any executor.
 */
export async function sendPlanForReview(
  bot: Bot,
  stateManager: StateManager,
  chatId: number,
  plan: GeneratedPlan,
): Promise<number | null> {
  // Store structured plan
  stateManager.savePlanReview(
    plan.id,
    JSON.stringify(plan),
    plan.title,
    plan.riskLevel,
    plan.source,
    chatId,
  );

  // Also save raw text in old table for backward compat
  if (plan.rawText) {
    stateManager.savePendingPlan(plan.id, plan.rawText);
  }

  try {
    // Send summary card
    const card = renderPlanCard(plan);
    const cardMsg = await bot.api.sendMessage(chatId, card, {
      parse_mode: "HTML",
      reply_markup: createPlanReviewKeyboard(plan.id),
    });

    // Update with message ID
    stateManager.updatePlanReviewStatus(plan.id, "pending_review", {
      cardMessageId: cardMsg.message_id,
    });

    // Send detail messages if plan is large
    const details = renderPlanDetails(plan);
    for (const detail of details) {
      await bot.api.sendMessage(chatId, detail, { parse_mode: "HTML" });
    }

    logger.info({ planId: plan.id, phases: plan.phases.length }, "Plan review card sent");
    return cardMsg.message_id;
  } catch (err) {
    logger.error({ planId: plan.id, error: err }, "Failed to send plan review card");
    return null;
  }
}

/**
 * Register plan review card callback handlers (plan:approve, plan:revise, plan:deny).
 */
export function registerPlanReviewCallbacks(bot: Bot, stateManager: StateManager): void {

  // ── Approve ──
  bot.callbackQuery(/^plan:approve:(.+)$/, async (ctx) => {
    const planId = ctx.match?.[1];
    if (!planId) { await ctx.answerCallbackQuery("Invalid"); return; }

    const review = stateManager.getPlanReview(planId);
    if (!review || review.status !== "pending_review") {
      await ctx.answerCallbackQuery("Plan not found or already processed");
      return;
    }

    const plan: GeneratedPlan = JSON.parse(review.planJson);

    // Edit card to approved
    await ctx.editMessageText(renderApproved(plan), { parse_mode: "HTML" });
    await ctx.answerCallbackQuery("Plan approved — executing!");

    stateManager.updatePlanReviewStatus(planId, "approved", { decidedAt: true });
    logger.info({ planId }, "Plan approved via review card");

    try {
      recordFeedback(stateManager.getDb(), {
        contentType: "plan",
        contentId: planId,
        action: "approve",
        source: "telegram",
        delta: 0.15,
      });
    } catch { /* best-effort */ }

    // Execute plan
    const chatId = ctx.chat?.id;
    if (chatId) {
      stateManager.updatePlanReviewStatus(planId, "executing");
      stateManager.clearPendingPlan(planId);

      import("../../harness/dispatch.js").then(({ executeResolvedHarness }) => {
        const rawPlan = plan.rawText || review.planJson;
        const prompt = `You are implementing an approved Homer improvement plan.

## The Plan

${rawPlan}

## Instructions

1. Read the relevant source files mentioned in the plan.
2. Implement the changes described. Use your judgment on the best approach.
3. After making changes, run \`npm run build\` in ~/homer/ to verify.
4. If the build fails, fix the issues until it passes.
5. Commit your changes with a descriptive message.
6. Do NOT push to remote, restart the daemon, or modify .env/credentials/CLAUDE.md.
7. Do NOT create git branches — work directly on the current branch.

Output a brief summary of what you changed and whether the build passes.`;

        executeResolvedHarness({
          source: "runtime",
          mode: "runtime-turn",
          prompt,
          cwd: config.paths.homerRoot,
          timeoutMs: 20 * 60 * 1000,
          requiredCapabilities: [
            { capability: "code.edit", required: true, reason: "implement approved plan" },
            { capability: "tools.files.write", required: true, reason: "edit source files" },
            { capability: "tools.shell", required: true, reason: "run npm build + commit" },
          ],
        }).then(async (result) => {
          stateManager.updatePlanReviewStatus(planId, "completed");
          const summary = (result.output || "completed").slice(0, 1500);
          try {
            await bot.api.sendMessage(chatId,
              `✅ <b>Plan implemented</b>\n<b>${escapeHtml(plan.title)}</b>\n\n${escapeHtml(summary)}`,
              { parse_mode: "HTML" }
            );
          } catch { /* best effort */ }
        }).catch(async (err) => {
          stateManager.updatePlanReviewStatus(planId, "completed", { feedback: String(err).slice(0, 500) });
          logger.error({ planId, error: err }, "Plan execution failed");
          try {
            await bot.api.sendMessage(chatId,
              `❌ <b>Plan failed</b>\n<b>${escapeHtml(plan.title)}</b>\n<code>${escapeHtml(String(err).slice(0, 500))}</code>`,
              { parse_mode: "HTML" }
            );
          } catch { /* best effort */ }
        });
      }).catch(err => logger.error({ planId, error: err }, "Failed to import harness dispatch"));
    }
  });

  // ── Revise ──
  bot.callbackQuery(/^plan:revise:(.+)$/, async (ctx) => {
    const planId = ctx.match?.[1];
    if (!planId) { await ctx.answerCallbackQuery("Invalid"); return; }

    const review = stateManager.getPlanReview(planId);
    if (!review || review.status !== "pending_review") {
      await ctx.answerCallbackQuery("Plan not found or already processed");
      return;
    }

    const plan: GeneratedPlan = JSON.parse(review.planJson);

    // Edit card to show revision requested
    await ctx.editMessageText(renderRevisionPrompt(plan), { parse_mode: "HTML" });
    await ctx.answerCallbackQuery("Reply with what to change");

    stateManager.updatePlanReviewStatus(planId, "awaiting_revision");

    // Send force_reply prompt
    const chatId = ctx.chat?.id;
    if (chatId) {
      try {
        const promptMsg = await bot.api.sendMessage(chatId, renderRevisionPrompt(plan), {
          parse_mode: "HTML",
          reply_markup: { force_reply: true, selective: true },
        });

        pendingPlanRevisions.set(promptMsg.message_id, {
          planId,
          chatId,
          createdAt: Date.now(),
        });
      } catch (err) {
        logger.error({ planId, error: err }, "Failed to send revision prompt");
      }
    }
  });

  // ── Deny ──
  bot.callbackQuery(/^plan:deny:(.+)$/, async (ctx) => {
    const planId = ctx.match?.[1];
    if (!planId) { await ctx.answerCallbackQuery("Invalid"); return; }

    const review = stateManager.getPlanReview(planId);
    if (!review || review.status !== "pending_review") {
      await ctx.answerCallbackQuery("Plan not found or already processed");
      return;
    }

    const plan: GeneratedPlan = JSON.parse(review.planJson);

    await ctx.editMessageText(renderDenied(plan), { parse_mode: "HTML" });
    await ctx.answerCallbackQuery("Plan denied");

    stateManager.updatePlanReviewStatus(planId, "denied", { decidedAt: true });
    stateManager.clearPendingPlan(planId);

    logger.info({ planId }, "Plan denied via review card");

    try {
      recordFeedback(stateManager.getDb(), {
        contentType: "plan",
        contentId: planId,
        action: "reject",
        source: "telegram",
        delta: -0.1,
      });
    } catch { /* best-effort */ }
  });

  logger.info("Plan review card callbacks registered");
}

/**
 * Handle revision reply — called from the main message:text handler.
 * Returns true if the message was consumed as a revision reply.
 */
export async function handlePlanRevisionReply(
  bot: Bot,
  stateManager: StateManager,
  replyToMessageId: number,
  feedbackText: string,
  chatId: number,
): Promise<boolean> {
  const pending = pendingPlanRevisions.get(replyToMessageId);
  if (!pending) return false;

  pendingPlanRevisions.delete(replyToMessageId);

  const review = stateManager.getPlanReview(pending.planId);
  if (!review) {
    await bot.api.sendMessage(chatId, `❌ Plan not found: <code>${escapeHtml(pending.planId)}</code>`, { parse_mode: "HTML" });
    return true;
  }

  const oldPlan: GeneratedPlan = JSON.parse(review.planJson);

  stateManager.updatePlanReviewStatus(pending.planId, "revising");

  const historyContext = `Revision ${oldPlan.revisionNumber}: ${feedbackText}`;

  await bot.api.sendMessage(chatId, `🔄 <b>Revising plan...</b>\n<i>${escapeHtml(feedbackText.slice(0, 200))}</i>`, { parse_mode: "HTML" });

  try {
    const { executeResolvedHarness } = await import("../../harness/dispatch.js");
    const prompt = `You are revising a Homer implementation plan based on user feedback.

## Original Plan
${oldPlan.rawText || JSON.stringify(oldPlan, null, 2)}

## Revision History
${historyContext}

## Latest Feedback
${feedbackText}

## Instructions
1. Read the original plan carefully.
2. Apply the user's feedback to produce a REVISED plan.
3. Keep the same structure: ## Implementation Plan, ### Step N:, **Files:**, **Risk:**
4. Only change what the feedback asks for. Keep everything else.
5. Output ONLY the revised plan text, nothing else.`;

    const result = await executeResolvedHarness({
      source: "runtime",
      mode: "runtime-turn",
      prompt,
      cwd: config.paths.homerRoot,
      timeoutMs: 90_000,
      outputContract: { kind: "text" },
    });

    if (result.exitCode !== 0) throw new Error(result.output?.slice(0, 300) || "Revision failed");

    // Parse new plan
    const newPlan = parsePlanFromOutput(result.output || "", oldPlan.source);
    newPlan.revisionNumber = oldPlan.revisionNumber + 1;
    newPlan.id = oldPlan.id;  // Keep same ID, bump version

    // Mark old as superseded
    stateManager.updatePlanReviewStatus(pending.planId, "superseded");

    // Save and send new card
    stateManager.savePlanReview(
      newPlan.id,
      JSON.stringify(newPlan),
      newPlan.title,
      newPlan.riskLevel,
      newPlan.source,
      chatId,
    );
    if (newPlan.rawText) stateManager.savePendingPlan(newPlan.id, newPlan.rawText);

    // Send new card
    const card = renderPlanCard(newPlan);
    const cardMsg = await bot.api.sendMessage(chatId, card, {
      parse_mode: "HTML",
      reply_markup: createPlanReviewKeyboard(newPlan.id),
    });

    stateManager.updatePlanReviewStatus(newPlan.id, "pending_review", {
      cardMessageId: cardMsg.message_id,
      revisionNumber: newPlan.revisionNumber,
    });

    // Send details if needed
    const details = renderPlanDetails(newPlan);
    for (const detail of details) {
      await bot.api.sendMessage(chatId, detail, { parse_mode: "HTML" });
    }

    logger.info({ planId: newPlan.id, revision: newPlan.revisionNumber }, "Plan revised and resent");
  } catch (err) {
    logger.error({ planId: pending.planId, error: err }, "Plan revision failed");
    // Restore to pending_review so user can try again
    stateManager.updatePlanReviewStatus(pending.planId, "pending_review");
    await bot.api.sendMessage(chatId,
      `❌ <b>Revision failed</b>\n<code>${escapeHtml(String(err).slice(0, 300))}</code>\n\nOriginal plan restored. Try again.`,
      { parse_mode: "HTML" }
    );
  }

  return true;
}

// ============================================
// Implementation Plan Approval (Legacy)
// ============================================

/**
 * Register plan approval command handlers
 */
export function registerPlanApprovalHandlers(bot: Bot, stateManager: StateManager): void {
  // /approve <jobId> - Approve and execute a pending plan
  bot.command("approve", async (ctx) => {
    const args = ctx.message?.text?.split(/\s+/).slice(1) || [];
    const jobId = args[0];

    if (!jobId) {
      // List pending plans
      const plans = stateManager.listPendingPlans();
      if (plans.length === 0) {
        await ctx.reply("📋 No pending plans awaiting approval.");
        return;
      }

      let msg = "📋 *Pending Plans*\n\n";
      for (const plan of plans) {
        const preview = plan.plan.slice(0, 200).replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
        msg += `*${plan.jobId}*\n${preview}...\n\n`;
      }
      msg += "_Use `/approve <jobId>` to approve a plan._";

      await ctx.reply(msg, { parse_mode: "Markdown" });
      return;
    }

    const plan = stateManager.getPendingPlan(jobId);
    if (!plan) {
      await ctx.reply(`❌ No pending plan found for: ${jobId}`);
      return;
    }

    // Clear the pending plan (prevent double-execution)
    stateManager.clearPendingPlan(jobId);

    await ctx.reply(
      `✅ *Plan approved: ${jobId}*\n\n` +
      `_Executing on branch..._`,
      { parse_mode: "Markdown" }
    );

    logger.info({ jobId }, "Plan approved by user");
    try {
      const db = stateManager.getDb();
      recordFeedback(db, {
        contentType: "plan",
        contentId: jobId,
        action: "approve",
        source: "telegram",
        delta: 0.15,
      });
    } catch { /* best-effort */ }

    // Fire-and-forget: spawn the selected harness to implement the plan on main (no branch)
    const cmdChatId = ctx.chat?.id;
    if (cmdChatId) {
      import("../../harness/dispatch.js").then(({ executeResolvedHarness }) => {
        const prompt = `You are implementing an approved Homer improvement plan.

## The Plan

${plan}

## Instructions

1. Read the relevant source files mentioned in the plan.
2. Implement the changes described. Use your judgment on the best approach.
3. After making changes, run \`npm run build\` in ~/homer/ to verify.
4. If the build fails, fix the issues until it passes.
5. Commit your changes with a descriptive message.
6. Do NOT push to remote, restart the daemon, or modify .env/credentials/CLAUDE.md.
7. Do NOT create git branches — work directly on the current branch.

Output a brief summary of what you changed and whether the build passes.`;

        executeResolvedHarness({
          source: "runtime",
          mode: "runtime-turn",
          prompt,
          cwd: config.paths.homerRoot,
          timeoutMs: 20 * 60 * 1000,
          requiredCapabilities: [
            { capability: "code.edit", required: true, reason: "implement approved plan" },
            { capability: "tools.files.write", required: true, reason: "edit source files" },
            { capability: "tools.shell", required: true, reason: "run npm build + commit" },
          ],
        }).then(async (result) => {
          const summary = (result.output || "completed").slice(0, 1500);
          try {
            await bot.api.sendMessage(cmdChatId,
              `✅ <b>Plan implemented</b>\n<b>ID:</b> <code>${escapeHtml(jobId)}</code>\n<b>Result:</b>\n${escapeHtml(summary)}`,
              { parse_mode: "HTML" }
            );
          } catch { /* best effort */ }
        }).catch(async (err) => {
          logger.error({ jobId, error: err }, "Plan implementation via selected harness failed");
          try {
            await bot.api.sendMessage(cmdChatId,
              `❌ <b>Plan implementation failed</b>\n<b>ID:</b> <code>${escapeHtml(jobId)}</code>\n<code>${escapeHtml(String(err).slice(0, 500))}</code>`,
              { parse_mode: "HTML" }
            );
          } catch { /* best effort */ }
        });
      }).catch(err => {
        logger.error({ jobId, error: err }, "Failed to import claude executor");
      });
    }
  });

  // /reject <jobId> - Reject and discard a pending plan
  bot.command("reject", async (ctx) => {
    const args = ctx.message?.text?.split(/\s+/).slice(1) || [];
    const jobId = args[0];

    if (!jobId) {
      await ctx.reply("Usage: `/reject <jobId>`\n\nUse `/approve` to see pending plans.", {
        parse_mode: "Markdown",
      });
      return;
    }

    const plan = stateManager.getPendingPlan(jobId);
    if (!plan) {
      await ctx.reply(`❌ No pending plan found for: ${jobId}`);
      return;
    }

    stateManager.clearPendingPlan(jobId);

    await ctx.reply(`🗑️ Plan rejected and discarded: ${jobId}`);
    logger.info({ jobId }, "Plan rejected by user");
    try {
      const db = stateManager.getDb();
      recordFeedback(db, {
        contentType: "plan",
        contentId: jobId,
        action: "reject",
        source: "telegram",
        delta: -0.1,
      });
    } catch { /* best-effort */ }
  });

  // /plans - List pending plans
  bot.command("plans", async (ctx) => {
    const plans = stateManager.listPendingPlans();

    if (plans.length === 0) {
      await ctx.reply("📋 No pending plans awaiting approval.");
      return;
    }

    let msg = "📋 *Pending Implementation Plans*\n\n";
    for (const plan of plans) {
      const age = Math.round((Date.now() - plan.createdAt) / 60000);
      const preview = plan.plan.slice(0, 300).replace(/[_*[\]()~#+\-=|{}.!]/g, "\\$&");
      msg += `🔧 *${plan.jobId}* _(${age}m ago)_\n`;
      msg += `\`\`\`\n${preview}...\n\`\`\`\n\n`;
    }
    msg += "Commands:\n";
    msg += "`/approve <jobId>` \\- Execute plan\n";
    msg += "`/reject <jobId>` \\- Discard plan";

    await ctx.reply(msg, { parse_mode: "MarkdownV2" });
  });

  logger.info("Plan approval handlers registered");
}

/**
 * Check if output contains an implementation plan requiring approval
 */
export function isPlanRequiringApproval(output: string): boolean {
  // Must have "## Implementation Plan" as primary marker (used by homer-improvements)
  // Plus at least one detail marker to reduce false positives from other job outputs
  if (!output.includes("## Implementation Plan")) return false;

  const detailMarkers = [
    "### Step 1:",
    "### Files to Modify",
    "### Description",
    "**Risk:**",
    "**Files:**",
  ];

  return detailMarkers.some(marker => output.includes(marker));
}

/**
 * Create inline keyboard for plan approval
 */
export function createPlanApprovalKeyboard(jobId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Approve", `a:p:${jobId}:approve`)
    .text("❌ Reject", `a:p:${jobId}:reject`)
    .row()
    .text("✍️ Add Instructions", `a:p:${jobId}:note`);
}

/**
 * Register inline button handlers for plan approval
 */
export function registerPlanApprovalCallbacks(bot: Bot, stateManager: StateManager): void {
  bot.callbackQuery(/^a:p:([^:]+):approve$/, async (ctx) => {
    const jobId = ctx.match?.[1];
    if (!jobId) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }

    const plan = stateManager.getPendingPlan(jobId);
    if (!plan) {
      await ctx.editMessageText(`❌ Plan not found or already processed: ${escapeHtml(jobId)}`, { parse_mode: "HTML" });
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.editMessageText(
      `✅ <b>Plan approved</b>\n<b>ID:</b> <code>${escapeHtml(jobId)}</code>\n\n<em>Executing on branch...</em>`,
      { parse_mode: "HTML" }
    );

    await ctx.answerCallbackQuery("Plan approved — executing!");
    logger.info({ jobId }, "Plan approved via inline button");
    try {
      const db = stateManager.getDb();
      recordFeedback(db, {
        contentType: "plan",
        contentId: jobId,
        action: "approve",
        source: "telegram",
        delta: 0.15,
      });
    } catch { /* best-effort */ }

    // Fire-and-forget: spawn the selected harness to implement the plan on main (no branch)
    const chatId = ctx.chat?.id;
    if (chatId) {
      stateManager.clearPendingPlan(jobId);
      import("../../harness/dispatch.js").then(({ executeResolvedHarness }) => {
        const prompt = `You are implementing an approved Homer improvement plan.

## The Plan

${plan}

## Instructions

1. Read the relevant source files mentioned in the plan.
2. Implement the changes described. Use your judgment on the best approach.
3. After making changes, run \`npm run build\` in ~/homer/ to verify.
4. If the build fails, fix the issues until it passes.
5. Commit your changes with a descriptive message.
6. Do NOT push to remote, restart the daemon, or modify .env/credentials/CLAUDE.md.
7. Do NOT create git branches — work directly on the current branch.

Output a brief summary of what you changed and whether the build passes.`;

        executeResolvedHarness({
          source: "runtime",
          mode: "runtime-turn",
          prompt,
          cwd: config.paths.homerRoot,
          timeoutMs: 20 * 60 * 1000,
          requiredCapabilities: [
            { capability: "code.edit", required: true, reason: "implement approved plan" },
            { capability: "tools.files.write", required: true, reason: "edit source files" },
            { capability: "tools.shell", required: true, reason: "run npm build + commit" },
          ],
        }).then(async (result) => {
          const summary = (result.output || "completed").slice(0, 1500);
          try {
            await bot.api.sendMessage(chatId,
              `✅ <b>Plan implemented</b>\n<b>ID:</b> <code>${escapeHtml(jobId)}</code>\n<b>Result:</b>\n${escapeHtml(summary)}`,
              { parse_mode: "HTML" }
            );
          } catch { /* best effort */ }
        }).catch(async (err) => {
          logger.error({ jobId, error: err }, "Plan implementation via selected harness failed");
          try {
            await bot.api.sendMessage(chatId,
              `❌ <b>Plan implementation failed</b>\n<b>ID:</b> <code>${escapeHtml(jobId)}</code>\n<code>${escapeHtml(String(err).slice(0, 500))}</code>`,
              { parse_mode: "HTML" }
            );
          } catch { /* best effort */ }
        });
      }).catch(err => {
        logger.error({ jobId, error: err }, "Failed to import harness dispatch");
      });
    }
  });

  bot.callbackQuery(/^a:p:([^:]+):reject$/, async (ctx) => {
    const jobId = ctx.match?.[1];
    if (!jobId) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }

    const plan = stateManager.getPendingPlan(jobId);
    if (!plan) {
      await ctx.editMessageText(`❌ Plan not found or already processed: ${escapeHtml(jobId)}`, { parse_mode: "HTML" });
      await ctx.answerCallbackQuery();
      return;
    }

    stateManager.clearPendingPlan(jobId);

    await ctx.editMessageText(
      `🗑️ <b>Plan rejected</b>\n<b>ID:</b> <code>${escapeHtml(jobId)}</code>`,
      { parse_mode: "HTML" }
    );
    await ctx.answerCallbackQuery("Plan rejected");
    logger.info({ jobId }, "Plan rejected via inline button");
    try {
      const db = stateManager.getDb();
      recordFeedback(db, {
        contentType: "plan",
        contentId: jobId,
        action: "reject",
        source: "telegram",
        delta: -0.1,
      });
    } catch { /* best-effort */ }
  });

  bot.callbackQuery(/^a:p:([^:]+):note$/, async (ctx) => {
    const jobId = ctx.match?.[1];
    if (!jobId) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }

    const plan = stateManager.getPendingPlan(jobId);
    if (!plan) {
      await ctx.editMessageText(`❌ Plan not found or already processed: ${escapeHtml(jobId)}`, { parse_mode: "HTML" });
      await ctx.answerCallbackQuery();
      return;
    }

    try {
      const noteMsg = await ctx.reply(
        `✍️ <b>Add instructions</b>\n<b>Plan ID:</b> <code>${escapeHtml(jobId)}</code>\n\n` +
        `Reply to this message with instructions for the executor.`,
        {
          parse_mode: "HTML",
          reply_markup: { force_reply: true, selective: true },
        }
      );

      pendingInstructionRequests.set(noteMsg.message_id, {
        type: "plan",
        id: jobId,
        createdAt: Date.now(),
      });

      await ctx.answerCallbackQuery("Reply with instructions");
    } catch (error) {
      logger.error({ error, jobId }, "Failed to initiate plan instructions");
      await ctx.answerCallbackQuery("Error starting instruction capture");
    }
  });

}
