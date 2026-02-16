import { Bot, InlineKeyboard } from "grammy";
import { logger } from "../../utils/logger.js";
import { readFile, writeFile, appendFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { StateManager } from "../../state/manager.js";

const MEMORY_BASE = "/Users/yj/memory";
const IDEAS_FILE = `${MEMORY_BASE}/ideas.md`;
const IDEAS_DIR = `${MEMORY_BASE}/ideas`;
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

let stateManagerRef: StateManager | null = null;

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

type IdeaStatus = "draft" | "review" | "discussion" | "planning" | "execution" | "archived";

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
  tags?: string[];
}

/**
 * Parse a single idea file with YAML frontmatter (~/memory/ideas/*.md)
 */
function parseIdeaFile(content: string, filename: string): Idea | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1] ?? "";
  const body = fmMatch[2] ?? "";

  const get = (key: string): string => {
    const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m?.[1]?.trim() ?? "";
  };

  const id = get("id") || filename.replace(/\.md$/, "");
  const status = get("status") as IdeaStatus || "draft";
  const title = get("title");
  if (!title) return null;

  const tagsRaw = get("tags");
  const tags = tagsRaw ? tagsRaw.replace(/^\[|\]$/g, "").split(",").map(t => t.trim()).filter(Boolean) : [];

  // Extract context section if present
  const contextMatch = body.match(/## Context\n([\s\S]*?)(?=\n##|$)/);
  const contextText = contextMatch?.[1]?.trim() ?? "";

  // Body before first ## section is the main content
  const mainContent = body.split(/\n## /)[0]?.trim() ?? "";

  return {
    id,
    timestamp: get("created") || "",
    source: get("source") || "unknown",
    status,
    title,
    content: mainContent,
    context: contextText || undefined,
    link: get("link") || undefined,
    notes: get("notes") || undefined,
    tags: tags.length > 0 ? tags : undefined,
  };
}

/**
 * Load all ideas from ~/memory/ideas/ directory (new file-based system)
 */
async function loadIdeasFromDir(): Promise<Idea[]> {
  if (!existsSync(IDEAS_DIR)) return [];

  const files = await readdir(IDEAS_DIR);
  const mdFiles = files.filter(f => f.endsWith(".md")).sort();
  const ideas: Idea[] = [];

  for (const file of mdFiles) {
    try {
      const content = await readFile(join(IDEAS_DIR, file), "utf-8");
      const idea = parseIdeaFile(content, file);
      if (idea) ideas.push(idea);
    } catch (error) {
      logger.warn({ file, error }, "Failed to parse idea file");
    }
  }

  return ideas;
}

/**
 * Update an idea file's YAML frontmatter field
 */
async function updateIdeaFileField(ideaId: string, field: string, value: string): Promise<boolean> {
  if (!existsSync(IDEAS_DIR)) return false;

  const files = await readdir(IDEAS_DIR);
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const filepath = join(IDEAS_DIR, file);
    const content = await readFile(filepath, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;

    const fm = fmMatch[1] ?? "";
    const idMatch = fm.match(/^id:\s*(.+)$/m);
    const fileId = idMatch?.[1]?.trim() ?? file.replace(/\.md$/, "");

    if (fileId === ideaId || fileId.startsWith(ideaId) || file.replace(/\.md$/, "") === ideaId) {
      const fieldRegex = new RegExp(`^${field}:.*$`, "m");
      let newContent: string;
      if (fieldRegex.test(fm)) {
        newContent = content.replace(
          new RegExp(`(^---\\n[\\s\\S]*?)^${field}:.*$`, "m"),
          `$1${field}: ${value}`
        );
      } else {
        // Add field before closing ---
        newContent = content.replace(/^(---\n[\s\S]*?)\n---/, `$1\n${field}: ${value}\n---`);
      }
      await writeFile(filepath, newContent, "utf-8");
      return true;
    }
  }
  return false;
}

/**
 * Append a note to an idea file's body
 */
async function appendIdeaNote(ideaId: string, note: string): Promise<boolean> {
  if (!existsSync(IDEAS_DIR)) return false;

  const files = await readdir(IDEAS_DIR);
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const filepath = join(IDEAS_DIR, file);
    const content = await readFile(filepath, "utf-8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;

    const fm = fmMatch[1] ?? "";
    const idMatch = fm.match(/^id:\s*(.+)$/m);
    const fileId = idMatch?.[1]?.trim() ?? file.replace(/\.md$/, "");

    if (fileId === ideaId || fileId.startsWith(ideaId) || file.replace(/\.md$/, "") === ideaId) {
      const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      const appendText = `\n\n## Notes\n- [${timestamp}] ${note}\n`;
      await writeFile(filepath, content.trimEnd() + appendText, "utf-8");
      return true;
    }
  }
  return false;
}

/**
 * Parse ideas.md file into structured data (LEGACY - kept for backward compat)
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
  const review = ideas.filter(i => i.status === "review" || i.status === "discussion");
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
 * Archive an idea (no reason required)
 */
async function archiveIdea(
  ideaId: string,
  reason: string = "Archived"
): Promise<{ success: boolean; message: string; idea?: Idea }> {
  // Try file-based system first
  const dirIdeas = await loadIdeasFromDir();
  const dirIdea = dirIdeas.find(i => i.id === ideaId || i.id.startsWith(ideaId));

  if (dirIdea) {
    const updated = await updateIdeaFileField(ideaId, "status", "archived");
    if (updated) {
      await appendIdeaNote(ideaId, reason);
      await logDenyHistory(dirIdea.title, dirIdea.source, reason, dirIdea.link);
      await logFeedback("archive", dirIdea.title, reason);
      return { success: true, message: `Archived: ${dirIdea.title}`, idea: dirIdea };
    }
  }

  // Fallback to legacy ideas.md
  if (!existsSync(IDEAS_FILE)) {
    return { success: false, message: `Idea not found: ${ideaId}` };
  }

  const content = await readFile(IDEAS_FILE, "utf-8");
  const ideas = parseIdeasFile(content);
  const idea = findIdea(ideas, ideaId);

  if (!idea) {
    return { success: false, message: `Idea not found: ${ideaId}` };
  }

  idea.status = "archived";
  idea.notes = (idea.notes ? idea.notes + "; " : "") + reason;
  await writeFile(IDEAS_FILE, rebuildIdeasFile(ideas), "utf-8");

  await logDenyHistory(idea.title, idea.source, reason, idea.link);
  await logFeedback("archive", idea.title, reason);

  return { success: true, message: `Archived: ${idea.title}`, idea };
}


/**
 * Add user instructions to an idea
 */
async function addIdeaInstructions(
  ideaId: string,
  instructions: string
): Promise<{ success: boolean; message: string; title?: string }> {
  // Try file-based system first
  const dirIdeas = await loadIdeasFromDir();
  const dirIdea = dirIdeas.find(i => i.id === ideaId || i.id.startsWith(ideaId));

  if (dirIdea) {
    const updated = await appendIdeaNote(ideaId, `User instructions: ${instructions}`);
    if (updated) {
      await logFeedback("instruction", dirIdea.title, instructions);
      return { success: true, message: `Instructions saved for ${dirIdea.title}`, title: dirIdea.title };
    }
  }

  // Fallback to legacy ideas.md
  if (!existsSync(IDEAS_FILE)) {
    return { success: false, message: `Idea not found: ${ideaId}` };
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
    .text("💬 Talk", `a:i:${ideaId}:talk`)
    .text("🗂 Archive", `a:i:${ideaId}:archive`);
}

/**
 * Format idea for Telegram message with intent summary
 */
export function formatIdeaForTelegram(idea: Idea, index: number): string {
  const emoji = ["1️⃣", "2️⃣", "3️⃣"][index] || "▪️";
  const title = escapeHtml(idea.title);
  const source = escapeHtml(idea.source);
  const tagsStr = idea.tags?.length ? ` · ${idea.tags.map(t => escapeHtml(t)).join(", ")}` : "";
  const id = escapeHtml(idea.id);

  // Build summary from content + context, targeting 500-800 chars
  let summary = idea.content || "";
  if (idea.context && summary.length < 500) {
    summary += "\n\n" + idea.context;
  }
  summary = summary.slice(0, 800);
  if (summary.length === 800) summary = summary.slice(0, summary.lastIndexOf(" ")) + "...";
  const summaryHtml = escapeHtml(summary);

  let msg = `<b>${emoji} ${title}</b>\n`;
  msg += `${source}${tagsStr}\n\n`;
  msg += `${summaryHtml}\n`;
  if (idea.link) {
    msg += `\n<a href="${escapeHtml(idea.link)}">Source link</a>\n`;
  }
  msg += `\n<code>${id}</code>`;
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
  stateManagerRef = stateManager;
  // Handle legacy approve button (no longer active — kept for old messages)
  bot.callbackQuery(/^a:i:([^:]+):approve$/, async (ctx) => {
    await ctx.answerCallbackQuery("This button is no longer active");
  });

  // Handle archive button
  bot.callbackQuery(/^a:i:([^:]+):archive$/, async (ctx) => {
    const ideaId = ctx.match?.[1];
    if (!ideaId) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }
    logger.info({ ideaId }, "Archive button clicked");

    try {
      const result = await archiveIdea(ideaId);

      if (result.success) {
        await ctx.editMessageText(`🗂 <b>${escapeHtml(result.message)}</b>`, { parse_mode: "HTML" });
      } else {
        await ctx.editMessageText(`❌ ${escapeHtml(result.message)}`, { parse_mode: "HTML" });
      }
    } catch (error) {
      logger.error({ error, ideaId }, "Failed to archive idea");
      await ctx.answerCallbackQuery("Error processing archive");
    }
  });

  // Handle talk button — triggers multi-model analysis
  bot.callbackQuery(/^a:i:([^:]+):talk$/, async (ctx) => {
    const ideaId = ctx.match?.[1];
    if (!ideaId) {
      await ctx.answerCallbackQuery("Invalid request");
      return;
    }
    logger.info({ ideaId }, "Talk button clicked — starting analysis");

    try {
      await ctx.answerCallbackQuery("Starting analysis...");

      // Load idea
      const dirIdeas = await loadIdeasFromDir();
      const idea = dirIdeas.find(i => i.id === ideaId || i.id.startsWith(ideaId));

      if (!idea) {
        await ctx.editMessageText(`❌ Idea not found: ${escapeHtml(ideaId)}`, { parse_mode: "HTML" });
        return;
      }

      // Update message to show analysis in progress
      await ctx.editMessageText(
        `🔬 <b>Analyzing: ${escapeHtml(idea.title)}</b>\n` +
        `Running multi-model analysis (codex + flash + kimi)...\n` +
        `Results in 1-5 minutes.`,
        { parse_mode: "HTML" }
      );

      // Update status + append note
      await updateIdeaFileField(ideaId, "status", "discussion");
      await appendIdeaNote(ideaId, "Multi-model analysis started");
      await logFeedback("talk", idea.title);

      // Build notify callback using bot.api (ctx expires after handler returns)
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      const notify = async (text: string, _parseMode?: string) => {
        await bot.api.sendMessage(chatId, text);
      };

      // Fire-and-forget analysis
      import("../../ideas/analyze.js").then(({ analyzeIdea }) => {
        analyzeIdea(
          {
            id: idea.id,
            title: idea.title,
            content: idea.content,
            context: idea.context,
            link: idea.link,
            source: idea.source,
            tags: idea.tags,
            notes: idea.notes,
          },
          notify
        ).then(() => {
          appendIdeaNote(ideaId, "Analysis complete").catch(() => {});
        }).catch(async (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ ideaId, error: msg }, "Idea analysis failed");
          await bot.api.sendMessage(chatId, `❌ Analysis failed for "${idea.title}": ${msg}`);
        });
      }).catch(err => {
        logger.error({ ideaId, error: err }, "Failed to import analyze module");
      });
    } catch (error) {
      logger.error({ error, ideaId }, "Failed to initiate analysis");
      await ctx.answerCallbackQuery("Error starting analysis");
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
      // Look up idea from both systems
      const dirIdeas = await loadIdeasFromDir();
      let idea = dirIdeas.find(i => i.id === ideaId || i.id.startsWith(ideaId));

      if (!idea && existsSync(IDEAS_FILE)) {
        const content = await readFile(IDEAS_FILE, "utf-8");
        const legacyIdeas = parseIdeasFile(content);
        idea = findIdea(legacyIdeas, ideaId);
      }

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

    // Legacy reject reason flow (unused)
    pendingDenyReasons.delete(replyTo);
    return next();
  });

  logger.info("Approval handlers registered");
}

/**
 * Send a batch of draft ideas for review (up to daily limit).
 * Sends all ideas simultaneously as separate messages with Talk+Archive buttons.
 * Returns the number of ideas sent.
 */
export async function sendBatchIdeasForReview(bot: Bot, chatId: number, dailyLimit: number = 3): Promise<number> {
  // Check remaining daily quota
  let remaining = dailyLimit;
  if (stateManagerRef) {
    const sentCount = stateManagerRef.getIdeaReviewCount();
    remaining = dailyLimit - sentCount;
    if (remaining <= 0) {
      logger.info({ sentCount, dailyLimit }, "Daily idea review limit reached");
      return 0;
    }
  }

  // Load drafts from BOTH systems, dedup by ID
  const dirIdeas = await loadIdeasFromDir();
  const dirDrafts = dirIdeas.filter(i => i.status === "draft");

  let legacyDrafts: Idea[] = [];
  if (existsSync(IDEAS_FILE)) {
    const content = await readFile(IDEAS_FILE, "utf-8");
    const legacyIdeas = parseIdeasFile(content);
    const existingIds = new Set(dirDrafts.map(i => i.id));
    legacyDrafts = legacyIdeas.filter(i => i.status === "draft" && !existingIds.has(i.id));
  }

  const allDrafts = [...dirDrafts, ...legacyDrafts].slice(0, remaining);

  if (allDrafts.length === 0) {
    return 0;
  }

  // Send header
  await bot.api.sendMessage(
    chatId,
    `📋 <b>Ideas for Review</b> (${allDrafts.length})`,
    { parse_mode: "HTML" }
  );

  // Send each idea with buttons, mark as "review"
  let sent = 0;
  for (let i = 0; i < allDrafts.length; i++) {
    const idea = allDrafts[i]!;
    const message = formatIdeaForTelegram(idea, i);
    const keyboard = createIdeaKeyboard(idea.id);

    try {
      await bot.api.sendMessage(chatId, message, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      sent++;

      // Mark as review only after successful send
      const isFileBased = dirDrafts.some(d => d.id === idea.id);
      if (isFileBased) {
        await updateIdeaFileField(idea.id, "status", "review");
      } else {
        // Legacy system — update in memory and write once after loop
        idea.status = "review";
      }
    } catch (error) {
      logger.error({ error, ideaId: idea.id }, "Failed to send idea for review");
    }

    // Small delay to avoid rate limiting
    if (i < allDrafts.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  // Write legacy file once if any legacy ideas were updated
  const updatedLegacy = allDrafts.filter(i => i.status === "review" && legacyDrafts.some(l => l.id === i.id));
  if (updatedLegacy.length > 0 && existsSync(IDEAS_FILE)) {
    const content = await readFile(IDEAS_FILE, "utf-8");
    const legacyIdeas = parseIdeasFile(content);
    for (const updated of updatedLegacy) {
      const found = findIdea(legacyIdeas, updated.id);
      if (found) found.status = "review";
    }
    await writeFile(IDEAS_FILE, rebuildIdeasFile(legacyIdeas), "utf-8");
  }

  if (stateManagerRef && sent > 0) {
    stateManagerRef.incrementIdeaReviewCount(sent);
  }

  logger.info({ count: sent, ids: allDrafts.filter(i => i.status === "review").map(i => i.id) }, "Sent batch ideas for review");
  return sent;
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

    // Clear the pending plan (prevent double-execution)
    stateManager.clearPendingPlan(jobId);

    await ctx.reply(
      `✅ *Plan approved: ${jobId}*\n\n` +
      `_Executing on branch..._`,
      { parse_mode: "Markdown" }
    );

    logger.info({ jobId }, "Plan approved by user");

    // Fire-and-forget plan execution
    import("../../scheduler/plan-executor.js").then(({ executePlan }) => {
      executePlan({
        jobId,
        plan,
        stateManager,
        bot,
        chatId: ctx.chat?.id ?? 0,
      }).catch(err => {
        logger.error({ jobId, error: err }, "Plan execution failed (command)");
      });
    }).catch(err => {
      logger.error({ jobId, error: err }, "Failed to import plan-executor");
    });
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

    // Fire-and-forget plan execution — clear plan only after launch succeeds
    const chatId = ctx.chat?.id;
    if (chatId) {
      import("../../scheduler/plan-executor.js").then(({ executePlan }) => {
        stateManager.clearPendingPlan(jobId);
        executePlan({
          jobId,
          plan,
          stateManager,
          bot,
          chatId,
        }).catch(err => {
          logger.error({ jobId, error: err }, "Plan execution failed (inline)");
        });
      }).catch(err => {
        logger.error({ jobId, error: err }, "Failed to import plan-executor");
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
