/**
 * Meeting API routes
 *
 * REST API for managing meeting recordings
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { StateManager } from "../../state/manager.js";
import type { MeetingRow, MeetingStatus } from "../../meetings/types.js";
import { rowToMetadata, formatDuration } from "../../meetings/types.js";
import { readMeetingFile, readAudioFile } from "../../meetings/storage.js";
import { logger } from "../../utils/logger.js";

// MeetingManager reference (set from main)
let meetingManagerRef: any = null;

export function setMeetingsManager(manager: any): void {
  meetingManagerRef = manager;
}

export function registerMeetingsRoutes(
  server: FastifyInstance,
  stateManager: StateManager
): void {
  // GET /api/meetings - List all meetings
  server.get("/api/meetings", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as {
      status?: MeetingStatus;
      limit?: string;
      offset?: string;
    };

    const limit = parseInt(query.limit ?? "50", 10);
    const offset = parseInt(query.offset ?? "0", 10);

    let sql = "SELECT * FROM meetings";
    const params: (string | number)[] = [];

    if (query.status) {
      sql += " WHERE status = ?";
      params.push(query.status);
    }

    sql += " ORDER BY date DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    try {
      const rows = stateManager.db.prepare(sql).all(...params) as MeetingRow[];

      const meetings = rows.map((row) => {
        const metadata = rowToMetadata(row);
        return {
          ...metadata,
          durationFormatted: formatDuration(metadata.durationSeconds),
          dateFormatted: new Date(metadata.date).toLocaleDateString(),
        };
      });

      // Get total count
      let countSql = "SELECT COUNT(*) as total FROM meetings";
      if (query.status) {
        countSql += " WHERE status = ?";
      }
      const countResult = stateManager.db
        .prepare(countSql)
        .get(...(query.status ? [query.status] : [])) as { total: number };

      return {
        meetings,
        total: countResult.total,
        limit,
        offset,
      };
    } catch (error) {
      logger.error({ error }, "Failed to list meetings");
      reply.status(500);
      return { error: "Failed to list meetings" };
    }
  });

  // GET /api/meetings/:id - Get single meeting with full transcript
  server.get("/api/meetings/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    try {
      const row = stateManager.db
        .prepare("SELECT * FROM meetings WHERE id = ?")
        .get(id) as MeetingRow | undefined;

      if (!row) {
        reply.status(404);
        return { error: "Meeting not found" };
      }

      const metadata = rowToMetadata(row);

      // If complete, read full transcript from file
      if (metadata.status === "complete") {
        const fileContent = await readMeetingFile(id);
        if (fileContent) {
          return {
            ...metadata,
            durationFormatted: formatDuration(metadata.durationSeconds),
            dateFormatted: new Date(metadata.date).toLocaleDateString(),
            summary: fileContent.summary,
            actionItems: fileContent.actionItems,
            keyTopics: fileContent.keyTopics,
            transcript: fileContent.transcript,
          };
        }
      }

      return {
        ...metadata,
        durationFormatted: formatDuration(metadata.durationSeconds),
        dateFormatted: new Date(metadata.date).toLocaleDateString(),
        summary: null,
        actionItems: [],
        keyTopics: [],
        transcript: [],
      };
    } catch (error) {
      logger.error({ error, id }, "Failed to get meeting");
      reply.status(500);
      return { error: "Failed to get meeting" };
    }
  });

  // GET /api/meetings/:id/status - Poll processing status
  server.get("/api/meetings/:id/status", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    try {
      const row = stateManager.db
        .prepare("SELECT id, status, error, updated_at FROM meetings WHERE id = ?")
        .get(id) as { id: string; status: string; error: string | null; updated_at: number } | undefined;

      if (!row) {
        reply.status(404);
        return { error: "Meeting not found" };
      }

      return {
        id: row.id,
        status: row.status,
        error: row.error,
        updatedAt: row.updated_at,
        isProcessing: ["pending", "transcribing", "mapping", "summarizing"].includes(row.status),
      };
    } catch (error) {
      logger.error({ error, id }, "Failed to get meeting status");
      reply.status(500);
      return { error: "Failed to get meeting status" };
    }
  });

  // POST /api/meetings/:id/remap - Re-run speaker mapping
  server.post("/api/meetings/:id/remap", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      context?: string;
      overrides?: Record<string, string>;
      chatId?: number;
    };

    if (!meetingManagerRef) {
      reply.status(503);
      return { error: "Meeting system not initialized" };
    }

    try {
      const row = stateManager.db
        .prepare("SELECT * FROM meetings WHERE id = ?")
        .get(id) as MeetingRow | undefined;

      if (!row) {
        reply.status(404);
        return { error: "Meeting not found" };
      }

      if (row.status !== "complete") {
        reply.status(400);
        return { error: "Cannot remap - meeting not complete" };
      }

      // Start remap in background
      await meetingManagerRef.remapSpeakers(id, body.chatId ?? 0, {
        context: body.context,
        overrides: body.overrides,
      });

      return {
        success: true,
        message: "Speaker remapping started",
        meetingId: id,
      };
    } catch (error) {
      logger.error({ error, id }, "Failed to start remap");
      reply.status(500);
      return { error: "Failed to start speaker remapping" };
    }
  });

  // POST /api/meetings/:id/retranscribe - Re-run full transcription
  server.post("/api/meetings/:id/retranscribe", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { chatId?: number; confirm?: boolean };

    if (!meetingManagerRef) {
      reply.status(503);
      return { error: "Meeting system not initialized" };
    }

    // Require confirmation for expensive operation
    if (!body.confirm) {
      reply.status(400);
      return {
        error: "Confirmation required",
        message: "Re-transcription is expensive. Set confirm: true to proceed.",
      };
    }

    try {
      const row = stateManager.db
        .prepare("SELECT * FROM meetings WHERE id = ?")
        .get(id) as MeetingRow | undefined;

      if (!row) {
        reply.status(404);
        return { error: "Meeting not found" };
      }

      // Start retranscription in background
      await meetingManagerRef.retranscribe(id, body.chatId ?? 0);

      return {
        success: true,
        message: "Re-transcription started",
        meetingId: id,
      };
    } catch (error) {
      logger.error({ error, id }, "Failed to start retranscribe");
      reply.status(500);
      return { error: "Failed to start re-transcription" };
    }
  });

  // PATCH /api/meetings/:id/speakers - Manual speaker override
  server.patch("/api/meetings/:id/speakers", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { mappings: Record<string, string> };

    if (!meetingManagerRef) {
      reply.status(503);
      return { error: "Meeting system not initialized" };
    }

    if (!body.mappings || typeof body.mappings !== "object") {
      reply.status(400);
      return { error: "Invalid mappings format" };
    }

    try {
      // Apply overrides immediately (not background)
      await meetingManagerRef.remapSpeakers(id, 0, {
        overrides: body.mappings,
      });

      return {
        success: true,
        message: "Speaker mappings updated",
        meetingId: id,
      };
    } catch (error) {
      logger.error({ error, id }, "Failed to update speakers");
      reply.status(500);
      return { error: "Failed to update speaker mappings" };
    }
  });

  // PATCH /api/meetings/:id/title - Update meeting title
  server.patch("/api/meetings/:id/title", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { title: string };

    if (!body.title || typeof body.title !== "string") {
      reply.status(400);
      return { error: "Title is required" };
    }

    try {
      const result = stateManager.db
        .prepare("UPDATE meetings SET title = ?, updated_at = ? WHERE id = ?")
        .run(body.title.trim(), Date.now(), id);

      if (result.changes === 0) {
        reply.status(404);
        return { error: "Meeting not found" };
      }

      return {
        success: true,
        meetingId: id,
        title: body.title.trim(),
      };
    } catch (error) {
      logger.error({ error, id }, "Failed to update title");
      reply.status(500);
      return { error: "Failed to update title" };
    }
  });

  // PATCH /api/meetings/:id/action-items/:index - Toggle action item completion
  server.patch(
    "/api/meetings/:id/action-items/:index",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id, index } = request.params as { id: string; index: string };
      const body = request.body as { completed: boolean };

      if (typeof body.completed !== "boolean") {
        reply.status(400);
        return { error: "completed field is required" };
      }

      if (!meetingManagerRef) {
        reply.status(503);
        return { error: "Meeting system not initialized" };
      }

      try {
        const success = await meetingManagerRef.updateActionItem(
          id,
          parseInt(index, 10),
          body.completed
        );

        if (!success) {
          reply.status(404);
          return { error: "Meeting or action item not found" };
        }

        return {
          success: true,
          meetingId: id,
          itemIndex: parseInt(index, 10),
          completed: body.completed,
        };
      } catch (error) {
        logger.error({ error, id, index }, "Failed to update action item");
        reply.status(500);
        return { error: "Failed to update action item" };
      }
    }
  );

  // DELETE /api/meetings/:id - Delete meeting
  server.delete("/api/meetings/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { confirm?: string };

    // Require confirmation
    if (query.confirm !== "true") {
      reply.status(400);
      return {
        error: "Confirmation required",
        message: "Add ?confirm=true to delete permanently",
      };
    }

    if (!meetingManagerRef) {
      reply.status(503);
      return { error: "Meeting system not initialized" };
    }

    try {
      const deleted = await meetingManagerRef.deleteMeeting(id);

      if (!deleted) {
        reply.status(404);
        return { error: "Meeting not found" };
      }

      return {
        success: true,
        message: "Meeting deleted",
        meetingId: id,
      };
    } catch (error) {
      logger.error({ error, id }, "Failed to delete meeting");
      reply.status(500);
      return { error: "Failed to delete meeting" };
    }
  });

  // GET /api/meetings/:id/audio - Download audio file
  server.get("/api/meetings/:id/audio", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    try {
      const row = stateManager.db
        .prepare("SELECT audio_path FROM meetings WHERE id = ?")
        .get(id) as { audio_path: string } | undefined;

      if (!row || !row.audio_path) {
        reply.status(404);
        return { error: "Meeting or audio not found" };
      }

      const audioBuffer = await readAudioFile(row.audio_path);
      if (!audioBuffer) {
        reply.status(404);
        return { error: "Audio file not found" };
      }

      // Determine content type from extension
      const ext = row.audio_path.split(".").pop()?.toLowerCase();
      const contentTypes: Record<string, string> = {
        mp3: "audio/mpeg",
        m4a: "audio/mp4",
        ogg: "audio/ogg",
        wav: "audio/wav",
      };

      reply.header("Content-Type", contentTypes[ext || ""] || "audio/mpeg");
      reply.header("Content-Disposition", `attachment; filename="${id}.${ext || "mp3"}"`);
      return reply.send(audioBuffer);
    } catch (error) {
      logger.error({ error, id }, "Failed to get audio");
      reply.status(500);
      return { error: "Failed to get audio file" };
    }
  });

  // GET /api/meetings/stats - Meeting statistics
  server.get("/api/meetings/stats", async (_request: FastifyRequest, _reply: FastifyReply) => {
    try {
      const stats = stateManager.db
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
        totalDurationFormatted: formatDuration(stats.total_duration ?? 0),
      };
    } catch (error) {
      logger.error({ error }, "Failed to get meeting stats");
      return {
        total: 0,
        complete: 0,
        processing: 0,
        error: 0,
        totalDurationSeconds: 0,
        totalDurationFormatted: "0s",
      };
    }
  });

  // GET /api/meetings/search - Search meetings
  server.get("/api/meetings/search", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { q: string; limit?: string };

    if (!query.q) {
      reply.status(400);
      return { error: "Query parameter 'q' is required" };
    }

    const limit = parseInt(query.limit ?? "20", 10);

    try {
      const rows = stateManager.db
        .prepare(
          `SELECT * FROM meetings
           WHERE title LIKE ? OR attendees LIKE ?
           ORDER BY date DESC
           LIMIT ?`
        )
        .all(`%${query.q}%`, `%${query.q}%`, limit) as MeetingRow[];

      const meetings = rows.map((row) => {
        const metadata = rowToMetadata(row);
        return {
          ...metadata,
          durationFormatted: formatDuration(metadata.durationSeconds),
          dateFormatted: new Date(metadata.date).toLocaleDateString(),
        };
      });

      return { meetings, query: query.q };
    } catch (error) {
      logger.error({ error, query: query.q }, "Failed to search meetings");
      reply.status(500);
      return { error: "Search failed" };
    }
  });
}
