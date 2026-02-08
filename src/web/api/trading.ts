/**
 * Trading API proxy routes.
 *
 * This module proxies requests to the Python Flask trading API service
 * running at localhost:5001.
 *
 * Endpoints:
 *   GET  /api/trading/health              - IBKR connection status
 *   GET  /api/trading/dashboard           - All dashboard data
 *   GET  /api/trading/strategies          - Strategy statuses
 *   POST /api/trading/strategies/:name/start - Start a strategy
 *   POST /api/trading/strategies/:name/stop  - Stop a strategy
 *   GET  /api/trading/positions           - Current positions
 *   GET  /api/trading/trades              - Recent trades
 *   GET  /api/trading/pnl                 - P&L summary
 *   POST /api/trading/start               - Start paper trading
 *   POST /api/trading/stop                - Stop paper trading
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

// Trading API base URL
const TRADING_API_BASE = process.env.TRADING_API_URL || "http://127.0.0.1:5001";

interface ProxyOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  timeout?: number;
}

/**
 * Proxy a request to the trading API.
 */
async function proxyToTradingAPI(
  path: string,
  options: ProxyOptions = {}
): Promise<{ status: number; data: unknown }> {
  const { method = "GET", body, timeout = 10000 } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const url = `${TRADING_API_BASE}${path}`;
    const fetchOptions: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    };

    if (body && method !== "GET") {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);
    clearTimeout(timeoutId);

    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
  } catch (error) {
    clearTimeout(timeoutId);

    if ((error as Error).name === "AbortError") {
      return {
        status: 504,
        data: { error: "Trading API timeout", code: "TIMEOUT" },
      };
    }

    // Connection refused or other network error
    return {
      status: 503,
      data: {
        error: "Trading API unavailable",
        code: "SERVICE_UNAVAILABLE",
        details: (error as Error).message,
      },
    };
  }
}

/**
 * Register trading API routes.
 */
export function registerTradingRoutes(server: FastifyInstance): void {
  // Health check
  server.get(
    "/api/trading/health",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const result = await proxyToTradingAPI("/health");
      reply.status(result.status);
      return result.data;
    }
  );

  // Dashboard - all data in one call
  server.get(
    "/api/trading/dashboard",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const result = await proxyToTradingAPI("/dashboard");
      reply.status(result.status);
      return result.data;
    }
  );

  // List strategies
  server.get(
    "/api/trading/strategies",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const result = await proxyToTradingAPI("/strategies");
      reply.status(result.status);
      return result.data;
    }
  );

  // Start strategy
  server.post(
    "/api/trading/strategies/:name/start",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { name } = request.params as { name: string };
      const result = await proxyToTradingAPI(`/strategies/${name}/start`, {
        method: "POST",
      });
      reply.status(result.status);
      return result.data;
    }
  );

  // Stop strategy
  server.post(
    "/api/trading/strategies/:name/stop",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { name } = request.params as { name: string };
      const result = await proxyToTradingAPI(`/strategies/${name}/stop`, {
        method: "POST",
      });
      reply.status(result.status);
      return result.data;
    }
  );

  // Current positions
  server.get(
    "/api/trading/positions",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const result = await proxyToTradingAPI("/positions");
      reply.status(result.status);
      return result.data;
    }
  );

  // Recent trades
  server.get(
    "/api/trading/trades",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { limit?: string };
      const params = query.limit ? `?limit=${query.limit}` : "";
      const result = await proxyToTradingAPI(`/trades${params}`);
      reply.status(result.status);
      return result.data;
    }
  );

  // P&L summary
  server.get(
    "/api/trading/pnl",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const result = await proxyToTradingAPI("/pnl");
      reply.status(result.status);
      return result.data;
    }
  );

  // Start paper trading
  server.post(
    "/api/trading/start",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body;
      const result = await proxyToTradingAPI("/trading/start", {
        method: "POST",
        body,
      });
      reply.status(result.status);
      return result.data;
    }
  );

  // Stop paper trading
  server.post(
    "/api/trading/stop",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const result = await proxyToTradingAPI("/trading/stop", {
        method: "POST",
      });
      reply.status(result.status);
      return result.data;
    }
  );
}
