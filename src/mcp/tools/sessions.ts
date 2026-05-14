/**
 * Session & thread tools: session_archive, thread_load, outcome_check, preference_query
 */

import type { ToolResult, ToolDeps, ToolDefinition } from "./types.js";

export const definitions: ToolDefinition[] = [
  {
    name: "session_archive",
    description: "Archive or unarchive session_summaries rows. Archived sessions are excluded from search by default and from nightly-memory processing.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["archive", "unarchive"], description: "Action to perform" },
        ids: { type: "array", items: { type: "string" }, description: "Session IDs to archive/unarchive" },
        reason: { type: "string", description: "Reason for archiving (optional)" },
        date: { type: "string", description: "Filter by date (YYYY-MM-DD)" },
        agent: { type: "string", description: "Filter by agent type (optional, combines with date filter)" },
        dry_run: { type: "boolean", description: "Preview matches without mutating (default: false)" },
      },
      required: ["action"],
    },
  },
  {
    name: "thread_load",
    description: "Load a Homer web UI thread's conversation as formatted markdown.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "The thread ID to load" },
        limit: { type: "number", description: "Max messages to include (default: 100)" },
      },
      required: ["thread_id"],
    },
  },
  {
    name: "outcome_check",
    description: "Manually trigger an outcome check for a specific item.",
    inputSchema: {
      type: "object",
      properties: {
        source_type: { type: "string", enum: ["idea", "plan", "application", "promotion", "improvement"], description: "Type of item to check" },
        source_id: { type: "string", description: "ID of the item" },
        source_title: { type: "string", description: "Title/description of the item" },
        check_days: { type: "number", description: "Days from now to schedule the check (default: 14)" },
      },
      required: ["source_type", "source_id", "source_title"],
    },
  },
  {
    name: "preference_query",
    description: "Query the preference model for learned user preferences. Returns top preferences with scores and evidence counts.",
    inputSchema: {
      type: "object",
      properties: {
        dimension: { type: "string", description: "Optional prefix filter (e.g., 'topic:', 'source:', 'project:')" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
  },
];

export async function handle(
  name: string,
  args: Record<string, unknown>,
  deps: ToolDeps
): Promise<ToolResult | null> {
  switch (name) {
    case "outcome_check": {
      const { source_type, source_id, source_title, check_days } = args as {
        source_type: string; source_id: string; source_title: string; check_days?: number;
      };
      const daysOut = check_days || 14;
      const id = `oc_${Date.now()}`;
      const sm = deps.getSharedStateManager();
      sm.getDb().prepare(`
        INSERT INTO outcome_checks (id, source_type, source_id, source_title, check_at)
        VALUES (?, ?, ?, ?, datetime('now', ?))
      `).run(id, source_type, source_id, source_title, `+${daysOut} days`);
      return { content: [{ type: "text", text: `Created outcome check: ${source_title} (${source_type}), due in ${daysOut} days (ID: ${id})` }] };
    }

    case "preference_query": {
      const { dimension, limit } = args as { dimension?: string; limit?: number };
      const maxResults = limit || 20;
      try {
        const sm = deps.getSharedStateManager();
        let rows: Array<{ dimension: string; score: number; evidence_count: number; last_updated: string }>;
        if (dimension) {
          rows = sm.getDb().prepare(`
            SELECT dimension, score, evidence_count, last_updated
            FROM preference_model WHERE dimension LIKE ?
            ORDER BY score DESC LIMIT ?
          `).all(`${dimension}%`, maxResults) as typeof rows;
        } else {
          rows = sm.getDb().prepare(`
            SELECT dimension, score, evidence_count, last_updated
            FROM preference_model
            ORDER BY ABS(score - 0.5) DESC LIMIT ?
          `).all(maxResults) as typeof rows;
        }
        if (rows.length === 0) {
          return { content: [{ type: "text", text: "No preferences found." + (dimension ? ` Filter: ${dimension}` : "") }] };
        }
        const lines = rows.map(r => {
          const bar = r.score > 0.6 ? "+" : r.score < 0.4 ? "-" : "~";
          return `${bar} ${r.dimension}: ${r.score.toFixed(2)} (${r.evidence_count} signals, updated ${r.last_updated.slice(0, 10)})`;
        });
        return { content: [{ type: "text", text: `## Preferences${dimension ? ` (${dimension}*)` : ""}\n\n${lines.join("\n")}` }] };
      } catch {
        return { content: [{ type: "text", text: `Preference model not initialized yet. Run migration 030 first.` }] };
      }
    }

    case "thread_load": {
      const { thread_id, limit: rawLimit } = args as { thread_id: string; limit?: number };
      const clampedLimit = Math.min(Math.max(rawLimit || 100, 1), 500);
      const sm = deps.getSharedStateManager();
      const thread = sm.getThread(thread_id);
      if (!thread) return { content: [{ type: "text", text: `Thread not found: ${thread_id}` }], isError: true };
      const allMessages = sm.listThreadMessages(thread_id, { limit: 10000 });
      if (allMessages.length === 0) {
        return { content: [{ type: "text", text: `Thread "${thread.title || thread_id}" has no messages` }], isError: true };
      }
      const messages = allMessages.length > clampedLimit ? allMessages.slice(-clampedLimit) : allMessages;
      const { formatThreadAsMarkdown } = await import("../../cli-sessions/bridge.js");
      let markdown = formatThreadAsMarkdown(thread, messages);
      if (allMessages.length > clampedLimit) {
        markdown = `*Showing ${messages.length} of ${allMessages.length} messages (most recent)*\n\n` + markdown;
      }
      return { content: [{ type: "text", text: markdown }] };
    }

    case "session_archive": {
      const { action, ids, reason, date, agent, dry_run } = args as {
        action: "archive" | "unarchive"; ids?: string[]; reason?: string;
        date?: string; agent?: string; dry_run?: boolean;
      };
      if (!ids?.length && !date) {
        return { content: [{ type: "text", text: "Must provide either 'ids' or 'date' filter" }], isError: true };
      }
      const sm = deps.getSharedStateManager();
      let targetIds: string[] = ids ?? [];
      if (date) {
        let sql = `SELECT id FROM session_summaries WHERE date(COALESCE(started_at, created_at)) = ?`;
        const params: string[] = [date];
        if (agent) { sql += ` AND agent = ?`; params.push(agent); }
        if (action === "archive") { sql += ` AND status = 'active'`; } else { sql += ` AND status = 'archived'`; }
        const rows = sm.getDb().prepare(sql).all(...params) as Array<{ id: string }>;
        targetIds = [...new Set([...targetIds, ...rows.map(r => r.id)])];
      }
      if (targetIds.length === 0) {
        return { content: [{ type: "text", text: `No matching sessions found for ${action}` }] };
      }
      const sampleIds = targetIds.slice(0, 5);
      const sample = sm.getDb().prepare(
        `SELECT id, title, agent, started_at FROM session_summaries WHERE id IN (${sampleIds.map(() => "?").join(",")})`
      ).all(...sampleIds) as Array<{ id: string; title: string; agent: string; started_at: string }>;
      if (dry_run) {
        return { content: [{ type: "text", text: JSON.stringify({ action, matchedCount: targetIds.length, updatedCount: 0, dry_run: true, sample }, null, 2) }] };
      }
      const updatedCount = action === "archive"
        ? sm.archiveSessions(targetIds, reason)
        : sm.unarchiveSessions(targetIds);
      return { content: [{ type: "text", text: JSON.stringify({ action, matchedCount: targetIds.length, updatedCount, sample }, null, 2) }] };
    }

    default:
      return null;
  }
}
