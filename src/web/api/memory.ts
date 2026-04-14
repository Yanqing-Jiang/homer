import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getMemoryIndexer } from "../../memory/indexer.js";
import { logger } from "../../utils/logger.js";

export function registerMemoryRoutes(server: FastifyInstance): void {
  /**
   * GET /api/memory/search?q=<query>&limit=<n>&context=<work|life|general>
   *
   * Direct memory search — calls the MemoryIndexer hybrid search.
   * Returns results instantly without AI mediation.
   */
  server.get("/api/memory/search", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { q?: string; limit?: string; context?: string };

    const searchQuery = (query.q ?? "").trim();
    if (searchQuery.length < 2) {
      return { results: [], query: searchQuery, totalMatches: 0 };
    }

    const limit = Math.min(parseInt(query.limit ?? "10", 10), 30);
    const context = (query.context as "work" | "general" | undefined) || undefined;

    try {
      const indexer = getMemoryIndexer();
      const results = await indexer.hybridSearch(searchQuery, limit, context);

      return {
        results: results.map(r => ({
          filePath: r.filePath,
          content: r.content?.slice(0, 500) ?? null,
          score: r.score,
          source: r.source,
        })),
        query: searchQuery,
        totalMatches: results.length,
      };
    } catch (e) {
      logger.error({ error: e, query: searchQuery }, "Memory search failed");
      reply.status(500);
      return { error: "Search failed", results: [] };
    }
  });
}
