import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "crypto";
import type { CLIRunManager } from "../../executors/cli-runner.js";
import type { StreamStepEvent } from "../../executors/claude.js";
import type { StateManager } from "../../state/manager.js";
import { logger } from "../../utils/logger.js";
import { webLane } from "../../utils/lanes.js";
import { getUploadPath } from "./uploads.js";

/** Structured attachment stored in thread_messages.metadata */
export interface MessageAttachment {
  id: string;
  sessionId: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
}

const HEARTBEAT_INTERVAL = 30_000; // 30 seconds
const LOCK_TTL_MS = 32 * 60 * 1000; // 32 minutes (slightly above Claude timeout)
const FILE_OUTPUT_HINT =
  "If you create files (html, csv, xlsx, docx, etc.), upload them to Azure Blob Storage (homer-data container) using the MCP tools (blob_upload or blob_upload_content). Upload directly to the container root — do NOT use any prefix or subfolder. Always include the blob URL in your response so the user can download it.";

/**
 * Thread lock management for preventing concurrent streams
 * Synchronous check-and-set pattern to avoid race conditions
 */
interface ThreadLock {
  owner: string;
  heartbeatAt: number;
}

const threadLocks = new Map<string, ThreadLock>();

function acquireLock(threadId: string): { acquired: boolean; owner?: string; reqId?: string } {
  const reqId = randomUUID();
  const now = Date.now();
  const existing = threadLocks.get(threadId);

  if (existing && now - existing.heartbeatAt < LOCK_TTL_MS) {
    return { acquired: false, owner: existing.owner };
  }

  threadLocks.set(threadId, { owner: reqId, heartbeatAt: now });
  return { acquired: true, reqId };
}

function releaseLock(threadId: string, reqId: string): void {
  const current = threadLocks.get(threadId);
  if (current?.owner === reqId) {
    threadLocks.delete(threadId);
  }
}

function updateLockHeartbeat(threadId: string, reqId: string): void {
  const current = threadLocks.get(threadId);
  if (current?.owner === reqId) {
    current.heartbeatAt = Date.now();
  }
}

interface SendMessageBody {
  content: string;
  attachments?: string[]; // Legacy: array of upload IDs
  richAttachments?: MessageAttachment[]; // Structured attachment objects
  sessionId?: string; // Session ID for looking up attachments
}

function getIncrementalDelta(previous: string, next: string): string {
  if (!next || next === previous) return "";
  if (!previous) return next;
  if (next.startsWith(previous)) return next.slice(previous.length);
  return `\n\n${next}`;
}

/**
 * Register streaming endpoints for chat
 *
 * Note: Only Claude is supported. For ChatGPT/Gemini, use Claude Code
 * with the browser skill to interact with those services.
 */
export function registerStreamingRoutes(
  server: FastifyInstance,
  stateManager: StateManager,
  runManager: CLIRunManager | null
): void {
  /**
   * POST /api/threads/:threadId/stream
   *
   * Send a message and stream the response via SSE.
   * Supports reconnection via Last-Event-ID header.
   */
  server.post(
    "/api/threads/:threadId/stream",
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const { threadId } = request.params as { threadId: string };
      const body = request.body as SendMessageBody;
      const lastEventId = request.headers["last-event-id"] as string | undefined;

      if (!runManager) {
        reply.status(503).send({ error: "CLI run manager unavailable" });
        return;
      }

      const thread = stateManager.getThread(threadId);
      if (!thread) {
        reply.status(404).send({ error: "Thread not found" });
        return;
      }

      if (thread.provider !== "claude") {
        reply.status(400).send({
          error: `Direct streaming not supported for provider: ${thread.provider}. Use Claude with the browser skill instead.`
        });
        return;
      }

      const lane = webLane(thread.chatSessionId);
      let executorState = stateManager.getCurrentExecutor(lane);
      if (executorState && executorState.executor !== "claude") {
        reply.status(400).send({
          error: `Streaming disabled while executor is set to ${executorState.executor}. Use non-streaming execution instead.`
        });
        return;
      }

      if (!body.content || typeof body.content !== "string") {
        reply.status(400).send({ error: "content is required" });
        return;
      }

      const lock = acquireLock(threadId);
      if (!lock.acquired) {
        reply.status(409).send({
          error: "Thread is busy",
          code: "THREAD_BUSY",
          message: "Another request is currently processing. Please wait for it to complete.",
        });
        return;
      }
      const lockReqId = lock.reqId!;
      const existingMessageIds = new Set(
        stateManager.listThreadMessages(threadId).map((message) => message.id)
      );

      if (runManager.getActiveRun(lane)) {
        releaseLock(threadId, lockReqId);
        reply.status(409).send({
          error: "A run is already in progress for this session",
          code: "THREAD_BUSY",
          message: "Another request is currently processing. Please wait for it to complete.",
        });
        return;
      }

      // Resolve attachments: prefer richAttachments (structured), fall back to legacy ID-based resolution
      // Rich attachments are validated: each must resolve to a real file via getUploadPath
      let resolvedAttachments: MessageAttachment[] = [];
      let attachmentPaths: string[] = [];

      if (body.richAttachments && body.richAttachments.length > 0) {
        for (const att of body.richAttachments) {
          const verifiedPath = getUploadPath(att.sessionId, att.id);
          if (verifiedPath) {
            resolvedAttachments.push({ ...att, path: verifiedPath });
            attachmentPaths.push(verifiedPath);
          } else {
            logger.warn({ id: att.id, sessionId: att.sessionId }, "Ignoring unverified rich attachment");
          }
        }
      } else if (body.attachments && body.attachments.length > 0) {
        attachmentPaths = body.attachments
          .map((uploadId) => (body.sessionId ? getUploadPath(body.sessionId, uploadId) : null))
          .filter((path): path is string => Boolean(path));
      }

      if (thread.externalSessionId) {
        if (!executorState) {
          stateManager.setCurrentExecutor(
            lane,
            "claude",
            thread.model ?? undefined,
            thread.externalSessionId
          );
          executorState = stateManager.getCurrentExecutor(lane);
        } else if (!executorState.sessionId) {
          stateManager.setExecutorSessionId(
            lane,
            thread.externalSessionId,
            "claude",
            executorState.model ?? thread.model ?? null
          );
          executorState = stateManager.getCurrentExecutor(lane);
        }
      }

      const userMessageId = randomUUID();
      const messageMetadata = resolvedAttachments.length > 0
        ? { attachments: resolvedAttachments }
        : attachmentPaths.length > 0
          ? { attachments: attachmentPaths }
          : undefined;
      stateManager.createThreadMessage({
        id: userMessageId,
        threadId,
        role: "user",
        content: body.content,
        metadata: messageMetadata,
      });
      existingMessageIds.add(userMessageId);

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

      let eventId = lastEventId ? parseInt(lastEventId, 10) : 0;
      let heartbeatInterval: NodeJS.Timeout | undefined;
      let lockHeartbeatInterval: NodeJS.Timeout | undefined;
      let finished = false;
      let cleanedUp = false;
      let replyEnded = false;
      let streamedContent = "";
      let runId: string | null = null;

      const sendEvent = (type: string, data: Record<string, unknown>) => {
        if (reply.raw.destroyed || reply.raw.writableEnded) return;
        eventId++;
        reply.raw.write(`id: ${eventId}\n`);
        reply.raw.write(`event: ${type}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const endReply = () => {
        if (replyEnded || reply.raw.destroyed || reply.raw.writableEnded) return;
        replyEnded = true;
        reply.raw.end();
      };

      const cleanup = (options?: { cancelRun?: boolean; reason?: string }) => {
        if (cleanedUp) return;
        cleanedUp = true;

        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
        }
        if (lockHeartbeatInterval) {
          clearInterval(lockHeartbeatInterval);
        }

        releaseLock(threadId, lockReqId);

        if (options?.cancelRun && !finished) {
          runManager.cancelRun(lane, options.reason ?? "stream cancelled");
        }
      };

      heartbeatInterval = setInterval(() => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.write(": heartbeat\n\n");
        }
      }, HEARTBEAT_INTERVAL);

      lockHeartbeatInterval = setInterval(() => {
        updateLockHeartbeat(threadId, lockReqId);
      }, 60_000);

      // IMPORTANT: Listen on reply.raw (response), NOT request.raw (request).
      // For POST requests, request.raw "close" fires when the body is fully read (~2ms),
      // not when the client disconnects. reply.raw "close" fires on actual TCP disconnect.
      reply.raw.on("close", () => {
        if (finished || replyEnded) return; // Normal completion, not a disconnect
        logger.info({ threadId, runId }, "SSE response stream closed by client");
        // Don't cancel — let the run finish. Frontend can poll /api/runs/:id.
        cleanup({ cancelRun: false, reason: "sse response closed" });
      });

      request.raw.on("aborted", () => {
        logger.debug({ threadId, runId }, "SSE request upload aborted");
        // Only cancel if the upload itself was aborted (body never fully received)
        cleanup({ cancelRun: true, reason: "request upload aborted" });
      });

      // Buffer step events until runId is known, then flush
      const bufferedSteps: StreamStepEvent[] = [];
      let runIdKnown = false;

      try {
        const query = `${FILE_OUTPUT_HINT}\n\n${body.content}`;

        const startedRun = await runManager.startRun({
          lane,
          query,
          cwd: process.env.HOME ?? "/Users/yj",
          attachments: attachmentPaths,
          threadId,
          contextBeforeMessageId: userMessageId,
          onPartial: (nextText) => {
            const delta = getIncrementalDelta(streamedContent, nextText);
            if (!delta) return;
            streamedContent += delta;
            sendEvent("delta", { content: delta });
          },
          onEvent: (stepEvent: StreamStepEvent) => {
            sendEvent("step", stepEvent as unknown as Record<string, unknown>);
            // Persist step event for replay after navigation
            if (runIdKnown && runId) {
              try {
                stateManager.createRunEvent({
                  id: randomUUID(),
                  runId,
                  threadId,
                  kind: stepEvent.type,
                  label: stepEvent.label,
                  labelDone: stepEvent.labelDone,
                  payload: stepEvent.id ? { toolId: stepEvent.id } : undefined,
                });
              } catch (e) {
                logger.warn({ error: e }, "Failed to persist run event");
              }
            } else {
              bufferedSteps.push(stepEvent);
            }
          },
        });

        runId = startedRun.runId;
        runIdKnown = true;
        sendEvent("start", { userMessageId, runId });

        // Flush buffered step events now that runId is known
        for (const step of bufferedSteps) {
          try {
            stateManager.createRunEvent({
              id: randomUUID(),
              runId,
              threadId,
              kind: step.type,
              label: step.label,
              labelDone: step.labelDone,
              payload: step.id ? { toolId: step.id } : undefined,
            });
          } catch (e) {
            logger.warn({ error: e }, "Failed to persist buffered run event");
          }
        }
        bufferedSteps.length = 0;

        const result = await startedRun.result;
        finished = true;

        const finalDelta = getIncrementalDelta(streamedContent, result.output);
        if (finalDelta) {
          streamedContent += finalDelta;
          sendEvent("delta", { content: finalDelta });
        }

        if (result.executor === "claude" && result.sessionId && result.sessionId !== thread.externalSessionId) {
          stateManager.updateThread(threadId, { externalSessionId: result.sessionId });
        }

        const newAssistantMessage = [...stateManager.listThreadMessages(threadId)]
          .reverse()
          .find((message) => message.role === "assistant" && !existingMessageIds.has(message.id));

        cleanup();

        // Emit error event for failed runs so the frontend can show retry UI
        if (result.status === "failed") {
          const errorOutput = (result.output ?? "").trim();
          const isRateLimit = /rate.?limit|quota|429|capacity|exhausted/i.test(errorOutput);
          sendEvent("error", {
            message: isRateLimit ? "Rate limit reached. Try again in a moment." : "Run failed.",
            recoverable: isRateLimit,
            code: isRateLimit ? "RATE_LIMIT" : "RUN_FAILED",
          });
          endReply();
          return;
        }

        sendEvent("complete", {
          messageId: newAssistantMessage?.id ?? null,
          runId,
          exitCode: result.exitCode,
          status: result.status,
          executor: result.executor,
        });
        endReply();
      } catch (error) {
        // Discard buffered step events if run never started (runId never assigned)
        bufferedSteps.length = 0;
        cleanup({ cancelRun: true, reason: "stream setup failed" });
        logger.error({ error, threadId, runId }, "Streaming error");
        sendEvent("error", {
          message: error instanceof Error ? error.message : "Unknown error",
          recoverable: false,
        });
        endReply();
      }
    }
  );
}
