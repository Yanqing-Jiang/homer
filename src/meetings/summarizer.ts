/**
 * Meeting summarizer using Claude CLI
 *
 * Generates summary, action items, and key topics from transcript
 */

import type {
  ActionItem,
  KeyTopic,
  TranscriptSegment,
  SpeakerMapping,
} from "./types.js";
import type { TranscriptionResult } from "../voice/types.js";
import { groupWordsIntoSegments } from "./types.js";
import { logger } from "../utils/logger.js";
import { executeClaudeCommand } from "../executors/claude.js";

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
 * Extract JSON from Claude CLI output (handles markdown fences)
 */
function extractJSON(text: string): string {
  // Try to find JSON in code fences first
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) return fenceMatch[1]!.trim();

  // Try to find raw JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];

  return text.trim();
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
 * Generate meeting summary using Claude CLI
 */
export async function summarizeMeeting(
  transcription: TranscriptionResult,
  speakerMappings: SpeakerMapping[],
  title: string,
  attendees: string[]
): Promise<SummarizeResult> {
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

  const prompt = `You are summarizing a meeting transcript. Respond with ONLY a JSON object, no other text.

## Meeting Information
- Title: ${title}
- Attendees: ${attendees.join(", ")}
- Duration: ${segments.length > 0 ? segments[segments.length - 1]?.timestamp ?? "unknown" : "unknown"}

## Transcript
${transcriptText}

## Task
Analyze this meeting and respond with ONLY this JSON structure:

{
  "summary": "2-4 paragraph summary focusing on decisions and key discussion points",
  "action_items": [{"assignee": "name", "task": "description", "due_date": "if mentioned"}],
  "key_topics": [{"title": "2-5 words", "description": "1-2 sentences", "timestamp": "MM:SS"}],
  "meeting_type": "standup|planning|1:1|brainstorm|review|etc"
}

Be specific about who said what. Focus on outcomes over process. Only include explicit commitments as action items.`;

  try {
    const result = await executeClaudeCommand(prompt, {
      cwd: "/tmp",
      model: "opus",
      timeout: 120_000,
    });

    if (result.exitCode !== 0 || !result.output || result.output.length < 20) {
      throw new Error(`Claude CLI failed: exit=${result.exitCode}, output=${result.output?.slice(0, 200)}`);
    }

    const parsed = JSON.parse(extractJSON(result.output)) as SummaryToolResult;

    logger.info(
      {
        title,
        summaryLength: parsed.summary.length,
        actionItems: parsed.action_items.length,
        keyTopics: parsed.key_topics.length,
        meetingType: parsed.meeting_type,
      },
      "Meeting summary generated"
    );

    return {
      summary: parsed.summary,
      actionItems: (parsed.action_items || []).map((item) => ({
        assignee: item.assignee,
        task: item.task,
        dueDate: item.due_date,
        completed: false,
      })),
      keyTopics: (parsed.key_topics || []).map((topic) => ({
        title: topic.title,
        description: topic.description,
        timestamp: topic.timestamp,
      })),
      meetingType: parsed.meeting_type,
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
  const text = transcription.text.slice(0, 2000);

  try {
    const result = await executeClaudeCommand(
      `Generate a short title (3-6 words) for this meeting.

Attendees: ${attendees.join(", ")}

First few minutes of transcript:
${text}

Reply with just the title, nothing else. Examples:
- Weekly Team Standup
- API Design Review
- Q1 Planning Session
- Sarah 1:1 Check-in`,
      {
        cwd: "/tmp",
        model: "opus",
        timeout: 30_000,
      }
    );

    if (result.exitCode === 0 && result.output) {
      return result.output.trim().replace(/^["']|["']$/g, "");
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
  const segments = groupWordsIntoSegments(
    transcription.words || [],
    speakerMappings
  );

  const transcriptText = formatTranscriptForSummary(segments, 10000);

  try {
    const result = await executeClaudeCommand(
      `Extract action items from this meeting transcript. Only include explicit commitments.

${transcriptText}

Respond with ONLY a JSON object:
{"items": [{"assignee": "name", "task": "description", "due_date": "if mentioned"}]}`,
      {
        cwd: "/tmp",
        model: "opus",
        timeout: 900_000,
      }
    );

    if (result.exitCode !== 0 || !result.output) {
      return [];
    }

    const parsed = JSON.parse(extractJSON(result.output)) as { items: Array<{ assignee: string; task: string; due_date?: string }> };

    return (parsed.items || []).map((item) => ({
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
