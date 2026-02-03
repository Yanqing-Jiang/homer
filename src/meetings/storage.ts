/**
 * Meeting storage - handles markdown files with YAML frontmatter
 */

import { readFile, writeFile, mkdir, unlink, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join, extname } from "path";
import YAML from "yaml";
import type {
  Meeting,
  MeetingFileContent,
  ActionItem,
  KeyTopic,
  TranscriptSegment,
  SpeakerMapping,
} from "./types.js";
import { logger } from "../utils/logger.js";

const MEETINGS_BASE = "/Users/yj/memory/meetings";
const AUDIO_DIR = join(MEETINGS_BASE, "audio");

/**
 * Ensure meetings directories exist
 */
export async function ensureMeetingsDirs(): Promise<void> {
  if (!existsSync(MEETINGS_BASE)) {
    await mkdir(MEETINGS_BASE, { recursive: true });
  }
  if (!existsSync(AUDIO_DIR)) {
    await mkdir(AUDIO_DIR, { recursive: true });
  }
}

/**
 * Generate meeting ID from date and title
 */
export function generateMeetingId(date: Date, title: string): string {
  const dateStr = date.toISOString().slice(0, 10);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  return `${dateStr}-${slug}`;
}

/**
 * Get path to audio file
 */
export function getAudioPath(meetingId: string, extension: string): string {
  return join(AUDIO_DIR, `${meetingId}${extension}`);
}

/**
 * Get path to transcript file
 */
export function getTranscriptPath(meetingId: string): string {
  return join(MEETINGS_BASE, `${meetingId}.md`);
}

/**
 * Save audio file
 */
export async function saveAudioFile(
  meetingId: string,
  audioBuffer: Buffer,
  fileName: string
): Promise<string> {
  await ensureMeetingsDirs();

  const ext = extname(fileName) || ".m4a";
  const audioPath = getAudioPath(meetingId, ext);

  await writeFile(audioPath, audioBuffer);
  logger.info({ meetingId, audioPath, size: audioBuffer.length }, "Saved audio file");

  // Return relative path for storage
  return `audio/${meetingId}${ext}`;
}

/**
 * Delete audio file
 */
export async function deleteAudioFile(relativePath: string): Promise<void> {
  const fullPath = join(MEETINGS_BASE, relativePath);
  if (existsSync(fullPath)) {
    await unlink(fullPath);
    logger.info({ path: fullPath }, "Deleted audio file");
  }
}

/**
 * Format meeting as markdown with YAML frontmatter
 */
export function formatMeetingMarkdown(meeting: Meeting): string {
  const speakerMappingsObj: Record<string, string> = {};
  for (const m of meeting.speakerMappings) {
    if (m.mappedName) {
      speakerMappingsObj[m.speakerId] = m.mappedName;
    }
  }

  const frontmatter = {
    id: meeting.id,
    title: meeting.title,
    date: meeting.date,
    duration: meeting.durationSeconds,
    attendees: meeting.attendees,
    audio: meeting.audioPath,
    speaker_mappings: speakerMappingsObj,
    confidence: meeting.confidence ?? 0,
    language: meeting.language,
  };

  let content = "---\n";
  content += YAML.stringify(frontmatter);
  content += "---\n\n";

  // Summary
  if (meeting.summary) {
    content += "## Summary\n\n";
    content += meeting.summary + "\n\n";
  }

  // Action Items
  if (meeting.actionItems.length > 0) {
    content += "## Action Items\n\n";
    for (const item of meeting.actionItems) {
      const checkbox = item.completed ? "[x]" : "[ ]";
      const due = item.dueDate ? ` (due: ${item.dueDate})` : "";
      content += `- ${checkbox} **${item.assignee}**: ${item.task}${due}\n`;
    }
    content += "\n";
  }

  // Key Topics
  if (meeting.keyTopics.length > 0) {
    content += "## Key Topics\n\n";
    for (const topic of meeting.keyTopics) {
      const ts = topic.timestamp ? ` [${topic.timestamp}]` : "";
      content += `- **${topic.title}**${ts}: ${topic.description}\n`;
    }
    content += "\n";
  }

  // Transcript
  content += "## Transcript\n\n";
  for (const segment of meeting.transcript) {
    content += `### [${segment.timestamp}] ${segment.speaker}\n`;
    content += segment.text + "\n\n";
  }

  // Footer
  content += "---\n";
  content += "*Transcribed by HOMER using ElevenLabs Scribe v2*\n";
  if (meeting.confidence) {
    content += `*Speaker identification confidence: ${Math.round(meeting.confidence * 100)}%*\n`;
  }

  return content;
}

/**
 * Parse meeting markdown file
 */
export function parseMeetingMarkdown(content: string): MeetingFileContent | null {
  try {
    // Extract YAML frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (!frontmatterMatch) {
      return null;
    }

    const frontmatter = YAML.parse(frontmatterMatch[1] || "") as Record<string, unknown>;
    const body = content.slice(frontmatterMatch[0].length);

    // Parse sections
    const summary = extractSection(body, "## Summary");
    const actionItemsText = extractSection(body, "## Action Items");
    const keyTopicsText = extractSection(body, "## Key Topics");
    const transcriptText = extractSection(body, "## Transcript");

    // Parse action items
    const actionItems: ActionItem[] = [];
    const actionItemPattern = /- \[([ x])\] \*\*([^*]+)\*\*: ([^\n]+)/g;
    let match;
    while ((match = actionItemPattern.exec(actionItemsText)) !== null) {
      const taskText = match[3] || "";
      const dueDateMatch = taskText.match(/\(due: ([^)]+)\)/);
      actionItems.push({
        completed: match[1] === "x",
        assignee: match[2] || "",
        task: taskText.replace(/\s*\(due: [^)]+\)/, "").trim(),
        dueDate: dueDateMatch?.[1],
      });
    }

    // Parse key topics
    const keyTopics: KeyTopic[] = [];
    const keyTopicPattern = /- \*\*([^*]+)\*\*(?:\s*\[([^\]]+)\])?: ([^\n]+)/g;
    while ((match = keyTopicPattern.exec(keyTopicsText)) !== null) {
      keyTopics.push({
        title: match[1] || "",
        timestamp: match[2],
        description: match[3] || "",
      });
    }

    // Parse transcript
    const transcript: TranscriptSegment[] = [];
    const segmentPattern = /### \[([^\]]+)\] ([^\n]+)\n([\s\S]*?)(?=### \[|---\n|\n## |$)/g;
    while ((match = segmentPattern.exec(transcriptText)) !== null) {
      const timeStr = match[1] || "00:00";
      const parts = timeStr.split(":").map(Number);
      let startSeconds = 0;
      if (parts.length === 3) {
        startSeconds = (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
      } else if (parts.length === 2) {
        startSeconds = (parts[0] || 0) * 60 + (parts[1] || 0);
      }

      transcript.push({
        timestamp: match[1] || "00:00",
        speaker: match[2] || "Unknown",
        text: (match[3] || "").trim(),
        startSeconds,
        endSeconds: startSeconds, // Will be updated on next segment
      });
    }

    // Set end times based on next segment
    for (let i = 0; i < transcript.length - 1; i++) {
      const current = transcript[i];
      const next = transcript[i + 1];
      if (current && next) {
        current.endSeconds = next.startSeconds;
      }
    }

    return {
      frontmatter: {
        id: (frontmatter.id as string) || "",
        title: (frontmatter.title as string) || "",
        date: (frontmatter.date as string) || "",
        duration: (frontmatter.duration as number) || 0,
        attendees: (frontmatter.attendees as string[]) || [],
        audio: (frontmatter.audio as string) || "",
        speaker_mappings: (frontmatter.speaker_mappings as Record<string, string>) || {},
        confidence: (frontmatter.confidence as number) || 0,
        language: frontmatter.language as string | undefined,
      },
      summary,
      actionItems,
      keyTopics,
      transcript,
    };
  } catch (error) {
    logger.error({ error }, "Failed to parse meeting markdown");
    return null;
  }
}

/**
 * Extract content from a markdown section
 */
function extractSection(content: string, header: string): string {
  const startIdx = content.indexOf(header);
  if (startIdx === -1) return "";

  const contentStart = content.indexOf("\n", startIdx) + 1;

  // Find next section
  const nextSectionMatch = content.slice(contentStart).match(/\n## /);
  const endIdx = nextSectionMatch
    ? contentStart + nextSectionMatch.index!
    : content.length;

  return content.slice(contentStart, endIdx).trim();
}

/**
 * Save meeting to file
 */
export async function saveMeetingFile(meeting: Meeting): Promise<string> {
  await ensureMeetingsDirs();

  const transcriptPath = getTranscriptPath(meeting.id);
  const content = formatMeetingMarkdown(meeting);

  await writeFile(transcriptPath, content, "utf-8");
  logger.info({ meetingId: meeting.id, path: transcriptPath }, "Saved meeting file");

  return `${meeting.id}.md`;
}

/**
 * Read meeting from file
 */
export async function readMeetingFile(meetingId: string): Promise<MeetingFileContent | null> {
  const transcriptPath = getTranscriptPath(meetingId);

  if (!existsSync(transcriptPath)) {
    return null;
  }

  const content = await readFile(transcriptPath, "utf-8");
  return parseMeetingMarkdown(content);
}

/**
 * Delete meeting file
 */
export async function deleteMeetingFile(meetingId: string): Promise<void> {
  const transcriptPath = getTranscriptPath(meetingId);

  if (existsSync(transcriptPath)) {
    await unlink(transcriptPath);
    logger.info({ meetingId, path: transcriptPath }, "Deleted meeting file");
  }
}

/**
 * List all meeting files
 */
export async function listMeetingFiles(): Promise<string[]> {
  if (!existsSync(MEETINGS_BASE)) {
    return [];
  }

  const files = await readdir(MEETINGS_BASE);
  return files
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(".md", ""))
    .sort()
    .reverse();
}

/**
 * Get audio file info
 */
export async function getAudioInfo(relativePath: string): Promise<{
  exists: boolean;
  size?: number;
  path?: string;
}> {
  const fullPath = join(MEETINGS_BASE, relativePath);

  if (!existsSync(fullPath)) {
    return { exists: false };
  }

  const stats = await stat(fullPath);
  return {
    exists: true,
    size: stats.size,
    path: fullPath,
  };
}

/**
 * Read audio file as buffer
 */
export async function readAudioFile(relativePath: string): Promise<Buffer | null> {
  const fullPath = join(MEETINGS_BASE, relativePath);

  if (!existsSync(fullPath)) {
    return null;
  }

  return readFile(fullPath);
}

/**
 * Convert speaker mappings to lookup object
 */
export function speakerMappingsToLookup(
  mappings: SpeakerMapping[]
): Record<string, string> {
  const lookup: Record<string, string> = {};
  for (const m of mappings) {
    if (m.mappedName) {
      lookup[m.speakerId] = m.mappedName;
    }
  }
  return lookup;
}

/**
 * Convert lookup object to speaker mappings array
 */
export function lookupToSpeakerMappings(
  lookup: Record<string, string>
): SpeakerMapping[] {
  return Object.entries(lookup).map(([speakerId, mappedName]) => ({
    speakerId,
    mappedName,
    confidence: 1.0, // Manual mapping = full confidence
    reasoning: "Manual override",
    needsReview: false,
  }));
}
