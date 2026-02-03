/**
 * Meeting Recording System
 *
 * Provides Otter.ai-like meeting recording functionality:
 * - Receives audio files via Telegram (as documents)
 * - Transcribes with ElevenLabs Scribe v2 (speaker diarization, timestamps)
 * - Identifies speakers using context + attendee list
 * - Stores in ~/memory/meetings/ for search and recall
 */

import type { StateManager } from "../state/manager.js";
import type { Bot } from "grammy";
import type { VoiceConfig } from "../voice/types.js";
import type {
  Meeting,
  MeetingMetadata,
  MeetingStatus,
  MeetingRow,
  CreateMeetingOptions,
  RemapSpeakersOptions,
} from "./types.js";
import { rowToMetadata } from "./types.js";
import { createMeetingProcessor, type MeetingJob } from "./processor.js";
import {
  readMeetingFile,
  deleteMeetingFile,
  deleteAudioFile,
  generateMeetingId,
  ensureMeetingsDirs,
} from "./storage.js";
import { logger } from "../utils/logger.js";

export interface MeetingManagerConfig {
  stateManager: StateManager;
  voiceConfig: VoiceConfig;
  bot?: Bot;
}

/**
 * MeetingManager - Public API for meeting system
 */
export class MeetingManager {
  private stateManager: StateManager;
  private processor: ReturnType<typeof createMeetingProcessor>;
  private processingQueue: Map<string, MeetingJob> = new Map();

  constructor(config: MeetingManagerConfig) {
    this.stateManager = config.stateManager;
    this.processor = createMeetingProcessor({
      stateManager: config.stateManager,
      voiceConfig: config.voiceConfig,
      bot: config.bot,
    });
  }

  /**
   * Initialize the meeting system
   */
  async initialize(): Promise<void> {
    await ensureMeetingsDirs();
    logger.info("Meeting manager initialized");
  }

  /**
   * Start processing a new meeting
   * Returns immediately with meeting ID, processing happens in background
   */
  async startMeetingProcessing(options: CreateMeetingOptions): Promise<string> {
    const meetingId = generateMeetingId(new Date(), options.title);

    const job: MeetingJob = {
      type: "transcribe",
      meetingId,
      title: options.title,
      audioBuffer: options.audioBuffer,
      audioFileName: options.audioFileName,
      attendees: options.attendees,
      chatId: options.chatId,
      context: options.context,
    };

    // Store in processing queue
    this.processingQueue.set(meetingId, job);

    // Process in background (don't await)
    this.processJobBackground(meetingId, job);

    return meetingId;
  }

  /**
   * Process job in background
   */
  private async processJobBackground(meetingId: string, job: MeetingJob): Promise<void> {
    try {
      await this.processor.processJob(job);
    } catch (error) {
      logger.error({ meetingId, error }, "Background meeting processing failed");
    } finally {
      this.processingQueue.delete(meetingId);
    }
  }

  /**
   * Get meeting by ID
   */
  async getMeeting(meetingId: string): Promise<Meeting | null> {
    // Get metadata from database
    const row = this.stateManager.db
      .prepare("SELECT * FROM meetings WHERE id = ?")
      .get(meetingId) as MeetingRow | undefined;

    if (!row) {
      return null;
    }

    const metadata = rowToMetadata(row);

    // If not complete, return just metadata
    if (metadata.status !== "complete") {
      return {
        ...metadata,
        actionItems: [],
        keyTopics: [],
        transcript: [],
      };
    }

    // Read full meeting from file
    const fileContent = await readMeetingFile(meetingId);
    if (!fileContent) {
      return {
        ...metadata,
        actionItems: [],
        keyTopics: [],
        transcript: [],
      };
    }

    return {
      ...metadata,
      summary: fileContent.summary,
      actionItems: fileContent.actionItems,
      keyTopics: fileContent.keyTopics,
      transcript: fileContent.transcript,
    };
  }

  /**
   * List all meetings
   */
  listMeetings(options?: {
    status?: MeetingStatus;
    limit?: number;
    offset?: number;
  }): MeetingMetadata[] {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    let query = "SELECT * FROM meetings";
    const params: (string | number)[] = [];

    if (options?.status) {
      query += " WHERE status = ?";
      params.push(options.status);
    }

    query += " ORDER BY date DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.stateManager.db
      .prepare(query)
      .all(...params) as MeetingRow[];

    return rows.map(rowToMetadata);
  }

  /**
   * Get meeting status
   */
  getStatus(meetingId: string): MeetingStatus | null {
    const row = this.stateManager.db
      .prepare("SELECT status FROM meetings WHERE id = ?")
      .get(meetingId) as { status: string } | undefined;

    return (row?.status as MeetingStatus) ?? null;
  }

  /**
   * Check if a meeting is currently processing
   */
  isProcessing(meetingId: string): boolean {
    return this.processingQueue.has(meetingId);
  }

  /**
   * Re-transcribe a meeting (expensive)
   */
  async retranscribe(meetingId: string, chatId: number): Promise<void> {
    const job: MeetingJob = {
      type: "retranscribe",
      meetingId,
      chatId,
    };

    this.processingQueue.set(meetingId, job);
    this.processJobBackground(meetingId, job);
  }

  /**
   * Remap speakers with additional context or manual overrides
   */
  async remapSpeakers(
    meetingId: string,
    chatId: number,
    options: RemapSpeakersOptions
  ): Promise<void> {
    const job: MeetingJob = {
      type: "remap",
      meetingId,
      chatId,
      context: options.context,
      overrides: options.overrides,
    };

    this.processingQueue.set(meetingId, job);
    this.processJobBackground(meetingId, job);
  }

  /**
   * Update meeting title
   */
  updateTitle(meetingId: string, title: string): boolean {
    const result = this.stateManager.db
      .prepare("UPDATE meetings SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, Date.now(), meetingId);

    return result.changes > 0;
  }

  /**
   * Update action item completion status
   */
  async updateActionItem(
    meetingId: string,
    itemIndex: number,
    completed: boolean
  ): Promise<boolean> {
    const meeting = await this.getMeeting(meetingId);
    if (!meeting || !meeting.actionItems[itemIndex]) {
      return false;
    }

    meeting.actionItems[itemIndex].completed = completed;

    // Re-save the meeting file
    const { saveMeetingFile } = await import("./storage.js");
    await saveMeetingFile(meeting);

    return true;
  }

  /**
   * Delete a meeting
   */
  async deleteMeeting(meetingId: string): Promise<boolean> {
    const row = this.stateManager.db
      .prepare("SELECT audio_path FROM meetings WHERE id = ?")
      .get(meetingId) as { audio_path: string } | undefined;

    if (!row) {
      return false;
    }

    // Delete files
    try {
      await deleteMeetingFile(meetingId);
      if (row.audio_path) {
        await deleteAudioFile(row.audio_path);
      }
    } catch (error) {
      logger.warn({ meetingId, error }, "Failed to delete meeting files");
    }

    // Delete from database
    const result = this.stateManager.db
      .prepare("DELETE FROM meetings WHERE id = ?")
      .run(meetingId);

    return result.changes > 0;
  }

  /**
   * Search meetings by text
   */
  searchMeetings(query: string, limit: number = 10): MeetingMetadata[] {
    // Simple LIKE search on title and attendees
    // For full-text search, use the memory indexer
    const rows = this.stateManager.db
      .prepare(
        `SELECT * FROM meetings
         WHERE title LIKE ? OR attendees LIKE ?
         ORDER BY date DESC
         LIMIT ?`
      )
      .all(`%${query}%`, `%${query}%`, limit) as MeetingRow[];

    return rows.map(rowToMetadata);
  }

  /**
   * Get meetings by attendee
   */
  getMeetingsByAttendee(attendeeName: string): MeetingMetadata[] {
    const rows = this.stateManager.db
      .prepare(
        `SELECT * FROM meetings
         WHERE attendees LIKE ?
         ORDER BY date DESC`
      )
      .all(`%${attendeeName}%`) as MeetingRow[];

    return rows.map(rowToMetadata);
  }

  /**
   * Get meetings in date range
   */
  getMeetingsInRange(startDate: Date, endDate: Date): MeetingMetadata[] {
    const rows = this.stateManager.db
      .prepare(
        `SELECT * FROM meetings
         WHERE date >= ? AND date <= ?
         ORDER BY date DESC`
      )
      .all(startDate.toISOString(), endDate.toISOString()) as MeetingRow[];

    return rows.map(rowToMetadata);
  }

  /**
   * Get statistics
   */
  getStats(): {
    total: number;
    complete: number;
    processing: number;
    error: number;
    totalDurationSeconds: number;
  } {
    const stats = this.stateManager.db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) as complete,
           SUM(CASE WHEN status IN ('pending', 'transcribing', 'mapping', 'summarizing') THEN 1 ELSE 0 END) as processing,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error,
           SUM(duration_seconds) as total_duration
         FROM meetings`
      )
      .get() as {
        total: number;
        complete: number;
        processing: number;
        error: number;
        total_duration: number | null;
      };

    return {
      total: stats.total,
      complete: stats.complete,
      processing: stats.processing,
      error: stats.error,
      totalDurationSeconds: stats.total_duration ?? 0,
    };
  }
}

// Export types and utilities
export * from "./types.js";
export { formatDuration, formatTimestamp } from "./types.js";
