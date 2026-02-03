/**
 * Command and Executor API Routes
 *
 * Provides endpoints for:
 * - Listing available commands
 * - Managing executor state for sessions
 * - Non-streaming execution for non-Claude executors
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { StateManager, type ExecutorStateType } from "../../state/manager.js";
import { logger } from "../../utils/logger.js";
import {
  getAvailableCommands,
  getExecutorCommands,
  getExecutorModel,
  type ExecutorType,
} from "../../commands/index.js";
import type { CLIRunManager } from "../../executors/cli-runner.js";
import { webLane } from "../../utils/lanes.js";

interface SetExecutorBody {
  executor: ExecutorType;
  model?: string;
}

/**
 * Register command and executor API routes
 */
export function registerCommandRoutes(
  server: FastifyInstance,
  stateManager: StateManager,
  runManager: CLIRunManager | null
): void {
  /**
   * GET /api/commands
   *
   * List all available commands for UI display.
   */
  server.get("/api/commands", async () => {
    const available = getAvailableCommands();

    return {
      commands: available.map((cmd) => ({
        name: cmd.name,
        category: cmd.category,
        description: cmd.description,
        executor: cmd.executor,
        model: cmd.model,
      })),
      executors: getExecutorCommands().map((cmd) => ({
        name: cmd.name,
        executor: cmd.executor,
        description: cmd.description,
        model: cmd.model,
      })),
    };
  });

  /**
   * GET /api/executor/:sessionId
   *
   * Get the current executor state for a session.
   */
  server.get(
    "/api/executor/:sessionId",
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const { sessionId } = request.params as { sessionId: string };

      const lane = webLane(sessionId);
      const state = stateManager.getCurrentExecutor(lane);

      if (!state) {
        return {
          sessionId,
          executor: "claude",
          model: getExecutorModel("claude"),
          isDefault: true,
        };
      }

      return {
        sessionId,
        executor: state.executor,
        model: state.model,
        switchedAt: state.switchedAt,
        messageCount: state.messageCount,
        isDefault: false,
      };
    }
  );

  /**
   * POST /api/executor/:sessionId
   *
   * Set the executor for a session.
   */
  server.post(
    "/api/executor/:sessionId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { sessionId } = request.params as { sessionId: string };
      const body = request.body as SetExecutorBody;

      if (!body.executor) {
        reply.status(400);
        return { error: "executor is required" };
      }

      const validExecutors: ExecutorType[] = [
        "claude",
        "gemini",
        "codex",
      ];

      if (!validExecutors.includes(body.executor)) {
        reply.status(400);
        return {
          error: `Invalid executor: ${body.executor}. Valid options: ${validExecutors.join(", ")}`,
        };
      }

      const model = body.model || getExecutorModel(body.executor);
      // Cancel any active run for this web session
      if (runManager) {
        runManager.cancelRun(webLane(sessionId), "executor switch");
      }

      const lane = webLane(sessionId);
      stateManager.setCurrentExecutor(lane, body.executor as ExecutorStateType, model, null);

      logger.info({ sessionId, executor: body.executor, model }, "Executor set via API");

      return {
        sessionId,
        executor: body.executor,
        model,
        success: true,
      };
    }
  );

  /**
   * DELETE /api/executor/:sessionId
   *
   * Clear executor state (reset to default).
   */
  server.delete(
    "/api/executor/:sessionId",
    async (request: FastifyRequest) => {
      const { sessionId } = request.params as { sessionId: string };

      if (runManager) {
        runManager.cancelRun(webLane(sessionId), "executor reset");
      }

      const lane = webLane(sessionId);
      stateManager.clearExecutor(lane);

      logger.info({ sessionId }, "Executor cleared via API");

      return {
        sessionId,
        executor: "claude",
        model: getExecutorModel("claude"),
        success: true,
      };
    }
  );

  /**
   * GET /api/executor/all
   *
   * List all active executor states (for admin/debugging).
   */
  server.get("/api/executor/all", async () => {
    const states = stateManager.getAllExecutorStates();

    return {
      states: states.map((s) => ({
        lane: s.lane,
        executor: s.executor,
        model: s.model,
        switchedAt: s.switchedAt,
        messageCount: s.messageCount,
        ageMinutes: Math.round((Date.now() - s.switchedAt) / 1000 / 60),
      })),
      count: states.length,
    };
  });
}
