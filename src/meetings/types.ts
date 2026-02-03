/**
 * Meeting recording system types
 */

import type { TranscriptionResult, TranscriptionWord } from "../voice/types.js";

/** Meeting processing status */
export type MeetingStatus =
  | "pending"      // Audio saved, waiting for transcription
  | "transcribing" // ElevenLabs Scribe processing
  | "mapping"      // Speaker identification in progress
  | "summarizing"  // Generating summary and action items
  | "complete"     // Ready for viewing
  | "error";       // Processing failed

/** Speaker mapping from diarization */
export interface SpeakerMapping {
  /** Speaker ID from transcription (e.g., "speaker_0") */
  speakerId: string;
  /** Mapped name (null if couldn't determine) */
  mappedName: string | null;
  /** Confidence score 0-1 */
  confidence: number;
  /** Evidence for the mapping (e.g., "Introduced self as Sarah at 00:15") */
  reasoning: string;
  /** Flag for UI to highlight uncertain mappings */
  needsReview: boolean;
}

/** Action item extracted from meeting */
export interface ActionItem {
  /** Person responsible */
  assignee: string;
  /** Task description */
  task: string;
  /** Due date if mentioned */
  dueDate?: string;
  /** Whether it's completed */
  completed: boolean;
}

/** Key topic discussed in meeting */
export interface KeyTopic {
  /** Topic title */
  title: string;
  /** Brief description */
  description: string;
  /** Timestamp when discussed */
  timestamp?: string;
}

/** Meeting metadata stored in SQLite and YAML frontmatter */
export interface MeetingMetadata {
  /** Unique meeting ID (format: YYYY-MM-DD-slug) */
  id: string;
  /** Meeting title */
  title: string;
  /** Meeting date (ISO string) */
  date: string;
  /** Duration in seconds */
  durationSeconds: number;
  /** Path to audio file relative to meetings dir */
  audioPath: string;
  /** Path to transcript file relative to meetings dir */
  transcriptPath: string;
  /** Current processing status */
  status: MeetingStatus;
  /** Error message if status is 'error' */
  error?: string;
  /** Speaker mappings as JSON */
  speakerMappings: SpeakerMapping[];
  /** Attendee names provided by user */
  attendees: string[];
  /** Overall speaker mapping confidence */
  confidence?: number;
  /** Language detected */
  language?: string;
  /** Created timestamp (unix ms) */
  createdAt: number;
  /** Last updated timestamp (unix ms) */
  updatedAt: number;
}

/** Transcript segment with speaker and timestamp */
export interface TranscriptSegment {
  /** Timestamp in format HH:MM:SS */
  timestamp: string;
  /** Speaker name (after mapping) or speaker_X (before) */
  speaker: string;
  /** Original speaker ID from transcription */
  originalSpeakerId?: string;
  /** Text content */
  text: string;
  /** Start time in seconds */
  startSeconds: number;
  /** End time in seconds */
  endSeconds: number;
}

/** Full meeting data including transcript */
export interface Meeting extends MeetingMetadata {
  /** AI-generated summary */
  summary?: string;
  /** Extracted action items */
  actionItems: ActionItem[];
  /** Key topics discussed */
  keyTopics: KeyTopic[];
  /** Formatted transcript segments */
  transcript: TranscriptSegment[];
  /** Raw transcription result from ElevenLabs */
  rawTranscription?: TranscriptionResult;
}

/** Options for creating a new meeting */
export interface CreateMeetingOptions {
  /** Meeting title */
  title: string;
  /** Audio file buffer */
  audioBuffer: Buffer;
  /** Audio file name (for extension detection) */
  audioFileName: string;
  /** Attendee names for speaker identification */
  attendees: string[];
  /** Telegram chat ID for notifications */
  chatId: number;
  /** Additional context for speaker mapping */
  context?: string;
}

/** Options for remapping speakers */
export interface RemapSpeakersOptions {
  /** Additional context to help with mapping */
  context?: string;
  /** Manual overrides for specific speakers */
  overrides?: Record<string, string>;
}

/** Result of speaker mapping operation */
export interface SpeakerMappingResult {
  mappings: SpeakerMapping[];
  confidence: number;
  needsReview: boolean;
}

/** Meeting file format (YAML frontmatter + markdown) */
export interface MeetingFileContent {
  frontmatter: {
    id: string;
    title: string;
    date: string;
    duration: number;
    attendees: string[];
    audio: string;
    speaker_mappings: Record<string, string>;
    confidence: number;
    language?: string;
  };
  summary: string;
  actionItems: ActionItem[];
  keyTopics: KeyTopic[];
  transcript: TranscriptSegment[];
}

/** Notification sent when meeting processing completes */
export interface MeetingNotification {
  meetingId: string;
  title: string;
  status: MeetingStatus;
  duration?: string;
  summary?: string;
  error?: string;
}

/** Database row for meetings table */
export interface MeetingRow {
  id: string;
  title: string;
  date: string;
  duration_seconds: number;
  audio_path: string;
  transcript_path: string;
  status: string;
  error: string | null;
  speaker_mappings: string; // JSON
  attendees: string; // JSON
  confidence: number | null;
  language: string | null;
  chat_id: number;
  context: string | null;
  created_at: number;
  updated_at: number;
}

/** Convert database row to MeetingMetadata */
export function rowToMetadata(row: MeetingRow): MeetingMetadata {
  return {
    id: row.id,
    title: row.title,
    date: row.date,
    durationSeconds: row.duration_seconds,
    audioPath: row.audio_path,
    transcriptPath: row.transcript_path,
    status: row.status as MeetingStatus,
    error: row.error ?? undefined,
    speakerMappings: JSON.parse(row.speaker_mappings || "[]"),
    attendees: JSON.parse(row.attendees || "[]"),
    confidence: row.confidence ?? undefined,
    language: row.language ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Convert MeetingMetadata to database row values */
export function metadataToRow(
  metadata: MeetingMetadata,
  chatId: number,
  context?: string
): Omit<MeetingRow, "id"> & { id: string } {
  return {
    id: metadata.id,
    title: metadata.title,
    date: metadata.date,
    duration_seconds: metadata.durationSeconds,
    audio_path: metadata.audioPath,
    transcript_path: metadata.transcriptPath,
    status: metadata.status,
    error: metadata.error ?? null,
    speaker_mappings: JSON.stringify(metadata.speakerMappings),
    attendees: JSON.stringify(metadata.attendees),
    confidence: metadata.confidence ?? null,
    language: metadata.language ?? null,
    chat_id: chatId,
    context: context ?? null,
    created_at: metadata.createdAt,
    updated_at: metadata.updatedAt,
  };
}

/** Format seconds to HH:MM:SS */
export function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/** Format duration for display */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);

  return parts.join(" ");
}

/** Group words by speaker into segments */
export function groupWordsIntoSegments(
  words: TranscriptionWord[],
  speakerMappings: SpeakerMapping[]
): TranscriptSegment[] {
  if (!words || words.length === 0) return [];

  const mappingLookup = new Map(
    speakerMappings.map(m => [m.speakerId, m.mappedName])
  );

  const segments: TranscriptSegment[] = [];
  let currentSegment: Partial<TranscriptSegment> | null = null;
  let currentWords: string[] = [];

  for (const word of words) {
    const speakerId = word.speaker_id || "unknown";
    const mappedName = mappingLookup.get(speakerId) || speakerId;

    if (!currentSegment || currentSegment.originalSpeakerId !== speakerId) {
      // Save previous segment
      if (currentSegment && currentWords.length > 0) {
        segments.push({
          timestamp: formatTimestamp(currentSegment.startSeconds || 0),
          speaker: currentSegment.speaker || "Unknown",
          originalSpeakerId: currentSegment.originalSpeakerId,
          text: currentWords.join(" "),
          startSeconds: currentSegment.startSeconds || 0,
          endSeconds: currentSegment.endSeconds || 0,
        });
      }

      // Start new segment
      currentSegment = {
        speaker: mappedName,
        originalSpeakerId: speakerId,
        startSeconds: word.start,
        endSeconds: word.end,
      };
      currentWords = [word.text];
    } else {
      // Continue current segment
      currentWords.push(word.text);
      currentSegment.endSeconds = word.end;
    }
  }

  // Don't forget last segment
  if (currentSegment && currentWords.length > 0) {
    segments.push({
      timestamp: formatTimestamp(currentSegment.startSeconds || 0),
      speaker: currentSegment.speaker || "Unknown",
      originalSpeakerId: currentSegment.originalSpeakerId,
      text: currentWords.join(" "),
      startSeconds: currentSegment.startSeconds || 0,
      endSeconds: currentSegment.endSeconds || 0,
    });
  }

  return segments;
}
