/**
 * Meeting processor for background job queue
 *
 * Handles meeting transcription jobs from the queue
 */

import type { StateManager } from "../state/manager.js";
import type { Bot } from "grammy";
import type { VoiceConfig } from "../voice/types.js";
import type { MeetingMetadata, MeetingStatus } from "./types.js";
import { processMeeting, retranscribeMeeting, remapMeetingSpeakers } from "./pipeline.js";
import { formatDuration } from "./types.js";
import { logger } from "../utils/logger.js";

export interface MeetingJob {
  type: "transcribe" | "retranscribe" | "remap";
  meetingId: string;
  title?: string;
  audioBuffer?: Buffer;
  audioFileName?: string;
  attendees?: string[];
  chatId: number;
  context?: string;
  overrides?: Record<string, string>;
}

export interface MeetingProcessorConfig {
  stateManager: StateManager;
  voiceConfig: VoiceConfig;
  bot?: Bot;
}

/**
 * Create meeting processor for handling queue jobs
 */
export function createMeetingProcessor(config: MeetingProcessorConfig) {
  const { stateManager, voiceConfig, bot } = config;

  /**
   * Update meeting status in database
   */
  function updateMeetingStatus(meetingId: string, status: MeetingStatus, error?: string): void {
    const now = Date.now();
    stateManager.db
      .prepare(
        `UPDATE meetings SET status = ?, error = ?, updated_at = ? WHERE id = ?`
      )
      .run(status, error ?? null, now, meetingId);

    logger.debug({ meetingId, status, error }, "Meeting status updated");
  }

  /**
   * Send Telegram notification
   */
  async function notify(chatId: number, message: string): Promise<void> {
    if (!bot) {
      logger.warn({ chatId }, "Bot not configured, skipping notification");
      return;
    }

    try {
      await bot.api.sendMessage(chatId, message, { parse_mode: "Markdown" });
    } catch (error) {
      logger.error({ error, chatId }, "Failed to send notification");
    }
  }

  /**
   * Process a meeting job
   */
  async function processJob(job: MeetingJob): Promise<void> {
    logger.info({ jobType: job.type, meetingId: job.meetingId }, "Processing meeting job");

    try {
      switch (job.type) {
        case "transcribe": {
          if (!job.audioBuffer || !job.audioFileName || !job.attendees) {
            throw new Error("Missing required fields for transcription");
          }

          // Insert pending meeting record
          const now = Date.now();
          stateManager.db
            .prepare(
              `INSERT INTO meetings (id, title, date, duration_seconds, audio_path, transcript_path, status, attendees, chat_id, context, created_at, updated_at)
               VALUES (?, ?, ?, 0, '', '', 'pending', ?, ?, ?, ?, ?)`
            )
            .run(
              job.meetingId,
              job.title || "Processing...",
              new Date().toISOString(),
              JSON.stringify(job.attendees),
              job.chatId,
              job.context ?? null,
              now,
              now
            );

          const meeting = await processMeeting(
            {
              title: job.title || "Meeting",
              audioBuffer: job.audioBuffer,
              audioFileName: job.audioFileName,
              attendees: job.attendees,
              chatId: job.chatId,
              context: job.context,
            },
            {
              voiceConfig,
              onStatusChange: updateMeetingStatus,
              onComplete: async (m) => {
                // Update database with full meeting info
                stateManager.db
                  .prepare(
                    `UPDATE meetings SET
                       title = ?, date = ?, duration_seconds = ?, audio_path = ?, transcript_path = ?,
                       status = 'complete', speaker_mappings = ?, confidence = ?, language = ?, updated_at = ?
                     WHERE id = ?`
                  )
                  .run(
                    m.title,
                    m.date,
                    m.durationSeconds,
                    m.audioPath,
                    m.transcriptPath,
                    JSON.stringify(m.speakerMappings),
                    m.confidence ?? null,
                    m.language ?? null,
                    Date.now(),
                    m.id
                  );

                // Send notification
                const duration = formatDuration(m.durationSeconds);
                const confidence = m.confidence ? `${Math.round(m.confidence * 100)}%` : "N/A";
                const actionCount = m.actionItems.length;

                let message = `*Meeting Transcribed*\n\n`;
                message += `*${m.title}*\n`;
                message += `Duration: ${duration}\n`;
                message += `Speaker confidence: ${confidence}\n`;
                message += `Action items: ${actionCount}\n\n`;

                if (m.summary) {
                  const shortSummary = m.summary.slice(0, 300);
                  message += `*Summary:*\n${shortSummary}${m.summary.length > 300 ? "..." : ""}\n`;
                }

                await notify(job.chatId, message);
              },
            }
          );

          logger.info({ meetingId: meeting.id }, "Meeting transcription complete");
          break;
        }

        case "retranscribe": {
          // Get existing metadata
          const row = stateManager.db
            .prepare("SELECT * FROM meetings WHERE id = ?")
            .get(job.meetingId) as any;

          if (!row) {
            throw new Error(`Meeting not found: ${job.meetingId}`);
          }

          const metadata: MeetingMetadata = {
            id: row.id,
            title: row.title,
            date: row.date,
            durationSeconds: row.duration_seconds,
            audioPath: row.audio_path,
            transcriptPath: row.transcript_path,
            status: row.status,
            speakerMappings: JSON.parse(row.speaker_mappings || "[]"),
            attendees: JSON.parse(row.attendees || "[]"),
            confidence: row.confidence,
            language: row.language,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          };

          await retranscribeMeeting(metadata, {
            voiceConfig,
            onStatusChange: updateMeetingStatus,
            onComplete: async (m) => {
              stateManager.db
                .prepare(
                  `UPDATE meetings SET
                     duration_seconds = ?, status = 'complete', speaker_mappings = ?,
                     confidence = ?, language = ?, updated_at = ?
                   WHERE id = ?`
                )
                .run(
                  m.durationSeconds,
                  JSON.stringify(m.speakerMappings),
                  m.confidence ?? null,
                  m.language ?? null,
                  Date.now(),
                  m.id
                );

              await notify(job.chatId, `*Meeting Re-transcribed*\n\n${m.title} has been re-transcribed.`);
            },
          });
          break;
        }

        case "remap": {
          // Get existing metadata
          const row = stateManager.db
            .prepare("SELECT * FROM meetings WHERE id = ?")
            .get(job.meetingId) as any;

          if (!row) {
            throw new Error(`Meeting not found: ${job.meetingId}`);
          }

          const metadata: MeetingMetadata = {
            id: row.id,
            title: row.title,
            date: row.date,
            durationSeconds: row.duration_seconds,
            audioPath: row.audio_path,
            transcriptPath: row.transcript_path,
            status: row.status,
            speakerMappings: JSON.parse(row.speaker_mappings || "[]"),
            attendees: JSON.parse(row.attendees || "[]"),
            confidence: row.confidence,
            language: row.language,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          };

          await remapMeetingSpeakers(
            job.meetingId,
            metadata,
            {
              context: job.context,
              overrides: job.overrides,
            },
            {
              voiceConfig,
              onStatusChange: updateMeetingStatus,
              onComplete: async (m) => {
                stateManager.db
                  .prepare(
                    `UPDATE meetings SET speaker_mappings = ?, confidence = ?, updated_at = ? WHERE id = ?`
                  )
                  .run(
                    JSON.stringify(m.speakerMappings),
                    m.confidence ?? null,
                    Date.now(),
                    m.id
                  );

                await notify(job.chatId, `*Speaker Labels Updated*\n\n${m.title} speaker mappings have been updated.`);
              },
            }
          );
          break;
        }

        default:
          throw new Error(`Unknown job type: ${(job as any).type}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error, job }, "Meeting job failed");

      // Update status to error
      updateMeetingStatus(job.meetingId, "error", errorMessage);

      // Notify user of failure
      await notify(job.chatId, `*Meeting Processing Failed*\n\nError: ${errorMessage}`);

      throw error;
    }
  }

  return {
    processJob,
    updateMeetingStatus,
    notify,
  };
}
