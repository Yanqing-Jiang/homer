import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { StateManager } from "../state/manager.js";
import { QueueManager } from "../queue/manager.js";
import { createRoutes, setWebScheduler } from "./routes.js";
import { registerVoiceWebSocket } from "./voice.js";
import { createAuthHook } from "./auth.js";
import type { Scheduler } from "../scheduler/index.js";
import type { VoiceConfig } from "../voice/types.js";

export interface WebServerOptions {
  stateManager: StateManager;
  queueManager: QueueManager;
  scheduler?: Scheduler;
  voiceConfig?: VoiceConfig;
  processVoiceMessage?: (text: string, conversationId?: string) => Promise<{ response: string; conversationId?: string }>;
}

export async function createWebServer(
  stateManager: StateManager,
  queueManager: QueueManager,
  scheduler?: Scheduler,
  options?: Partial<Pick<WebServerOptions, "voiceConfig" | "processVoiceMessage">>
): Promise<FastifyInstance> {
  const server = Fastify({
    logger: false, // Use our own logger
  });

  // Register WebSocket plugin
  await server.register(websocket);

  // Register multipart plugin for file uploads
  await server.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB
    },
  });

  // Register CORS if externally exposed (for web UI on different domain)
  if (config.web.exposeExternally) {
    await server.register(cors, {
      origin: true, // Allow all origins (Cloudflare Access handles auth)
      credentials: true,
    });
    logger.info("CORS enabled for external access");
  }

  // Add auth hook for API routes when externally exposed
  if (config.web.exposeExternally) {
    server.addHook("onRequest", createAuthHook());
    logger.info("Auth middleware enabled");
  }

  // Set scheduler reference for routes
  if (scheduler) {
    setWebScheduler(scheduler);
  }

  // Register routes
  createRoutes(server, stateManager, queueManager);

  // Register voice WebSocket routes if configured
  if (options?.voiceConfig && options?.processVoiceMessage) {
    registerVoiceWebSocket(server, options.voiceConfig, options.processVoiceMessage);
    logger.info("Voice WebSocket enabled");
  }

  return server;
}

/**
 * Start the web server.
 * If port is in use, another Homer instance is already running - exit immediately.
 * This enforces single-instance operation.
 */
export async function startWebServer(server: FastifyInstance): Promise<void> {
  const host = config.web.exposeExternally ? "0.0.0.0" : "127.0.0.1";
  const port = config.web.port;

  try {
    await server.listen({ port, host });
    logger.info(
      { port, host, authEnabled: config.web.exposeExternally },
      "Web server started"
    );
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "EADDRINUSE") {
      logger.error(
        { port, host },
        `Another Homer instance is already running on port ${port}. Exiting to prevent duplicate daemons.`
      );
      // Exit cleanly (code 0) so launchd/systemd won't restart immediately
      process.exit(0);
    }
    // For other errors, log and exit
    logger.error({ error }, "Failed to start web server");
    process.exit(1);
  }
}

export async function stopWebServer(server: FastifyInstance): Promise<void> {
  await server.close();
  logger.info("Web server stopped");
}
