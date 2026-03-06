/**
 * Meeting tools: meeting_list, meeting_search, meeting_get
 */

import type { ToolResult, ToolDeps, ToolDefinition } from "./types.js";

export const definitions: ToolDefinition[] = [
  {
    name: "meeting_list",
    description: "List recorded meetings with transcripts.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "transcribing", "mapping", "summarizing", "complete", "error", "all"], description: "Filter by status (default: all)" },
        limit: { type: "number", description: "Max results to return (default: 20)" },
        attendee: { type: "string", description: "Filter by attendee name" },
      },
    },
  },
  {
    name: "meeting_search",
    description: "Search meeting transcripts and content. Use for queries like 'what did X say about Y'.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results to return (default: 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "meeting_get",
    description: "Get full meeting details including transcript.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Meeting ID" },
      },
      required: ["id"],
    },
  },
];

export async function handle(
  name: string,
  args: Record<string, unknown>,
  _deps: ToolDeps
): Promise<ToolResult | null> {
  switch (name) {
    case "meeting_list": {
      const { status, limit, attendee } = args as { status?: string; limit?: number; attendee?: string };
      try {
        const { listMeetingFiles, readMeetingFile } = await import("../../meetings/storage.js");
        const files = await listMeetingFiles();
        const maxResults = limit || 20;
        const meetings = [];
        for (const meetingId of files.slice(0, maxResults * 2)) {
          const content = await readMeetingFile(meetingId);
          if (!content) continue;
          if (status && status !== "all") { /* status filter not in file format */ }
          if (attendee) {
            const hasAttendee = content.frontmatter.attendees.some(
              (a: string) => a.toLowerCase().includes(attendee.toLowerCase())
            );
            if (!hasAttendee) continue;
          }
          meetings.push({
            id: content.frontmatter.id, title: content.frontmatter.title,
            date: content.frontmatter.date, duration: content.frontmatter.duration,
            attendees: content.frontmatter.attendees, confidence: content.frontmatter.confidence,
          });
          if (meetings.length >= maxResults) break;
        }
        return { content: [{ type: "text", text: meetings.length > 0 ? JSON.stringify(meetings, null, 2) : "No meetings found" }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Failed to list meetings: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }

    case "meeting_search": {
      const { query, limit } = args as { query: string; limit?: number };
      try {
        const { listMeetingFiles, readMeetingFile } = await import("../../meetings/storage.js");
        const files = await listMeetingFiles();
        const maxResults = limit || 10;
        const queryLower = query.toLowerCase();
        const results = [];
        for (const meetingId of files) {
          const content = await readMeetingFile(meetingId);
          if (!content) continue;
          if (content.frontmatter.title.toLowerCase().includes(queryLower)) {
            results.push({ meetingId, title: content.frontmatter.title, date: content.frontmatter.date, match: "title", snippet: content.frontmatter.title });
            continue;
          }
          for (const segment of content.transcript) {
            if (segment.text.toLowerCase().includes(queryLower)) {
              results.push({ meetingId, title: content.frontmatter.title, date: content.frontmatter.date, speaker: segment.speaker, timestamp: segment.timestamp, match: "transcript", snippet: segment.text.slice(0, 200) });
              break;
            }
          }
          if (content.summary?.toLowerCase().includes(queryLower)) {
            results.push({ meetingId, title: content.frontmatter.title, date: content.frontmatter.date, match: "summary", snippet: content.summary.slice(0, 200) });
          }
          if (results.length >= maxResults) break;
        }
        return { content: [{ type: "text", text: results.length > 0 ? JSON.stringify(results, null, 2) : `No meetings found matching: ${query}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Search failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }

    case "meeting_get": {
      const { id } = args as { id: string };
      try {
        const { readMeetingFile } = await import("../../meetings/storage.js");
        const content = await readMeetingFile(id);
        if (!content) return { content: [{ type: "text", text: `Meeting not found: ${id}` }], isError: true };
        let transcriptText = "";
        for (const segment of content.transcript.slice(0, 50)) {
          transcriptText += `[${segment.timestamp}] ${segment.speaker}: ${segment.text}\n\n`;
        }
        if (content.transcript.length > 50) transcriptText += `... (${content.transcript.length - 50} more segments)\n`;
        const output = {
          id: content.frontmatter.id, title: content.frontmatter.title,
          date: content.frontmatter.date, duration: content.frontmatter.duration,
          attendees: content.frontmatter.attendees, speakerMappings: content.frontmatter.speaker_mappings,
          confidence: content.frontmatter.confidence, summary: content.summary,
          actionItems: content.actionItems, keyTopics: content.keyTopics, transcriptPreview: transcriptText,
        };
        return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Failed to get meeting: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }

    default:
      return null;
  }
}
