/**
 * Meeting summarizer using Claude Sonnet
 *
 * Generates summary, action items, and key topics from transcript
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  ActionItem,
  KeyTopic,
  TranscriptSegment,
  SpeakerMapping,
} from "./types.js";
import type { TranscriptionResult } from "../voice/types.js";
import { groupWordsIntoSegments } from "./types.js";
import { logger } from "../utils/logger.js";

const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";

// Tool schema for structured summary output
const MEETING_SUMMARY_TOOL = {
  name: "meeting_summary",
  description: "Record the meeting summary and extracted items",
  input_schema: {
    type: "object" as const,
    properties: {
      summary: {
        type: "string" as const,
        description: "2-4 paragraph summary of the meeting's key discussions and outcomes",
      },
      action_items: {
        type: "array" as const,
        description: "Action items assigned during the meeting",
        items: {
          type: "object" as const,
          properties: {
            assignee: {
              type: "string" as const,
              description: "Person responsible for the action",
            },
            task: {
              type: "string" as const,
              description: "Description of what needs to be done",
            },
            due_date: {
              type: "string" as const,
              description: "Due date if mentioned (ISO format or relative like 'next week')",
            },
          },
          required: ["assignee", "task"],
        },
      },
      key_topics: {
        type: "array" as const,
        description: "Main topics discussed in the meeting",
        items: {
          type: "object" as const,
          properties: {
            title: {
              type: "string" as const,
              description: "Topic title (2-5 words)",
            },
            description: {
              type: "string" as const,
              description: "Brief description of discussion (1-2 sentences)",
            },
            timestamp: {
              type: "string" as const,
              description: "Approximate timestamp when discussed (MM:SS format)",
            },
          },
          required: ["title", "description"],
        },
      },
      meeting_type: {
        type: "string" as const,
        description: "Type of meeting (standup, planning, 1:1, brainstorm, review, etc.)",
      },
    },
    required: ["summary", "action_items", "key_topics"],
  },
};

interface SummaryToolResult {
  summary: string;
  action_items: Array<{
    assignee: string;
    task: string;
    due_date?: string;
  }>;
  key_topics: Array<{
    title: string;
    description: string;
    timestamp?: string;
  }>;
  meeting_type?: string;
}

export interface SummarizeResult {
  summary: string;
  actionItems: ActionItem[];
  keyTopics: KeyTopic[];
  meetingType?: string;
}

/**
 * Format transcript for the summarizer prompt
 */
function formatTranscriptForSummary(
  segments: TranscriptSegment[],
  maxLength: number = 15000
): string {
  let result = "";

  for (const segment of segments) {
    const line = `[${segment.timestamp}] ${segment.speaker}: ${segment.text}\n\n`;
    if (result.length + line.length > maxLength) {
      result += `\n... (transcript truncated, ${segments.length - segments.indexOf(segment)} more segments)`;
      break;
    }
    result += line;
  }

  return result;
}

/**
 * Generate meeting summary using Claude
 */
export async function summarizeMeeting(
  transcription: TranscriptionResult,
  speakerMappings: SpeakerMapping[],
  title: string,
  attendees: string[]
): Promise<SummarizeResult> {
  const client = new Anthropic();

  // Group words into segments with speaker names
  const segments = groupWordsIntoSegments(
    transcription.words || [],
    speakerMappings
  );

  if (segments.length === 0) {
    return {
      summary: "No transcript content to summarize.",
      actionItems: [],
      keyTopics: [],
    };
  }

  const transcriptText = formatTranscriptForSummary(segments);

  const prompt = `You are summarizing a meeting transcript.

## Meeting Information
- Title: ${title}
- Attendees: ${attendees.join(", ")}
- Duration: ${segments.length > 0 ? segments[segments.length - 1]?.timestamp ?? "unknown" : "unknown"}

## Transcript
${transcriptText}

## Task
Analyze this meeting and extract:
1. A concise summary (2-4 paragraphs) focusing on decisions made and key discussion points
2. Action items with assignees (only explicit commitments, not general discussion)
3. Key topics discussed

Be specific about who said what when relevant. Focus on outcomes over process.

Use the meeting_summary tool to record your analysis.`;

  try {
    const response = await client.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      tools: [MEETING_SUMMARY_TOOL],
      tool_choice: { type: "tool", name: "meeting_summary" },
      messages: [{ role: "user", content: prompt }],
    });

    // Extract tool use result
    const toolUse = response.content.find((c) => c.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("No tool use in response");
    }

    const result = toolUse.input as SummaryToolResult;

    logger.info(
      {
        title,
        summaryLength: result.summary.length,
        actionItems: result.action_items.length,
        keyTopics: result.key_topics.length,
        meetingType: result.meeting_type,
      },
      "Meeting summary generated"
    );

    return {
      summary: result.summary,
      actionItems: result.action_items.map((item) => ({
        assignee: item.assignee,
        task: item.task,
        dueDate: item.due_date,
        completed: false,
      })),
      keyTopics: result.key_topics.map((topic) => ({
        title: topic.title,
        description: topic.description,
        timestamp: topic.timestamp,
      })),
      meetingType: result.meeting_type,
    };
  } catch (error) {
    logger.error({ error, title }, "Meeting summarization failed");

    // Return empty summary on error
    return {
      summary: "Summary generation failed. Please review the transcript directly.",
      actionItems: [],
      keyTopics: [],
    };
  }
}

/**
 * Generate a quick title from transcript if not provided
 */
export async function generateMeetingTitle(
  transcription: TranscriptionResult,
  attendees: string[]
): Promise<string> {
  const client = new Anthropic();

  const text = transcription.text.slice(0, 2000);

  try {
    const response = await client.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 100,
      messages: [{
        role: "user",
        content: `Generate a short title (3-6 words) for this meeting.

Attendees: ${attendees.join(", ")}

First few minutes of transcript:
${text}

Reply with just the title, nothing else. Examples:
- Weekly Team Standup
- API Design Review
- Q1 Planning Session
- Sarah 1:1 Check-in`,
      }],
    });

    const content = response.content[0];
    if (content && content.type === "text") {
      return content.text.trim().replace(/^["']|["']$/g, "");
    }
  } catch (error) {
    logger.warn({ error }, "Title generation failed");
  }

  // Fallback
  const date = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  return `Meeting ${date}`;
}

/**
 * Extract just action items from a transcript (lighter operation)
 */
export async function extractActionItems(
  transcription: TranscriptionResult,
  speakerMappings: SpeakerMapping[]
): Promise<ActionItem[]> {
  const client = new Anthropic();

  const segments = groupWordsIntoSegments(
    transcription.words || [],
    speakerMappings
  );

  const transcriptText = formatTranscriptForSummary(segments, 10000);

  const ACTION_ITEMS_TOOL = {
    name: "action_items",
    description: "Extract action items from the meeting",
    input_schema: {
      type: "object" as const,
      properties: {
        items: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              assignee: { type: "string" as const },
              task: { type: "string" as const },
              due_date: { type: "string" as const },
            },
            required: ["assignee", "task"],
          },
        },
      },
      required: ["items"],
    },
  };

  try {
    const response = await client.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      tools: [ACTION_ITEMS_TOOL],
      tool_choice: { type: "tool", name: "action_items" },
      messages: [{
        role: "user",
        content: `Extract action items from this meeting transcript. Only include explicit commitments.

${transcriptText}`,
      }],
    });

    const toolUse = response.content.find((c) => c.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      return [];
    }

    const result = toolUse.input as { items: Array<{ assignee: string; task: string; due_date?: string }> };

    return result.items.map((item) => ({
      assignee: item.assignee,
      task: item.task,
      dueDate: item.due_date,
      completed: false,
    }));
  } catch (error) {
    logger.warn({ error }, "Action item extraction failed");
    return [];
  }
}
