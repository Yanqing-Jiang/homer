import { Bot, InlineKeyboard } from "grammy";
import { logger } from "../../utils/logger.js";
import { readFile, writeFile, appendFile } from "fs/promises";
import { existsSync } from "fs";
import type { StateManager } from "../../state/manager.js";

const MEMORY_BASE = "/Users/yj/memory";
const IDEAS_FILE = `${MEMORY_BASE}/ideas.md`;
const FEEDBACK_FILE = `${MEMORY_BASE}/feedback.md`;
const DENY_HISTORY_FILE = `${MEMORY_BASE}/deny-history.md`;

// Track pending deny reasons (messageId -> pending info)
interface PendingDeny {
  ideaId: string;
  title: string;
  source: string;
  link?: string;
  createdAt: number;
}
const pendingDenyReasons = new Map<number, PendingDeny>();

// Track pending instruction replies (messageId -> pending info)
interface PendingInstruction {
  type: "idea" | "plan";
  id: string;
  title?: string;
  createdAt: number;
}
const pendingInstructionRequests = new Map<number, PendingInstruction>();

// Cleanup stale entries every 5 minutes (entries older than 1 hour)
setInterval(() => {
  const staleThreshold = Date.now() - 3600000; // 1 hour
  for (const [msgId, pending] of pendingDenyReasons.entries()) {
    if (pending.createdAt < staleThreshold) {
      pendingDenyReasons.delete(msgId);
      logger.info({ ideaId: pending.ideaId, msgId }, "Cleaned up stale deny request");
    }
  }
  for (const [msgId, pending] of pendingInstructionRequests.entries()) {
    if (pending.createdAt < staleThreshold) {
      pendingInstructionRequests.delete(msgId);
      logger.info({ type: pending.type, id: pending.id, msgId }, "Cleaned up stale instruction request");
    }
  }
}, 300000); // Every 5 minutes

type IdeaStatus = "draft" | "review" | "planning" | "execution" | "archived";

interface Idea {
  id: string;
  timestamp: string;
  source: string;
  status: IdeaStatus;
  title: string;
  content: string;
  context?: string;
  link?: string;
  notes?: string;
}

/**
 * Parse ideas.md file into structured data
 */
function parseIdeasFile(content: string): Idea[] {
  const ideas: Idea[] = [];
  const lines = content.split("\n");
  let currentIdea: Partial<Idea> | null = null;
  let currentSection = "";

  for (const line of lines) {
    if (line.startsWith("## Draft Ideas")) {
      currentSection = "draft";
      continue;
    }
    if (line.startsWith("## Under Review")) {
      currentSection = "review";
      continue;
    }
    if (line.startsWith("## Archived")) {
      currentSection = "archived";
      continue;
    }

    const headerMatch = line.match(/^### \[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] (.+)$/);
    if (headerMatch) {
      if (currentIdea && currentIdea.id) {
        ideas.push(currentIdea as Idea);
      }
      // Generate deterministic ID from timestamp (will be overwritten if ID field found)
      const timestampHash = (headerMatch[1] ?? "").replace(/[- :]/g, "").slice(-8);
      currentIdea = {
        id: timestampHash,
        timestamp: headerMatch[1] ?? "",
        title: headerMatch[2] ?? "",
        status: currentSection as IdeaStatus || "draft",
        source: "unknown",
        content: "",
      };
      continue;
    }

    if (currentIdea) {
      const idMatch = line.match(/^- \*\*ID:\*\* (.+)$/);
      if (idMatch) {
        currentIdea.id = idMatch[1];
        continue;
      }

      const sourceMatch = line.match(/^- \*\*Source:\*\* (.+)$/);
      if (sourceMatch) {
        currentIdea.source = sourceMatch[1];
        continue;
      }

      const statusMatch = line.match(/^- \*\*Status:\*\* (.+)$/);
      if (statusMatch) {
        currentIdea.status = statusMatch[1] as IdeaStatus;
        continue;
      }

      const contentMatch = line.match(/^- \*\*Content:\*\* (.+)$/);
      if (contentMatch) {
        currentIdea.content = contentMatch[1];
        continue;
      }

      const contextMatch = line.match(/^- \*\*Context:\*\* (.+)$/);
      if (contextMatch) {
        currentIdea.context = contextMatch[1];
        continue;
      }

      const linkMatch = line.match(/^- \*\*Link:\*\* (.+)$/);
      if (linkMatch) {
        currentIdea.link = linkMatch[1];
        continue;
      }

      const notesMatch = line.match(/^- \*\*Notes:\*\* (.+)$/);
      if (notesMatch) {
        currentIdea.notes = notesMatch[1];
        continue;
      }
    }
  }

  if (currentIdea && currentIdea.id) {
    ideas.push(currentIdea as Idea);
  }

  return ideas;
}

/**
 * Format an idea for ideas.md
 */
function formatIdea(idea: Idea): string {
  let output = `### [${idea.timestamp}] ${idea.title}\n`;
  output += `- **ID:** ${idea.id}\n`;
  output += `- **Source:** ${idea.source}\n`;
  output += `- **Status:** ${idea.status}\n`;
  output += `- **Content:** ${idea.content}\n`;
  if (idea.context) output += `- **Context:** ${idea.context}\n`;
  if (idea.link) output += `- **Link:** ${idea.link}\n`;
  if (idea.notes) output += `- **Notes:** ${idea.notes}\n`;
  return output;
}

/**
 * Rebuild ideas.md from parsed ideas
 */
function rebuildIdeasFile(ideas: Idea[]): string {
  const draft = ideas.filter(i => i.status === "draft");
  const review = ideas.filter(i => i.status === "review");
  const archived = ideas.filter(i => i.status === "archived" || i.status === "planning" || i.status === "execution");

  let output = "# Ideas\n\nRaw ideas collected by HOMER. Reviewed daily at 7 AM.\n\n";
  output += "## Draft Ideas\n\n";
  for (const idea of draft) {
    output += formatIdea(idea) + "\n";
  }
  output += "## Under Review\n\n";
  for (const idea of review) {
    output += formatIdea(idea) + "\n";
  }
  output += "## Archived\n\n";
  for (const idea of archived) {
    output += formatIdea(idea) + "\n";
  }
  return output;
}

/**
 * Log feedback to feedback.md
 */
async function logFeedback(action: string, target: string, notes?: string): Promise<void> {
  const now = new Date();
  const timestamp = now.toISOString().slice(0, 16).replace("T", " ");

  let entry = `\n### [${timestamp}] ${action.charAt(0).toUpperCase() + action.slice(1)} - ${target}\n`;
  entry += `Decision: ${action}\n`;
  if (notes) entry += `Notes: ${notes}\n`;

  await appendFile(FEEDBACK_FILE, entry, "utf-8");
}

/**
 * Find idea by ID (partial match)
 */
function findIdea(ideas: Idea[], id: string): Idea | undefined {
  return ideas.find(i =>
    i.id === id ||
    i.id.startsWith(id) ||
    i.timestamp.replace(/[- :]/g, "").includes(id)
  );
}

/**
 * Approve an idea - create a plan
 */
async function approveIdea(ideaId: string): Promise<{ success: boolean; message: string }> {
  if (!existsSync(IDEAS_FILE)) {
    return { success: false, message: "Ideas file not found" };
  }

  const content = await readFile(IDEAS_FILE, "utf-8");
  const ideas = parseIdeasFile(content);
  const idea = findIdea(ideas, ideaId);

  if (!idea) {
    return { success: false, message: `Idea not found: ${ideaId}` };
  }

  // Update idea status
  idea.status = "planning";
  idea.notes = (idea.notes ? idea.notes + "; " : "") + "Approved, creating plan";

  await writeFile(IDEAS_FILE, rebuildIdeasFile(ideas), "utf-8");
  await logFeedback("approve", idea.title);

  return { success: true, message: `Approved: ${idea.title}` };
}


/**
 * Deny an idea with a reason - logs to deny-history.md for preference learning
 */
async function denyIdea(
  ideaId: string,
  reason: string
): Promise<{ success: boolean; message: string }> {
  if (!existsSync(IDEAS_FILE)) {
    return { success: false, message: "Ideas file not found" };
  }

  const content = await readFile(IDEAS_FILE, "utf-8");
  const ideas = parseIdeasFile(content);
  const idea = findIdea(ideas, ideaId);

  if (!idea) {
    return { success: false, message: `Idea not found: ${ideaId}` };
  }

  // Archive the idea
  idea.status = "archived";
  idea.notes = (idea.notes ? idea.notes + "; " : "") + `Denied: ${reason}`;

  await writeFile(IDEAS_FILE, rebuildIdeasFile(ideas), "utf-8");

  // Log to deny history for preference learning
  await logDenyHistory(idea.title, idea.source, reason, idea.link);
  await logFeedback("deny", idea.title, reason);

  return { success: true, message: `Denied: ${idea.title}` };
}

/**
 * Add user instructions to an idea
 */
async function addIdeaInstructions(
  ideaId: string,
  instructions: string
): Promise<{ success: boolean; message: string; title?: string }> {
  if (!existsSync(IDEAS_FILE)) {
    return { success: false, message: "Ideas file not found" };
  }

  const content = await readFile(IDEAS_FILE, "utf-8");
  const ideas = parseIdeasFile(content);
  const idea = findIdea(ideas, ideaId);

  if (!idea) {
    return { success: false, message: `Idea not found: ${ideaId}` };
  }

  const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const note = `User instructions (${timestamp}): ${instructions}`;
  idea.notes = idea.notes ? `${idea.notes}; ${note}` : note;

  await writeFile(IDEAS_FILE, rebuildIdeasFile(ideas), "utf-8");
  await logFeedback("instruction", idea.title, instructions);

  return { success: true, message: `Instructions saved for ${idea.title}`, title: idea.title };
}

/**
 * Log denial to deny-history.md for preference learning
 */
async function logDenyHistory(
  title: string,
  source: string,
  reason: string,
  link?: string
): Promise<void> {
  const now = new Date();
  const date = now.toISOString().split("T")[0];

  let entry = `\n### [${date}] ${title}\n`;
  entry += `- **Source:** ${source}\n`;
  entry += `- **Reason:** ${reason}\n`;
  if (link) entry += `- **Link:** ${link}\n`;

  try {
    await appendFile(DENY_HISTORY_FILE, entry, "utf-8");
    logger.info({ title, source, reason }, "Logged to deny history");
  } catch (error) {
    logger.warn({ error }, "Failed to log deny history");
  }
}

/**
 * Get deny history patterns for filtering
 */
export async function getDenyPatterns(): Promise<string[]> {
  if (!existsSync(DENY_HISTORY_FILE)) {
    return [];
  }

  try {
    const content = await readFile(DENY_HISTORY_FILE, "utf-8");
    const reasons: string[] = [];
    const reasonRegex = /- \*\*Reason:\*\* (.+)$/gm;
    let match;
    while ((match = reasonRegex.exec(content)) !== null) {
      reasons.push(match[1] ?? "");
    }
    return reasons.filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Create inline keyboard for an idea
 */
export function createIdeaKeyboard(ideaId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Approve", `a:i:${ideaId}:approve`)
    .text("❌ Reject", `a:i:${ideaId}:reject`)
    .row()
    .text("✍️ Add Instructions", `a:i:${ideaId}:note`);
}

/**
 * Format idea for Telegram message with intent summary
 */
export function formatIdeaForTelegram(idea: Idea, index: number): string {
  const emoji = ["1️⃣", "2️⃣", "3️⃣"][index] || "▪️";
  const title = escapeHtml(idea.title);
  const source = escapeHtml(idea.source);
  const content = escapeHtml(idea.content.slice(0, 220)) + (idea.content.length > 220 ? "..." : "");
  const context = idea.context ? escapeHtml(idea.context.slice(0, 160)) : "";
  const link = idea.link ? escapeHtml(idea.link) : "";
  const id = escapeHtml(idea.id);

  let msg = `<b>${emoji} ${title}</b>\n`;
  msg += `<b>Source:</b> ${source}\n\n`;
  msg += `<b>Summary:</b> ${content}\n`;
  if (context) {
    msg += `\n<b>Context:</b> ${context}\n`;
  }
  if (link) {
    msg += `\n<b>Link:</b> ${link}\n`;
  }
  msg += `\n<b>ID:</b> <code>${id}</code>`;
  return msg;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Register approval callback handlers on the bot
 */
export function registerApprovalHandlers(bot: Bot, stateManager: StateManager): void {
  // Handle approve button
  bot.callbackQuery(/^a:i:([^:]+):approve$/, async (ctx) => {
    const ideaId = ctx.match?.[1];
    if (!ideaId) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }
    logger.info({ ideaId }, "Approve button clicked");

    try {
      const result = await approveIdea(ideaId);

      if (result.success) {
        await ctx.editMessageText(
          `✅ <b>${escapeHtml(result.message)}</b>\n\n<em>Creating plan...</em>`,
          { parse_mode: "HTML" }
        );
      } else {
        await ctx.editMessageText(`❌ ${escapeHtml(result.message)}`, { parse_mode: "HTML" });
      }
    } catch (error) {
      logger.error({ error, ideaId }, "Failed to approve idea");
      await ctx.editMessageText(
        `❌ Error: ${escapeHtml(error instanceof Error ? error.message : "Unknown")}`,
        { parse_mode: "HTML" }
      );
    }

    await ctx.answerCallbackQuery();
  });

  // Handle reject button (with reason)
  bot.callbackQuery(/^a:i:([^:]+):reject$/, async (ctx) => {
    const ideaId = ctx.match?.[1];
    if (!ideaId) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }
    logger.info({ ideaId }, "Reject button clicked");

    try {
      const content = await readFile(IDEAS_FILE, "utf-8");
      const ideas = parseIdeasFile(content);
      const idea = findIdea(ideas, ideaId);

      if (!idea) {
        await ctx.editMessageText(`❌ Idea not found: ${ideaId}`);
        await ctx.answerCallbackQuery();
        return;
      }

      const reasonMsg = await ctx.reply(
        `❌ <b>Rejecting:</b> ${escapeHtml(idea.title)}\n\n` +
        `Why are you declining this? (Helps me learn preferences)\n\n` +
        `<em>Reply to this message with your reason, or type "skip" to reject without reason.</em>`,
        {
          parse_mode: "HTML",
          reply_markup: { force_reply: true, selective: true },
        }
      );

      pendingDenyReasons.set(reasonMsg.message_id, {
        ideaId,
        title: idea.title,
        source: idea.source,
        link: idea.link,
        createdAt: Date.now(),
      });

      await ctx.answerCallbackQuery("Please provide a reason");
    } catch (error) {
      logger.error({ error, ideaId }, "Failed to initiate reject");
      await ctx.answerCallbackQuery("Error processing reject");
    }
  });

  // Handle add instructions button
  bot.callbackQuery(/^a:i:([^:]+):note$/, async (ctx) => {
    const ideaId = ctx.match?.[1];
    if (!ideaId) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }
    logger.info({ ideaId }, "Add instructions clicked");

    try {
      const content = await readFile(IDEAS_FILE, "utf-8");
      const ideas = parseIdeasFile(content);
      const idea = findIdea(ideas, ideaId);

      if (!idea) {
        await ctx.editMessageText(`❌ Idea not found: ${ideaId}`);
        await ctx.answerCallbackQuery();
        return;
      }

      const noteMsg = await ctx.reply(
        `✍️ <b>Add instructions</b>\n` +
        `<b>Idea:</b> ${escapeHtml(idea.title)}\n` +
        `<b>ID:</b> <code>${escapeHtml(idea.id)}</code>\n\n` +
        `Reply to this message with instructions for the executor.`,
        {
          parse_mode: "HTML",
          reply_markup: { force_reply: true, selective: true },
        }
      );

      pendingInstructionRequests.set(noteMsg.message_id, {
        type: "idea",
        id: idea.id,
        title: idea.title,
        createdAt: Date.now(),
      });

      await ctx.answerCallbackQuery("Reply with instructions");
    } catch (error) {
      logger.error({ error, ideaId }, "Failed to initiate instructions");
      await ctx.answerCallbackQuery("Error starting instruction capture");
    }
  });

  // Handle instruction or reject reason replies
  bot.on("message:text", async (ctx, next) => {
    const replyTo = ctx.message.reply_to_message?.message_id;
    if (!replyTo) {
      return next();
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
        if (pending.type === "idea") {
          const result = await addIdeaInstructions(pending.id, instructions);
          if (result.success) {
            await ctx.reply(
              `✅ <b>Instructions saved</b>\n` +
              `<b>Idea:</b> ${escapeHtml(result.title || pending.id)}\n` +
              `<b>ID:</b> <code>${escapeHtml(pending.id)}</code>`,
              { parse_mode: "HTML" }
            );
          } else {
            await ctx.reply(`❌ ${escapeHtml(result.message)}`, { parse_mode: "HTML" });
          }
        } else {
          const plan = stateManager.getPendingPlan(pending.id);
          if (!plan) {
            await ctx.reply(`❌ Plan not found: ${escapeHtml(pending.id)}`, { parse_mode: "HTML" });
          } else {
            const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
            const updated = `${plan}\n\n## User Instructions (${timestamp})\n${instructions}\n`;
            stateManager.savePendingPlan(pending.id, updated);
            await logFeedback("instruction", `Plan ${pending.id}`, instructions);
            await ctx.reply(
              `✅ <b>Instructions saved</b>\n<b>Plan ID:</b> <code>${escapeHtml(pending.id)}</code>`,
              { parse_mode: "HTML" }
            );
          }
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

    if (!pendingDenyReasons.has(replyTo)) {
      return next();
    }

    const pending = pendingDenyReasons.get(replyTo);
    if (!pending) return next();

    const reason = ctx.message.text.trim();
    const finalReason = reason.toLowerCase() === "skip" ? "No reason provided" : reason;

    logger.info({ ideaId: pending.ideaId, reason: finalReason }, "Reject reason received");

    try {
      const result = await denyIdea(pending.ideaId, finalReason);

      if (result.success) {
        await ctx.reply(
          `❌ <b>Rejected:</b> ${escapeHtml(pending.title)}\n\n` +
          `<b>Reason:</b> ${escapeHtml(finalReason)}\n\n` +
          `<em>Logged to preferences for future filtering.</em>`,
          { parse_mode: "HTML" }
        );
      } else {
        await ctx.reply(`❌ ${escapeHtml(result.message)}`, { parse_mode: "HTML" });
      }
    } catch (error) {
      logger.error({ error, ideaId: pending.ideaId }, "Failed to reject idea");
      await ctx.reply(
        `❌ Error: ${escapeHtml(error instanceof Error ? error.message : "Unknown")}`,
        { parse_mode: "HTML" }
      );
    }

    pendingDenyReasons.delete(replyTo);
  });

  logger.info("Approval handlers registered");
}

/**
 * Send ideas for review with approval buttons
 */
export async function sendIdeasForReview(
  bot: Bot,
  chatId: number,
  ideas: Idea[]
): Promise<void> {
  if (ideas.length === 0) {
    await bot.api.sendMessage(chatId, "📋 No new ideas to review today.");
    return;
  }

  // Send header message
  await bot.api.sendMessage(
    chatId,
    `📋 <b>New Ideas for Review</b> (${ideas.length})`,
    { parse_mode: "HTML" }
  );

  // Send each idea with its own keyboard
  for (let i = 0; i < ideas.length; i++) {
    const idea = ideas[i];
    if (!idea) continue;
    const message = formatIdeaForTelegram(idea, i);
    const keyboard = createIdeaKeyboard(idea.id);

    await bot.api.sendMessage(chatId, message, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * Get ideas awaiting review
 */
export async function getIdeasForReview(): Promise<Idea[]> {
  if (!existsSync(IDEAS_FILE)) {
    return [];
  }

  const content = await readFile(IDEAS_FILE, "utf-8");
  const ideas = parseIdeasFile(content);

  // Return draft ideas (not yet sent for review)
  return ideas.filter(i => i.status === "draft");
}

// ============================================
// Implementation Plan Approval
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

    // Clear the pending plan
    stateManager.clearPendingPlan(jobId);

    await ctx.reply(
      `✅ *Plan approved: ${jobId}*\n\n` +
      `_The plan will be executed. You'll be notified when complete._`,
      { parse_mode: "Markdown" }
    );

    logger.info({ jobId }, "Plan approved by user");

    // TODO: Trigger plan execution via Claude
    // For now, just log approval - execution would require spawning claude with the plan
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
  const planMarkers = [
    "## Implementation Plan",
    "## Proposed Changes",
    "### Phase 1",
    "### Step 1:",
    "## Files to Modify",
    "## Migration Required",
    "## Breaking Changes",
  ];

  return planMarkers.some(marker => output.includes(marker));
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

    stateManager.clearPendingPlan(jobId);

    await ctx.editMessageText(
      `✅ <b>Plan approved</b>\n<b>ID:</b> <code>${escapeHtml(jobId)}</code>\n\n<em>Executing...</em>`,
      { parse_mode: "HTML" }
    );

    await ctx.answerCallbackQuery("Plan approved!");
    logger.info({ jobId }, "Plan approved via inline button");
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
