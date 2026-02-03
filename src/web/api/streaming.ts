import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import type { StateManager } from "../../state/manager.js";
import { logger } from "../../utils/logger.js";
import { getUploadContent } from "./uploads.js";
import { processResponse } from "../../utils/response-processor.js";

const CLAUDE_PATH = process.env.CLAUDE_PATH ?? "/Users/yj/.local/bin/claude";
const DEFAULT_TIMEOUT = 1200_000; // 20 minutes
const HEARTBEAT_INTERVAL = 30_000; // 30 seconds

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

      if (!body.content || typeof body.content !== "string") {
        reply.status(400).send({ error: "content is required" });
        return;
      }

      // Build message content with attachments
      let messageContent = body.content;

      if (body.attachments && body.attachments.length > 0 && body.sessionId) {
        const attachmentContents: string[] = [];

        for (const uploadId of body.attachments) {
          const content = getUploadContent(body.sessionId, uploadId);
          if (content) {
            attachmentContents.push(`<attachment id="${uploadId}">\n${content}\n</attachment>`);
          }
        }

        if (attachmentContents.length > 0) {
          messageContent = `${attachmentContents.join("\n\n")}\n\n${body.content}`;
        }
      }

      // Create user message
      const userMessageId = randomUUID();
      stateManager.createThreadMessage({
        id: userMessageId,
        threadId,
        role: "user",
        content: messageContent,
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

      const cleanup = () => {
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
        }
        // Kill spawned process if still running
        if (proc && proc.exitCode === null) {
          logger.debug({ threadId }, "Killing Claude process due to cleanup");
          proc.kill("SIGTERM");
          // Force kill after 5s if still running
          setTimeout(() => {
            if (proc && proc.exitCode === null) {
              logger.warn({ threadId }, "Force killing Claude process");
              proc.kill("SIGKILL");
            }
          }, 5000);
        }
      };

      // Heartbeat to prevent proxy timeouts
      heartbeatInterval = setInterval(() => {
        reply.raw.write(": heartbeat\n\n");
      }, HEARTBEAT_INTERVAL);

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
        };

        // Load OAuth token
        const tokenFile = `${process.env.HOME ?? "/Users/yj"}/.homer-claude-token`;
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
          cwd: process.env.HOME ?? "/Users/yj",
          env,
          stdio: ["pipe", "pipe", "pipe"],
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
        proc.on("close", async (code) => {
          cleanup();

          // Detect session expiry from stderr
          const sessionExpired =
            stderrContent.includes("session not found") ||
            stderrContent.includes("session expired");

          if (sessionExpired) {
            // Mark thread as expired
            stateManager.updateThread(threadId, { status: "expired" });
            sendEvent("error", {
              message: "Session expired",
              recoverable: true,
              code: "SESSION_EXPIRED",
            });
            reply.raw.end();
            return;
          }

          // Process memory updates and save assistant message
          const assistantMessageId = randomUUID();
          if (assistantContent.trim()) {
            // Process memory updates before saving
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
          }

          // Update thread with captured session ID
          if (capturedSessionId && capturedSessionId !== thread.externalSessionId) {
            stateManager.updateThread(threadId, {
              externalSessionId: capturedSessionId,
            });
          }

          // Send completion event
          sendEvent("complete", {
            messageId: assistantMessageId,
            exitCode: code,
          });

          reply.raw.end();
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
            proc.kill("SIGTERM");
            setTimeout(() => {
              if (proc && proc.exitCode === null) {
                proc.kill("SIGKILL");
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
