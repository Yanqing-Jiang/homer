import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { StateManager } from "../../state/manager.js";
import { CLIRunManager } from "../../executors/cli-runner.js";
import { logger } from "../../utils/logger.js";
import { webLane } from "../../utils/lanes.js";
import { config } from "../../config/index.js";

interface ExecuteBody {
  content: string;
  attachments?: string[]; // file paths
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const STATUS_POLL_INTERVAL_MS = 5_000;

function filterAttachmentPaths(paths: string[] | undefined): string[] {
  if (!paths || paths.length === 0) return [];
  const base = config.paths.uploadLanding;
  return paths.filter((p) => typeof p === "string" && p.startsWith(base) && existsSync(p));
}

export function registerRunRoutes(
  server: FastifyInstance,
  stateManager: StateManager,
  runManager: CLIRunManager
): void {
  // Start a non-streaming CLI run
  server.post(
    "/api/threads/:threadId/execute",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { threadId } = request.params as { threadId: string };
      const body = request.body as ExecuteBody;

      if (!body.content) {
        reply.status(400);
        return { error: "content is required" };
      }

      const thread = stateManager.getThread(threadId);
      if (!thread) {
        reply.status(404);
        return { error: "Thread not found" };
      }

      const lane = webLane(thread.chatSessionId);
      if (runManager.getActiveRun(lane)) {
        reply.status(409);
        return { error: "A run is already in progress for this session" };
      }

      // Create user message
      const userMessageId = randomUUID();
      stateManager.createThreadMessage({
        id: userMessageId,
        threadId,
        role: "user",
        content: body.content,
      });

      const attachments = filterAttachmentPaths(body.attachments);

      // Start run
      try {
        const { runId } = await runManager.startRun({
          lane,
          query: body.content,
          cwd: process.env.HOME ?? "/Users/yj",
          attachments,
          threadId,
        });

        return { runId, userMessageId };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to start run";
        logger.warn({ error, threadId }, "Run start failed");
        reply.status(409);
        return { error: message };
      }
    }
  );

  // Get run details
  server.get("/api/runs/:runId", async (request: FastifyRequest, reply: FastifyReply) => {
    const { runId } = request.params as { runId: string };
    const run = stateManager.getCliRun(runId);
    if (!run) {
      reply.status(404);
      return { error: "Run not found" };
    }
    return { run };
  });

  // SSE: status + heartbeat
  server.get("/api/runs/:runId/events", async (request: FastifyRequest, reply: FastifyReply) => {
    const { runId } = request.params as { runId: string };
    const origin = request.headers.origin;

    const corsHeaders: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    };

    if (origin) {
      corsHeaders["Access-Control-Allow-Origin"] = origin;
      corsHeaders["Access-Control-Allow-Credentials"] = "true";
    }

    reply.raw.writeHead(200, corsHeaders);

    let eventId = 0;
    let lastStatus: string | null = null;

    const sendEvent = (type: string, data: Record<string, unknown>) => {
      eventId++;
      reply.raw.write(`id: ${eventId}\n`);
      reply.raw.write(`event: ${type}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      sendEvent("heartbeat", { ts: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);

    const poll = setInterval(() => {
      const run = stateManager.getCliRun(runId);
      if (!run) {
        sendEvent("status", { runId, status: "missing" });
        cleanup();
        return;
      }
      if (run.status !== lastStatus) {
        lastStatus = run.status;
        sendEvent("status", { runId, status: run.status, executor: run.executor });
      }
      if (["completed", "failed", "cancelled"].includes(run.status)) {
        cleanup();
      }
    }, STATUS_POLL_INTERVAL_MS);

    const cleanup = () => {
      clearInterval(heartbeat);
      clearInterval(poll);
      reply.raw.end();
    };

    request.raw.on("close", () => {
      cleanup();
    });

    request.raw.on("aborted", () => {
      cleanup();
    });

    // Send initial status
    const initial = stateManager.getCliRun(runId);
    if (initial) {
      lastStatus = initial.status;
      sendEvent("status", { runId, status: initial.status, executor: initial.executor });
    }
  });
}
