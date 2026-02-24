import { Bot, InlineKeyboard } from "grammy";
import { logger } from "../../utils/logger.js";
import {
  parseIdeaFile,
  saveIdeaFile,
  loadIdeasFromDir,
  getIdeasPaths,
  type ParsedIdea,
} from "../../ideas/parser.js";
import * as dao from "../../ideas/dao.js";
import { join } from "path";
import { readdirSync, unlinkSync } from "fs";
import type { StateManager } from "../../state/manager.js";

/**
 * Register /idea command and its subcommands
 */
let stateManagerRef: StateManager | null = null;

export function registerIdeaCommands(bot: Bot, stateManager: unknown): void {
  stateManagerRef = stateManager as StateManager;
  bot.command("idea", async (ctx) => {
    const input = ctx.match?.trim() || "";
    const parts = input.split(/\s+/);
    const subcommand = (parts[0] || "list").toLowerCase();

    try {
      switch (subcommand) {
        case "add":
          await handleAdd(ctx, parts.slice(1).join(" "));
          break;
        case "list":
          await handleList(ctx, parts[1]);
          break;
        case "get":
          await handleGet(ctx, parts[1]);
          break;
        case "update":
          await handleUpdate(ctx, parts[1], parts[2], parts.slice(3).join(" "));
          break;
        case "archive":
          await handleArchive(ctx, parts[1]);
          break;
        case "delete":
          await handleDelete(ctx, parts[1]);
          break;
        case "search":
          await handleSearch(ctx, parts.slice(1).join(" "));
          break;
        default:
          // Treat as "add" if no recognized subcommand
          await handleAdd(ctx, input);
          break;
      }
    } catch (error) {
      logger.error({ error, subcommand }, "Error handling /idea command");
      await ctx.reply(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  });

  logger.info("Idea command handler registered");
}

// --- Subcommand handlers ---

async function handleAdd(ctx: any, titleInput: string): Promise<void> {
  if (!titleInput.trim()) {
    await ctx.reply(
      "*Usage:* `/idea add <title>`\n\n" +
      "Examples:\n" +
      "- `/idea add Build a CLI tool for resume parsing`\n" +
      "- `/idea add Evaluate Google A2A framework for Homer`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const title = titleInput.trim();

  // Check for duplicates by title similarity
  const db = getDb();
  const existing = db ? dao.getAllIdeas(db) : loadIdeasFromDir();
  const lowerTitle = title.toLowerCase();
  const dupe = existing.find((i) =>
    i.title.toLowerCase() === lowerTitle ||
    i.title.toLowerCase().includes(lowerTitle) ||
    lowerTitle.includes(i.title.toLowerCase())
  );

  if (dupe) {
    await ctx.reply(
      `Similar idea already exists:\n\n` +
      `*${dupe.title}*\n` +
      `Status: ${dupe.status} | ID: \`${dupe.id}\``,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Generate ID from timestamp
  const now = new Date();
  const id = `idea_${now.toISOString().replace(/[-:T]/g, "").slice(0, 12)}`;

  const idea: ParsedIdea = {
    id,
    title,
    content: title,
    status: "draft",
    source: "telegram",
    tags: [],
    timestamp: now.toISOString(),
  };

  if (db) {
    dao.createIdea(db, idea);
  } else {
    saveIdeaFile(idea);
  }

  const keyboard = new InlineKeyboard()
    .text("Archive", `a:i:${id}:archive`)
    .text("Review Now", `idea:review:${id}`);

  await ctx.reply(
    `*Idea added*\n\n` +
    `*${title}*\n` +
    `ID: \`${id}\`\n` +
    `Status: draft`,
    { parse_mode: "Markdown", reply_markup: keyboard }
  );

  logger.info({ id, title, source: "telegram" }, "Idea added via /idea command");
}

async function handleList(ctx: any, statusFilter?: string): Promise<void> {
  const db = getDb();
  const filter = statusFilter?.toLowerCase() || "draft";
  const ideas = (filter === "all")
    ? (db ? dao.getAllIdeas(db) : loadIdeasFromDir())
    : (db ? dao.getAllIdeas(db, { status: filter }) : loadIdeasFromDir());

  const validStatuses = ["draft", "review", "planning", "execution", "archived", "all"];
  if (!validStatuses.includes(filter)) {
    await ctx.reply(
      `Invalid status. Use: ${validStatuses.join(", ")}`,
    );
    return;
  }

  const filtered = filter === "all" ? ideas : ideas.filter((i) => i.status === filter);

  if (filtered.length === 0) {
    await ctx.reply(`No ideas with status: *${filter}*`, { parse_mode: "Markdown" });
    return;
  }

  // Show max 15 ideas
  const shown = filtered.slice(0, 15);
  let response = `*Ideas — ${filter}* (${filtered.length} total)\n\n`;

  for (const idea of shown) {
    const shortId = idea.id.replace("idea_", "");
    const link = idea.link ? " 🔗" : "";
    response += `\`${shortId}\` ${idea.title}${link}\n`;
  }

  if (filtered.length > 15) {
    response += `\n_...and ${filtered.length - 15} more_`;
  }

  response += "\n\n_Use_ `/idea get <id>` _for details_";

  try {
    await ctx.reply(response, { parse_mode: "Markdown" });
  } catch {
    await ctx.reply(response.replace(/[*_`]/g, ""));
  }
}

async function handleGet(ctx: any, idInput?: string): Promise<void> {
  if (!idInput) {
    await ctx.reply("Usage: `/idea get <id>`", { parse_mode: "Markdown" });
    return;
  }

  const idea = findIdeaById(idInput);
  if (!idea) {
    await ctx.reply(`Idea not found: \`${idInput}\``, { parse_mode: "Markdown" });
    return;
  }

  let response = `*${idea.title}*\n\n`;
  response += `ID: \`${idea.id}\`\n`;
  response += `Status: *${idea.status}*\n`;
  response += `Source: ${idea.source || "unknown"}\n`;
  if (idea.tags?.length) response += `Tags: ${idea.tags.join(", ")}\n`;
  if (idea.link) response += `Link: ${idea.link}\n`;
  response += `Created: ${idea.timestamp}\n`;

  if (idea.context) {
    response += `\n*Context:* ${truncate(idea.context, 300)}\n`;
  }
  if (idea.notes) {
    response += `\n*Notes:* ${truncate(idea.notes, 300)}\n`;
  }

  // Action buttons based on status
  const keyboard = new InlineKeyboard();
  if (idea.status === "draft" || idea.status === "review") {
    keyboard.text("Talk", `a:i:${idea.id}:talk`);
    keyboard.text("Archive", `a:i:${idea.id}:archive`);
    keyboard.text("Note", `a:i:${idea.id}:note`);
  } else if (idea.status === "planning") {
    keyboard.text("Archive", `a:i:${idea.id}:archive`);
    keyboard.text("Note", `a:i:${idea.id}:note`);
  }

  try {
    await ctx.reply(response, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch {
    await ctx.reply(response.replace(/[*_`]/g, ""), { reply_markup: keyboard });
  }
}

async function handleUpdate(ctx: any, idInput?: string, field?: string, value?: string): Promise<void> {
  if (!idInput || !field || !value) {
    await ctx.reply(
      "*Usage:* `/idea update <id> <field> <value>`\n\n" +
      "Fields: `status`, `title`, `note`\n\n" +
      "Examples:\n" +
      "- `/idea update 20260207 status planning`\n" +
      "- `/idea update 20260207 title New title here`\n" +
      "- `/idea update 20260207 note This needs more research`",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const idea = findIdeaById(idInput);
  if (!idea) {
    await ctx.reply(`Idea not found: \`${idInput}\``, { parse_mode: "Markdown" });
    return;
  }

  const validFields = ["status", "title", "note"];
  if (!validFields.includes(field.toLowerCase())) {
    await ctx.reply(`Invalid field. Use: ${validFields.join(", ")}`);
    return;
  }

  const db = getDb();

  switch (field.toLowerCase()) {
    case "status": {
      const validStatuses = ["draft", "review", "planning", "execution", "archived"];
      if (!validStatuses.includes(value)) {
        await ctx.reply(`Invalid status. Use: ${validStatuses.join(", ")}`);
        return;
      }
      if (db) {
        dao.updateIdea(db, idea.id, { status: value });
      } else {
        idea.status = value;
        saveIdeaFile(idea);
      }
      break;
    }
    case "title":
      if (db) {
        dao.updateIdea(db, idea.id, { title: value });
      } else {
        idea.title = value;
        saveIdeaFile(idea);
      }
      break;
    case "note": {
      if (db) {
        dao.appendNote(db, idea.id, value);
      } else {
        const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        const note = `[${timestamp}] ${value}`;
        idea.notes = idea.notes ? `${idea.notes}\n${note}` : note;
        saveIdeaFile(idea);
      }
      break;
    }
  }

  await ctx.reply(
    `Updated *${idea.title}*\n` +
    `Field: ${field} → ${field === "note" ? "appended" : value}`,
    { parse_mode: "Markdown" }
  );

  logger.info({ id: idea.id, field, value: truncate(value, 50) }, "Idea updated via /idea command");
}

async function handleArchive(ctx: any, idInput?: string): Promise<void> {
  if (!idInput) {
    await ctx.reply("Usage: `/idea archive <id>`", { parse_mode: "Markdown" });
    return;
  }

  const idea = findIdeaById(idInput);
  if (!idea) {
    await ctx.reply(`Idea not found: \`${idInput}\``, { parse_mode: "Markdown" });
    return;
  }

  if (idea.status === "archived") {
    await ctx.reply(`Already archived: *${idea.title}*`, { parse_mode: "Markdown" });
    return;
  }

  const db = getDb();
  if (db) {
    dao.updateIdea(db, idea.id, { status: "archived" });
  } else {
    idea.status = "archived";
    saveIdeaFile(idea);
  }

  await ctx.reply(
    `Archived: *${idea.title}*\n` +
    `ID: \`${idea.id}\``,
    { parse_mode: "Markdown" }
  );

  logger.info({ id: idea.id, title: idea.title }, "Idea archived via /idea command");
}

async function handleDelete(ctx: any, idInput?: string): Promise<void> {
  if (!idInput) {
    await ctx.reply("Usage: `/idea delete <id>`", { parse_mode: "Markdown" });
    return;
  }

  const idea = findIdeaById(idInput);
  if (!idea || !idea.filePath) {
    await ctx.reply(`Idea not found: \`${idInput}\``, { parse_mode: "Markdown" });
    return;
  }

  // Confirm before deleting
  const keyboard = new InlineKeyboard()
    .text("Yes, delete", `idea:delete:${idea.id}`)
    .text("Cancel", `idea:cancel`);

  await ctx.reply(
    `Delete *${idea.title}*?\n\nThis is permanent.`,
    { parse_mode: "Markdown", reply_markup: keyboard }
  );
}

async function handleSearch(ctx: any, query: string): Promise<void> {
  if (!query.trim()) {
    await ctx.reply("Usage: `/idea search <query>`", { parse_mode: "Markdown" });
    return;
  }

  const db = getDb();

  // Try FTS first, fallback to string match
  let matches: ParsedIdea[];
  if (db) {
    const ftsResults = dao.searchIdeas(db, query, 10);
    if (ftsResults.length > 0) {
      matches = ftsResults.map(r => ({
        id: r.id,
        title: r.title,
        status: r.status,
        source: r.source ?? "",
        content: r.content,
        tags: [],
        timestamp: r.created_at ?? "",
      }));
    } else {
      // FTS found nothing, try substring match in DB
      const all = dao.getAllIdeas(db);
      const lower = query.toLowerCase();
      matches = all.filter((i) =>
        i.title.toLowerCase().includes(lower) ||
        i.content?.toLowerCase().includes(lower) ||
        i.tags?.some((t) => t.toLowerCase().includes(lower))
      );
    }
  } else {
    const ideas = loadIdeasFromDir();
    const lower = query.toLowerCase();
    matches = ideas.filter((i) =>
      i.title.toLowerCase().includes(lower) ||
      i.content?.toLowerCase().includes(lower) ||
      i.tags?.some((t) => t.toLowerCase().includes(lower))
    );
  }

  if (matches.length === 0) {
    await ctx.reply(`No ideas matching: *${query}*`, { parse_mode: "Markdown" });
    return;
  }

  const shown = matches.slice(0, 10);
  let response = `*Search: ${query}* (${matches.length} results)\n\n`;

  for (const idea of shown) {
    const shortId = idea.id.replace("idea_", "");
    response += `\`${shortId}\` [${idea.status}] ${idea.title}\n`;
  }

  response += "\n_Use_ `/idea get <id>` _for details_";

  try {
    await ctx.reply(response, { parse_mode: "Markdown" });
  } catch {
    await ctx.reply(response.replace(/[*_`]/g, ""));
  }
}

// --- Callback query handlers ---

export function registerIdeaCallbacks(bot: Bot): void {
  // Handle "Review Now" button from /idea add
  bot.callbackQuery(/^idea:review:(.+)$/, async (ctx) => {
    const ideaId = ctx.match![1]!;
    const idea = findIdeaById(ideaId);
    if (!idea) {
      await ctx.answerCallbackQuery({ text: "Idea not found" });
      return;
    }

    const db = getDb();
    if (db) {
      dao.updateIdea(db, idea.id, { status: "review" });
    } else {
      idea.status = "review";
      saveIdeaFile(idea);
    }

    await ctx.answerCallbackQuery({ text: "Moved to review" });
    await ctx.editMessageText(
      `*${idea.title}*\nID: \`${idea.id}\`\nStatus: *review*`,
      { parse_mode: "Markdown" }
    );

    logger.info({ id: ideaId }, "Idea moved to review via button");
  });

  // Handle confirm delete
  bot.callbackQuery(/^idea:delete:(.+)$/, async (ctx) => {
    const ideaId = ctx.match![1]!;
    const idea = findIdeaById(ideaId);
    if (!idea) {
      await ctx.answerCallbackQuery({ text: "Idea not found" });
      return;
    }

    try {
      const db = getDb();
      if (db) {
        dao.deleteIdea(db, idea.id);
      } else if (idea.filePath) {
        unlinkSync(idea.filePath);
      }
      await ctx.answerCallbackQuery({ text: "Deleted" });
      await ctx.editMessageText(`Deleted: ${idea.title}`);
      logger.info({ id: ideaId, title: idea.title }, "Idea deleted via /idea command");
    } catch (error) {
      await ctx.answerCallbackQuery({ text: "Delete failed" });
      logger.error({ id: ideaId, error }, "Failed to delete idea");
    }
  });

  // Handle cancel delete
  bot.callbackQuery("idea:cancel", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    await ctx.editMessageText("Delete cancelled.");
  });
}

// --- Helpers ---

function getDb() {
  return stateManagerRef ? (stateManagerRef as any).getDb() : null;
}

function findIdeaById(idInput: string): ParsedIdea | null {
  const db = getDb();

  // DB is source of truth — if available, only use DB lookup
  if (db) {
    const normalized = idInput.startsWith("idea_") ? idInput : `idea_${idInput}`;
    return dao.getIdea(db, normalized) ?? dao.getIdea(db, idInput);
  }

  // File scan ONLY when DB is unavailable (offline mode)
  logger.warn("findIdeaById: DB unavailable, falling back to file scan");
  const { directory } = getIdeasPaths();
  const normalized = idInput.startsWith("idea_") ? idInput : `idea_${idInput}`;

  const files = readdirSync(directory).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    const filePath = join(directory, file);
    const idea = parseIdeaFile(filePath);
    if (!idea) continue;

    if (
      idea.id === normalized ||
      idea.id === idInput ||
      idea.id.includes(idInput) ||
      file.includes(idInput)
    ) {
      return idea;
    }
  }
  return null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "..." : text;
}
