import Fastify, { type FastifyInstance } from "fastify";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { StateManager } from "../state/manager.js";
import { QueueManager } from "../queue/manager.js";
import { createRoutes, setWebScheduler } from "./routes.js";
import type { Scheduler } from "../scheduler/index.js";

export async function createWebServer(
  stateManager: StateManager,
  queueManager: QueueManager,
  scheduler?: Scheduler
): Promise<FastifyInstance> {
  const server = Fastify({
    logger: false, // Use our own logger
  });

  // Set scheduler reference for routes
  if (scheduler) {
    setWebScheduler(scheduler);
  }

  // Register routes
  createRoutes(server, stateManager, queueManager);

  return server;
}

export async function startWebServer(server: FastifyInstance): Promise<void> {
  try {
    // Bind to localhost only for security (no authentication implemented)
    await server.listen({ port: config.web.port, host: "127.0.0.1" });
    logger.info({ port: config.web.port, host: "127.0.0.1" }, "Web server started");
  } catch (error) {
    logger.error({ error }, "Failed to start web server");
    throw error;
  }
}

export async function stopWebServer(server: FastifyInstance): Promise<void> {
  await server.close();
  logger.info("Web server stopped");
}
