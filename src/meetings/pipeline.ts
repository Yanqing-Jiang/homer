/**
 * Meeting processing pipeline
 *
 * Orchestrates: transcription -> speaker mapping -> summarization -> storage
 */

import type {
  Meeting,
  MeetingMetadata,
  MeetingStatus,
  CreateMeetingOptions,
  RemapSpeakersOptions,
  SpeakerMapping,
} from "./types.js";
import { groupWordsIntoSegments, formatDuration } from "./types.js";
import type { TranscriptionResult } from "../voice/types.js";
import { transcribeMeeting } from "../voice/stt.js";
import { mapSpeakers, applyManualOverrides } from "./speaker-mapper.js";
import { summarizeMeeting } from "./summarizer.js";
import {
  generateMeetingId,
  saveAudioFile,
  saveMeetingFile,
  readMeetingFile,
  readAudioFile,
} from "./storage.js";
import type { VoiceConfig } from "../voice/types.js";
import { logger } from "../utils/logger.js";

export interface PipelineConfig {
  voiceConfig: VoiceConfig;
  onStatusChange?: (meetingId: string, status: MeetingStatus, error?: string) => void;
  onComplete?: (meeting: Meeting) => void;
}

export interface ProcessingState {
  meetingId: string;
  status: MeetingStatus;
  transcription?: TranscriptionResult;
  speakerMappings?: SpeakerMapping[];
  error?: string;
}

/**
 * Run full meeting processing pipeline
 */
export async function processMeeting(
  options: CreateMeetingOptions,
  config: PipelineConfig
): Promise<Meeting> {
  const now = Date.now();
  const date = new Date();

  // Generate title if not provided
  const title = options.title || `Meeting ${date.toLocaleDateString()}`;

  // Generate meeting ID
  const meetingId = generateMeetingId(date, title);

  logger.info({ meetingId, title, attendees: options.attendees }, "Starting meeting processing");

  // 1. Save audio file immediately
  const audioPath = await saveAudioFile(
    meetingId,
    options.audioBuffer,
    options.audioFileName
  );

  const updateStatus = (status: MeetingStatus, error?: string) => {
    config.onStatusChange?.(meetingId, status, error);
  };

  try {
    // 2. Transcribe with ElevenLabs Scribe v2
    updateStatus("transcribing");
    logger.info({ meetingId }, "Transcribing audio");

    const transcription = await transcribeMeeting(
      options.audioBuffer,
      config.voiceConfig,
      {
        title,
        expectedSpeakers: options.attendees.length,
        keyterms: options.attendees, // Help recognition of attendee names
      }
    );

    // Calculate duration from transcript
    const words = transcription.words || [];
    const lastWord = words[words.length - 1];
    const durationSeconds = lastWord ? Math.ceil(lastWord.end) : 0;

    logger.info(
      {
        meetingId,
        textLength: transcription.text.length,
        wordCount: words.length,
        duration: durationSeconds,
        language: transcription.language,
      },
      "Transcription complete"
    );

    // 3. Map speakers
    updateStatus("mapping");
    logger.info({ meetingId }, "Mapping speakers");

    const mappingResult = await mapSpeakers(
      transcription,
      options.attendees,
      options.context
    );

    // 4. Generate summary
    updateStatus("summarizing");
    logger.info({ meetingId }, "Generating summary");

    const summaryResult = await summarizeMeeting(
      transcription,
      mappingResult.mappings,
      title,
      options.attendees
    );

    // 5. Build complete meeting object
    const transcript = groupWordsIntoSegments(words, mappingResult.mappings);

    const meeting: Meeting = {
      id: meetingId,
      title,
      date: date.toISOString(),
      durationSeconds,
      audioPath,
      transcriptPath: `${meetingId}.md`,
      status: "complete",
      speakerMappings: mappingResult.mappings,
      attendees: options.attendees,
      confidence: mappingResult.confidence,
      language: transcription.language,
      createdAt: now,
      updatedAt: Date.now(),
      summary: summaryResult.summary,
      actionItems: summaryResult.actionItems,
      keyTopics: summaryResult.keyTopics,
      transcript,
      rawTranscription: transcription,
    };

    // 6. Save to file
    await saveMeetingFile(meeting);

    updateStatus("complete");
    config.onComplete?.(meeting);

    logger.info(
      {
        meetingId,
        duration: formatDuration(durationSeconds),
        speakers: mappingResult.mappings.length,
        actionItems: summaryResult.actionItems.length,
        confidence: mappingResult.confidence,
      },
      "Meeting processing complete"
    );

    return meeting;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ meetingId, error }, "Meeting processing failed");
    updateStatus("error", errorMessage);
    throw error;
  }
}

/**
 * Re-transcribe a meeting (expensive operation)
 */
export async function retranscribeMeeting(
  metadata: MeetingMetadata,
  config: PipelineConfig
): Promise<Meeting> {
  logger.info({ meetingId: metadata.id }, "Re-transcribing meeting");

  // Read audio file
  const audioBuffer = await readAudioFile(metadata.audioPath);
  if (!audioBuffer) {
    throw new Error(`Audio file not found: ${metadata.audioPath}`);
  }

  // Run through pipeline with existing attendees
  return processMeeting(
    {
      title: metadata.title,
      audioBuffer,
      audioFileName: metadata.audioPath,
      attendees: metadata.attendees,
      chatId: 0, // Not used for retranscription
    },
    config
  );
}

/**
 * Remap speakers with additional context (cheaper operation)
 */
export async function remapMeetingSpeakers(
  meetingId: string,
  metadata: MeetingMetadata,
  options: RemapSpeakersOptions,
  config: PipelineConfig
): Promise<Meeting> {
  logger.info({ meetingId, hasContext: !!options.context, hasOverrides: !!options.overrides }, "Remapping speakers");

  // Read existing meeting file
  const fileContent = await readMeetingFile(meetingId);
  if (!fileContent) {
    throw new Error(`Meeting file not found: ${meetingId}`);
  }

  // Need raw transcription for remapping
  // Since we don't store raw transcription in file, we need to read audio and re-transcribe
  // For now, just apply manual overrides if provided
  if (options.overrides && Object.keys(options.overrides).length > 0) {
    const updatedMappings = applyManualOverrides(
      metadata.speakerMappings,
      options.overrides
    );

    // Update transcript with new mappings
    const transcript = fileContent.transcript.map((segment) => {
      const mapping = updatedMappings.find(m => m.speakerId === segment.originalSpeakerId);
      return {
        ...segment,
        speaker: mapping?.mappedName || segment.speaker,
      };
    });

    const meeting: Meeting = {
      ...metadata,
      speakerMappings: updatedMappings,
      confidence: 1.0, // Manual overrides = full confidence
      updatedAt: Date.now(),
      summary: fileContent.summary,
      actionItems: fileContent.actionItems,
      keyTopics: fileContent.keyTopics,
      transcript,
    };

    await saveMeetingFile(meeting);
    config.onStatusChange?.(meetingId, "complete");

    return meeting;
  }

  // If context provided but no overrides, we need the raw transcription
  // This would require re-transcription or storing raw transcription
  // For now, return error
  throw new Error("Context-based remapping requires re-transcription. Use retranscribe instead.");
}

/**
 * Quick meeting info from just the first few seconds
 */
export async function quickAnalyze(
  audioBuffer: Buffer,
  config: PipelineConfig
): Promise<{ estimatedDuration: number; detectedLanguage?: string; speakerCount: number }> {
  // Transcribe just a portion for quick analysis
  const sampleBuffer = audioBuffer.slice(0, Math.min(audioBuffer.length, 1024 * 1024)); // First 1MB

  try {
    const transcription = await transcribeMeeting(
      sampleBuffer,
      config.voiceConfig,
      { expectedSpeakers: 8 }
    );

    const words = transcription.words || [];
    const speakers = new Set(words.map(w => w.speaker_id).filter(Boolean));

    // Estimate duration based on sample
    const lastWordInSample = words[words.length - 1];
    const sampleDuration = lastWordInSample ? lastWordInSample.end : 0;
    const ratio = audioBuffer.length / sampleBuffer.length;
    const estimatedDuration = Math.round(sampleDuration * ratio);

    return {
      estimatedDuration,
      detectedLanguage: transcription.language,
      speakerCount: speakers.size,
    };
  } catch (error) {
    logger.warn({ error }, "Quick analysis failed");
    return {
      estimatedDuration: 0,
      speakerCount: 0,
    };
  }
}
