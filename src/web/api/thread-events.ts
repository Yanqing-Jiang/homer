import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { StateManager } from "../../state/manager.js";
import { threadEvents, type ThreadMessageEvent } from "../../events/thread-events.js";
import { logger } from "../../utils/logger.js";

const HEARTBEAT_INTERVAL = 30_000; // 30 seconds (matches streaming.ts / runs.ts)

export function registerThreadEventRoutes(
  server: FastifyInstance,
  stateManager: StateManager
): void {
  /**
   * GET /api/threads/:threadId/events
   *
   * Persistent SSE stream that pushes new messages for a thread.
   * Supports Last-Event-ID for reconnection (replays missed messages).
   */
  server.get(
    "/api/threads/:threadId/events",
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const { threadId } = request.params as { threadId: string };

      // Validate thread exists
      const thread = stateManager.getThread(threadId);
      if (!thread) {
        reply.status(404).send({ error: "Thread not found" });
        return;
      }

      // Set up SSE headers (pattern from streaming.ts)
      const origin = request.headers.origin;
      const headers: Record<string, string> = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      };

      if (origin) {
        headers["Access-Control-Allow-Origin"] = origin;
        headers["Access-Control-Allow-Credentials"] = "true";
      }

      reply.raw.writeHead(200, headers);

      // Handle reconnection: replay missed messages since Last-Event-ID
      const lastEventId = request.headers["last-event-id"] as
        | string
        | undefined;
      if (lastEventId) {
        const allMessages = stateManager.listThreadMessages(threadId);
        let foundLastEvent = false;
        for (const msg of allMessages) {
          if (foundLastEvent) {
            reply.raw.write(`id: ${msg.id}\n`);
            reply.raw.write(`event: message\n`);
            reply.raw.write(`data: ${JSON.stringify(msg)}\n\n`);
          }
          if (msg.id === lastEventId) {
            foundLastEvent = true;
          }
        }
      }

      // Send connected confirmation
      reply.raw.write(
        `event: connected\ndata: ${JSON.stringify({ threadId })}\n\n`
      );

      // Heartbeat to keep connection alive
      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(`: heartbeat\n\n`);
        } catch {
          cleanup();
        }
      }, HEARTBEAT_INTERVAL);

      // Subscribe to thread events
      const onMessage = (event: ThreadMessageEvent) => {
        try {
          reply.raw.write(`id: ${event.message.id}\n`);
          reply.raw.write(`event: message\n`);
          reply.raw.write(`data: ${JSON.stringify(event.message)}\n\n`);
        } catch {
          cleanup();
        }
      };

      const unsubscribe = threadEvents.onMessage(threadId, onMessage);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          reply.raw.end();
        } catch {
          // Already closed
        }
        logger.debug({ threadId }, "Thread events SSE disconnected");
      };

      // Clean up on disconnect
      request.raw.on("close", cleanup);

      logger.debug({ threadId }, "Thread events SSE connected");
    }
  );
}
