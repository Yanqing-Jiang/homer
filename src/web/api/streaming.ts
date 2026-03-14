import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import type { StateManager } from "../../state/manager.js";
import { logger } from "../../utils/logger.js";
import { processRegistry } from "../../process/registry.js";
import { getUploadPath } from "./uploads.js";
import { processResponse } from "../../utils/response-processor.js";
import { webLane } from "../../utils/lanes.js";
import { getClaudeDefaultModel } from "../../commands/index.js";
import { getRuntimePaths } from "../../utils/runtime-paths.js";

const runtimePaths = getRuntimePaths();
const CLAUDE_PATH = runtimePaths.claudeBinaryPath;
const DEFAULT_TIMEOUT = 1200_000; // 20 minutes
const HEARTBEAT_INTERVAL = 30_000; // 30 seconds
const LOCK_TTL_MS = 22 * 60 * 1000; // 22 minutes (slightly above Claude timeout)
const FILE_OUTPUT_HINT =
  "If you create files (html, csv, xlsx, docx, etc.), upload them to Azure Blob Storage (homer-data container) using the MCP tools (blob_upload or blob_upload_content). Use the prefix 'reports/' for reports and 'exports/' for data exports. Always include the blob URL in your response so the user can download it.";

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

  // Check if currently locked (not expired)
  if (existing && now - existing.heartbeatAt < LOCK_TTL_MS) {
    return { acquired: false, owner: existing.owner };
  }

  // Synchronous set - no await between check and set
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
  attachments?: string[]; // Array of upload IDs
  sessionId?: string; // Session ID for looking up attachments
}

interface ContentBlock {
  type: string;
  text?: string;
}

interface StreamEvent {
  type: string;
  session_id?: string;
  subtype?: string;
  message?: {
    content?: string | ContentBlock[];
  };
  content?: string | ContentBlock[];
  result?: string;
}

/**
 * Extract text from content that may be a string or array of content blocks
 */
function extractTextContent(content: string | ContentBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text)
      .join("");
  }
  return "";
}

/**
 * Register streaming endpoints for chat
 *
 * Note: Only Claude is supported. For ChatGPT/Gemini, use Claude Code
 * with the browser skill to interact with those services.
 */
export function registerStreamingRoutes(
  server: FastifyInstance,
  stateManager: StateManager
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

      // Validate thread exists
      const thread = stateManager.getThread(threadId);
      if (!thread) {
        reply.status(404).send({ error: "Thread not found" });
        return;
      }

      // Only Claude is supported - other providers should use Claude with browser skill
      if (thread.provider !== "claude") {
        reply.status(400).send({
          error: `Direct streaming not supported for provider: ${thread.provider}. Use Claude with the browser skill instead.`
        });
        return;
      }

      const executorState = stateManager.getCurrentExecutor(webLane(thread.chatSessionId));
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

      // Acquire thread lock to prevent concurrent streams
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

      const userContent = body.content;
      let messageContent = userContent;

      if (body.attachments && body.attachments.length > 0 && body.sessionId) {
        const attachmentPaths = body.attachments
          .map((uploadId) => getUploadPath(body.sessionId!, uploadId))
          .filter((path): path is string => Boolean(path));

        if (attachmentPaths.length > 0) {
          messageContent = `Attached files (local paths):\n- ${attachmentPaths.join("\n- ")}\n\n${userContent}`;
        }
      }

      messageContent = `${FILE_OUTPUT_HINT}\n\n${messageContent}`;

      // Create user message
      const userMessageId = randomUUID();
      stateManager.createThreadMessage({
        id: userMessageId,
        threadId,
        role: "user",
        content: userContent,
      });

      // Set up SSE headers (including CORS since we bypass Fastify's response handling)
      const origin = request.headers.origin;
      const corsHeaders: Record<string, string> = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // Disable nginx/Cloudflare buffering
      };

      // Add CORS headers if origin is present (cross-origin request)
      if (origin) {
        corsHeaders["Access-Control-Allow-Origin"] = origin;
        corsHeaders["Access-Control-Allow-Credentials"] = "true";
      }

      reply.raw.writeHead(200, corsHeaders);

      let eventId = lastEventId ? parseInt(lastEventId, 10) : 0;
      let heartbeatInterval: NodeJS.Timeout | undefined;
      let assistantContent = "";
      let capturedSessionId: string | undefined;

      let proc: ReturnType<typeof spawn> | undefined;

      const sendEvent = (type: string, data: Record<string, unknown>) => {
        eventId++;
        reply.raw.write(`id: ${eventId}\n`);
        reply.raw.write(`event: ${type}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      let lockHeartbeatInterval: NodeJS.Timeout | undefined;

      // Kill entire process group (detached) for clean child cleanup
      const killGroup = (sig: NodeJS.Signals) => {
        try {
          if (proc?.pid) process.kill(-proc.pid, sig);
        } catch {
          try { proc?.kill(sig); } catch { /* already dead */ }
        }
      };

      const cleanup = () => {
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
        }
        if (lockHeartbeatInterval) {
          clearInterval(lockHeartbeatInterval);
        }
        // Release thread lock
        releaseLock(threadId, lockReqId);

        // Kill spawned process group if still running
        if (proc && proc.exitCode === null) {
          logger.debug({ threadId }, "Killing Claude process due to cleanup");
          killGroup("SIGTERM");
          // Force kill after 5s if still running
          setTimeout(() => {
            if (proc && proc.exitCode === null) {
              logger.warn({ threadId }, "Force killing Claude process");
              killGroup("SIGKILL");
            }
          }, 5000);
        }
      };

      // Heartbeat to prevent proxy timeouts
      heartbeatInterval = setInterval(() => {
        reply.raw.write(": heartbeat\n\n");
      }, HEARTBEAT_INTERVAL);

      // Update lock heartbeat periodically
      lockHeartbeatInterval = setInterval(() => {
        updateLockHeartbeat(threadId, lockReqId);
      }, 60_000); // Update every minute

      // Handle client disconnect - clean up resources
      request.raw.on("close", () => {
        logger.debug({ threadId }, "SSE client disconnected");
        cleanup();
      });

      // Handle client abort (e.g., browser navigation away)
      request.raw.on("aborted", () => {
        logger.debug({ threadId }, "SSE client aborted");
        cleanup();
      });

      try {
        // Build Claude CLI args
      const args = [
        "--print",
        "--verbose",
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
      ];

      const streamModel = executorState?.model ?? getClaudeDefaultModel(webLane(thread.chatSessionId));
      args.push("--model", streamModel);
      logger.debug({ model: streamModel }, "Using model for streaming");

        // Resume session if we have one
        if (thread.externalSessionId) {
          args.push("--resume", thread.externalSessionId);
          logger.debug({ sessionId: thread.externalSessionId }, "Resuming Claude session");
        }

        args.push(messageContent);

        // Build environment
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          CLAUDE_CODE_ENTRYPOINT: "homer-web",
          CI: "1",
          TERM: "dumb",
          NO_COLOR: "1",
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",
          HOME: runtimePaths.homeDir,
        };

        // Load OAuth token
        const tokenFile = runtimePaths.claudeTokenFile;
        if (!env.CLAUDE_CODE_OAUTH_TOKEN && existsSync(tokenFile)) {
          try {
            const token = readFileSync(tokenFile, "utf-8").trim();
            if (token) {
              env.CLAUDE_CODE_OAUTH_TOKEN = token;
            }
          } catch {
            // Ignore
          }
        }

        // Send initial event
        sendEvent("start", { userMessageId });

        // Spawn Claude CLI
        proc = spawn(CLAUDE_PATH, args, {
          cwd: runtimePaths.homeDir,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });

        // Register with process lifecycle management
        processRegistry.register(proc, {
          command: "claude",
          type: "executor",
          timeoutMs: 30 * 60 * 1000,
          source: "cli-runner",
          detached: true,
        });

        proc.stdin?.end();

        let buffer = "";

        const parseStreamEvent = (line: string) => {
          if (!line.trim()) return;

          try {
            const event = JSON.parse(line) as StreamEvent;

            // Capture session ID
            if ((event.type === "system" || event.type === "init") && event.session_id) {
              capturedSessionId = event.session_id;
              logger.debug({ sessionId: capturedSessionId }, "Captured Claude session ID");
            }

            // Stream assistant content
            if (event.type === "assistant" && event.message?.content) {
              const textContent = extractTextContent(event.message.content);
              if (textContent) {
                assistantContent += textContent;
                sendEvent("delta", { content: textContent });
              }
            }

            // Final result
            if (event.type === "result" && event.result) {
              assistantContent = event.result;
            }
          } catch {
            // Not JSON, ignore
          }
        };

        proc.stdout?.setEncoding("utf8");
        proc.stdout?.on("data", (chunk: string) => {
          if (proc?.pid) processRegistry.touch(proc.pid);
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            parseStreamEvent(line);
          }
        });

        proc.stdout?.on("end", () => {
          if (buffer) {
            parseStreamEvent(buffer);
          }
        });

        let stderrContent = "";
        proc.stderr?.setEncoding("utf8");
        proc.stderr?.on("data", (chunk: string) => {
          stderrContent += chunk;
        });

        // Handle process completion
        proc.on("close", (code) => {
          cleanup();

          // Detect session expiry from stderr
          const sessionExpired =
            stderrContent.includes("session not found") ||
            stderrContent.includes("session expired");

          if (sessionExpired) {
            // Mark thread as expired
            stateManager.updateThread(threadId, { status: "expired" });
            try {
              sendEvent("error", {
                message: "Session expired",
                recoverable: true,
                code: "SESSION_EXPIRED",
              });
              reply.raw.end();
            } catch { /* client disconnected */ }
            return;
          }

          // Process memory updates and save assistant message
          const assistantMessageId = randomUUID();
          (async () => {
            if (assistantContent.trim()) {
              try {
                const { cleanedContent } = await processResponse(assistantContent.trim(), "general");
                stateManager.createThreadMessage({
                  id: assistantMessageId,
                  threadId,
                  role: "assistant",
                  content: cleanedContent,
                  metadata: {
                    exitCode: code,
                    sessionId: capturedSessionId,
                  },
                });
              } catch (err) {
                logger.warn({ error: err, threadId }, "Failed to process response in stream close");
                // Save raw content as fallback
                stateManager.createThreadMessage({
                  id: assistantMessageId,
                  threadId,
                  role: "assistant",
                  content: assistantContent.trim(),
                  metadata: { exitCode: code, sessionId: capturedSessionId },
                });
              }
            }

            // Update thread with captured session ID
            if (capturedSessionId && capturedSessionId !== thread.externalSessionId) {
              stateManager.updateThread(threadId, {
                externalSessionId: capturedSessionId,
              });
            }

            // Send completion event (guard against write-after-end)
            try {
              sendEvent("complete", {
                messageId: assistantMessageId,
                exitCode: code,
              });
              reply.raw.end();
            } catch { /* client disconnected */ }
          })().catch((err) => {
            logger.error({ error: err, threadId }, "Unhandled error in stream close handler");
          });
        });

        proc.on("error", (error) => {
          cleanup();
          logger.error({ error, threadId }, "Claude CLI spawn error");
          sendEvent("error", {
            message: error.message,
            recoverable: false,
          });
          reply.raw.end();
        });

        // Timeout handling
        const timeoutTimer = setTimeout(() => {
          logger.warn({ threadId }, "Claude CLI timed out");
          if (proc) {
            killGroup("SIGTERM");
            setTimeout(() => {
              if (proc && proc.exitCode === null) {
                killGroup("SIGKILL");
              }
            }, 5000);
          }
        }, DEFAULT_TIMEOUT);

        proc.on("close", () => {
          clearTimeout(timeoutTimer);
        });
      } catch (error) {
        cleanup();
        logger.error({ error, threadId }, "Streaming error");
        sendEvent("error", {
          message: error instanceof Error ? error.message : "Unknown error",
          recoverable: false,
        });
        reply.raw.end();
      }
    }
  );
}
