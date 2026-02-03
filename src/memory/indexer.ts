import Database from "better-sqlite3";
import { readFile } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { logger } from "../utils/logger.js";
import { chunkText } from "../search/chunker.js";
import { generateEmbedding, generateQueryEmbedding, cosineSimilarity, mergeRRF } from "./embeddings.js";

/**
 * Memory index search result
 */
export interface MemorySearchResult {
  filePath: string;
  chunkIndex: number;
  content: string;
  context: "work" | "life" | "general";
  entryDate: string | null;
  rank: number;
}

/**
 * FTS5 Memory Indexer using SQLite
 *
 * Creates a full-text search index for memory files using SQLite's FTS5 extension.
 * Supports searching across all memory files with ranking.
 */
export class MemoryIndexer {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.init();
  }

  private init(): void {
    // Create FTS5 virtual table for memory search with chunk support
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        file_path,
        chunk_index UNINDEXED,
        content,
        context UNINDEXED,
        entry_date UNINDEXED,
        tokenize='porter unicode61'
      );

      -- Metadata table to track indexed files
      CREATE TABLE IF NOT EXISTS memory_index_meta (
        file_path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 1,
        indexed_at TEXT NOT NULL,
        context TEXT NOT NULL
      );

      -- Embeddings table for semantic search (Gemini embedding-001)
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        file_path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        dimensions INTEGER NOT NULL DEFAULT 768,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (file_path, chunk_index)
      );
    `);

    logger.debug("Memory indexer initialized");
  }

  /**
   * Index a single memory file with chunking for efficient retrieval
   */
  async indexFile(
    filePath: string,
    context: "work" | "life" | "general",
    entryDate?: string
  ): Promise<boolean> {
    if (!existsSync(filePath)) {
      logger.debug({ filePath }, "File does not exist, skipping index");
      return false;
    }

    try {
      const content = await readFile(filePath, "utf-8");
      const contentHash = this.hashContent(content);

      // Check if already indexed with same content
      const existing = this.db
        .prepare("SELECT content_hash FROM memory_index_meta WHERE file_path = ?")
        .get(filePath) as { content_hash: string } | undefined;

      if (existing?.content_hash === contentHash) {
        logger.debug({ filePath }, "File unchanged, skipping reindex");
        return false;
      }

      // Remove old entries for this file (FTS and embeddings)
      this.db
        .prepare("DELETE FROM memory_fts WHERE file_path = ?")
        .run(filePath);
      this.db
        .prepare("DELETE FROM memory_embeddings WHERE file_path = ?")
        .run(filePath);

      // Chunk the content (512 tokens, 50 token overlap)
      const chunks = chunkText(content, 512, 50);

      // Insert each chunk
      const insert = this.db.prepare(
        "INSERT INTO memory_fts (file_path, chunk_index, content, context, entry_date) VALUES (?, ?, ?, ?, ?)"
      );

      for (const chunk of chunks) {
        insert.run(filePath, chunk.chunkIndex, chunk.content, context, entryDate || null);
      }

      // Update metadata with chunk count
      this.db
        .prepare(
          `INSERT INTO memory_index_meta (file_path, content_hash, chunk_count, indexed_at, context)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(file_path) DO UPDATE SET
             content_hash = excluded.content_hash,
             chunk_count = excluded.chunk_count,
             indexed_at = excluded.indexed_at,
             context = excluded.context`
        )
        .run(filePath, contentHash, chunks.length, new Date().toISOString(), context);

      logger.info({ filePath, context, contentLength: content.length, chunkCount: chunks.length }, "Indexed memory file");
      return true;
    } catch (error) {
      logger.error({ error, filePath }, "Failed to index file");
      return false;
    }
  }

  /**
   * Index all standard memory files
   */
  async indexAllMemoryFiles(): Promise<{ indexed: number; skipped: number; errors: number }> {
    const stats = { indexed: 0, skipped: 0, errors: 0 };

    // Core memory files (identity, preferences, tools)
    const coreFiles: Array<{ path: string; context: "work" | "life" | "general" }> = [
      { path: "/Users/yj/memory/me.md", context: "general" },
      { path: "/Users/yj/memory/work.md", context: "work" },
      { path: "/Users/yj/memory/life.md", context: "life" },
      { path: "/Users/yj/memory/preferences.md", context: "general" },
      { path: "/Users/yj/memory/tools.md", context: "general" },
    ];

    for (const { path, context } of coreFiles) {
      try {
        const indexed = await this.indexFile(path, context);
        if (indexed) stats.indexed++;
        else stats.skipped++;
      } catch {
        stats.errors++;
      }
    }

    // Daily log files
    const dailyLogsDir = "/Users/yj/memory/daily";
    if (existsSync(dailyLogsDir)) {
      const files = readdirSync(dailyLogsDir);
      const datePattern = /^\d{4}-\d{2}-\d{2}.*\.md$/;

      for (const file of files) {
        if (datePattern.test(file)) {
          const entryDate = file.replace(".md", "");
          const filePath = `${dailyLogsDir}/${file}`;
          try {
            const indexed = await this.indexFile(filePath, "general", entryDate);
            if (indexed) stats.indexed++;
            else stats.skipped++;
          } catch {
            stats.errors++;
          }
        }
      }
    }

    // Meeting transcripts
    const meetingsDir = "/Users/yj/memory/meetings";
    if (existsSync(meetingsDir)) {
      const files = readdirSync(meetingsDir);
      const meetingPattern = /^\d{4}-\d{2}-\d{2}-.*\.md$/;

      for (const file of files) {
        if (meetingPattern.test(file)) {
          const meetingDate = file.slice(0, 10); // Extract YYYY-MM-DD
          const filePath = `${meetingsDir}/${file}`;
          try {
            const indexed = await this.indexFile(filePath, "work", meetingDate);
            if (indexed) stats.indexed++;
            else stats.skipped++;
          } catch {
            stats.errors++;
          }
        }
      }
    }

    logger.info(stats, "Completed memory file indexing");
    return stats;
  }

  /**
   * Search memory files using FTS5 with chunked results
   */
  search(query: string, limit = 10, context?: "work" | "life" | "general"): MemorySearchResult[] {
    try {
      // Escape special FTS5 characters
      const escapedQuery = this.escapeFtsQuery(query);

      let sql = `
        SELECT
          file_path as filePath,
          chunk_index as chunkIndex,
          snippet(memory_fts, 2, '>>>', '<<<', '...', 50) as content,
          context,
          entry_date as entryDate,
          bm25(memory_fts) as rank
        FROM memory_fts
        WHERE memory_fts MATCH ?
      `;

      const params: (string | number)[] = [escapedQuery];

      if (context) {
        sql += " AND context = ?";
        params.push(context);
      }

      sql += " ORDER BY rank LIMIT ?";
      params.push(limit);

      const results = this.db.prepare(sql).all(...params) as MemorySearchResult[];

      logger.debug({ query, resultCount: results.length, context }, "Memory search completed");
      return results;
    } catch (error) {
      logger.error({ error, query }, "Memory search failed");
      return [];
    }
  }

  /**
   * Get index statistics
   */
  getStats(): {
    totalChunks: number;
    totalFiles: number;
    fileStats: Array<{ filePath: string; context: string; chunkCount: number; indexedAt: string }>;
  } {
    const totalChunks = this.db
      .prepare("SELECT COUNT(*) as count FROM memory_fts")
      .get() as { count: number };

    const files = this.db
      .prepare(
        "SELECT file_path as filePath, context, chunk_count as chunkCount, indexed_at as indexedAt FROM memory_index_meta ORDER BY indexed_at DESC"
      )
      .all() as Array<{ filePath: string; context: string; chunkCount: number; indexedAt: string }>;

    return {
      totalChunks: totalChunks.count,
      totalFiles: files.length,
      fileStats: files,
    };
  }

  /**
   * Remove a file from the index
   */
  removeFile(filePath: string): boolean {
    try {
      this.db.prepare("DELETE FROM memory_fts WHERE file_path = ?").run(filePath);
      this.db.prepare("DELETE FROM memory_embeddings WHERE file_path = ?").run(filePath);
      this.db.prepare("DELETE FROM memory_index_meta WHERE file_path = ?").run(filePath);
      logger.info({ filePath }, "Removed file from memory index");
      return true;
    } catch (error) {
      logger.error({ error, filePath }, "Failed to remove file from index");
      return false;
    }
  }

  /**
   * Clear the entire index
   */
  clear(): void {
    this.db.exec("DELETE FROM memory_fts");
    this.db.exec("DELETE FROM memory_index_meta");
    this.db.exec("DELETE FROM memory_embeddings");
    logger.info("Cleared memory index");
  }

  /**
   * Generate embeddings for all chunks that don't have them yet
   * Call this after indexing to enable semantic search
   */
  async generateEmbeddings(): Promise<{ generated: number; skipped: number; errors: number }> {
    const stats = { generated: 0, skipped: 0, errors: 0 };

    // Get all chunks without embeddings
    const chunks = this.db.prepare(`
      SELECT f.file_path, f.chunk_index, f.content
      FROM memory_fts f
      LEFT JOIN memory_embeddings e ON f.file_path = e.file_path AND f.chunk_index = e.chunk_index
      WHERE e.file_path IS NULL
    `).all() as Array<{ file_path: string; chunk_index: number; content: string }>;

    logger.info({ totalChunks: chunks.length }, "Generating embeddings for chunks");

    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory_embeddings (file_path, chunk_index, embedding, dimensions, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const chunk of chunks) {
      try {
        const result = await generateEmbedding(chunk.content);
        const buffer = Buffer.from(result.embedding.buffer);

        insertStmt.run(
          chunk.file_path,
          chunk.chunk_index,
          buffer,
          result.dimensions,
          Date.now()
        );

        stats.generated++;

        if (stats.generated % 10 === 0) {
          logger.debug({ generated: stats.generated }, "Embedding progress");
        }
      } catch (error) {
        logger.error({ error, filePath: chunk.file_path, chunkIndex: chunk.chunk_index }, "Failed to generate embedding");
        stats.errors++;
      }
    }

    logger.info(stats, "Embedding generation complete");
    return stats;
  }

  /**
   * Hybrid search combining FTS5 keyword search with vector similarity
   * Returns ranked results using Reciprocal Rank Fusion (RRF)
   */
  async hybridSearch(
    query: string,
    limit = 10,
    context?: "work" | "life" | "general"
  ): Promise<Array<MemorySearchResult & { score: number; source: "vector" | "fts" | "both" }>> {
    try {
      // Get FTS5 results
      const ftsResults = this.search(query, limit * 2, context);

      // Generate query embedding and search vector store
      const queryEmbedding = await generateQueryEmbedding(query);

      // Get all embeddings from database
      let embeddingSql = `
        SELECT e.file_path, e.chunk_index, e.embedding, e.dimensions,
               f.content, f.context, f.entry_date
        FROM memory_embeddings e
        JOIN memory_fts f ON e.file_path = f.file_path AND e.chunk_index = f.chunk_index
      `;
      const params: string[] = [];

      if (context) {
        embeddingSql += " WHERE f.context = ?";
        params.push(context);
      }

      const embeddingRows = this.db.prepare(embeddingSql).all(...params) as Array<{
        file_path: string;
        chunk_index: number;
        embedding: Buffer;
        dimensions: number;
        content: string;
        context: string;
        entry_date: string | null;
      }>;

      // Calculate similarities and normalize to common type
      type SearchItem = { filePath: string; chunkIndex: number; content: string; context: "work" | "life" | "general"; entryDate: string | null };
      type SearchItemWithScore = SearchItem & { _similarity: number };

      const vectorResults: SearchItem[] = embeddingRows
        .map(row => {
          try {
            const embedding = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dimensions);
            const similarity = cosineSimilarity(queryEmbedding, embedding);
            return {
              filePath: row.file_path,
              chunkIndex: row.chunk_index,
              content: row.content,
              context: row.context as "work" | "life" | "general",
              entryDate: row.entry_date,
              _similarity: similarity,
            } as SearchItemWithScore;
          } catch (err) {
            logger.warn({ filePath: row.file_path, chunkIndex: row.chunk_index, error: err }, "Skipping bad embedding");
            return null;
          }
        })
        .filter((r): r is SearchItemWithScore => r !== null)
        .sort((a, b) => b._similarity - a._similarity)
        .slice(0, limit * 2)
        .map(({ _similarity: _, ...rest }) => rest);

      // Normalize FTS results to common type
      const ftsItems: SearchItem[] = ftsResults.map(r => ({
        filePath: r.filePath,
        chunkIndex: r.chunkIndex,
        content: r.content,
        context: r.context,
        entryDate: r.entryDate,
      }));

      // Merge using RRF (both arrays are already sorted by their respective scores)
      const merged = mergeRRF(vectorResults, ftsItems, 60, limit);

      // Map back to result format
      const results = merged.map(m => ({
        filePath: m.filePath,
        chunkIndex: m.chunkIndex,
        content: m.content,
        context: m.context,
        entryDate: m.entryDate,
        rank: 0,
        score: m.rrfScore,
        source: m.source,
      }));

      logger.debug({
        query,
        ftsCount: ftsResults.length,
        vectorCount: vectorResults.length,
        mergedCount: results.length,
      }, "Hybrid search completed");

      return results;
    } catch (error) {
      logger.error({ error, query }, "Hybrid search failed, falling back to FTS");
      // Fallback to FTS-only search
      return this.search(query, limit, context).map(r => ({
        ...r,
        score: Math.abs(r.rank),
        source: "fts" as const,
      }));
    }
  }

  /**
   * Get embedding statistics
   */
  getEmbeddingStats(): { totalEmbeddings: number; dimensions: number | null } {
    const count = this.db
      .prepare("SELECT COUNT(*) as count FROM memory_embeddings")
      .get() as { count: number };

    const dims = this.db
      .prepare("SELECT dimensions FROM memory_embeddings LIMIT 1")
      .get() as { dimensions: number } | undefined;

    return {
      totalEmbeddings: count.count,
      dimensions: dims?.dimensions ?? null,
    };
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }

  /**
   * Simple hash function for content comparison
   */
  private hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
  }

  /**
   * Escape special FTS5 query characters
   */
  private escapeFtsQuery(query: string): string {
    // For simple queries, just quote the terms
    // FTS5 uses double quotes for phrase matching
    const terms = query
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => {
        // Remove special characters that might break FTS5
        const cleaned = term.replace(/[*()":^$]/g, "");
        return cleaned;
      })
      .filter(Boolean);

    // Join with OR for broader matching
    return terms.join(" OR ");
  }

  /**
   * Reindex all memory files (alias for indexAllMemoryFiles)
   */
  async reindexAll(): Promise<void> {
    await this.indexAllMemoryFiles();
  }
}

// Singleton instance for the indexer
let indexerInstance: MemoryIndexer | null = null;

/**
 * Get or create the memory indexer instance
 */
export function getMemoryIndexer(dbPath?: string): MemoryIndexer {
  if (!indexerInstance) {
    const path = dbPath || "/Users/yj/homer/data/homer.db";
    indexerInstance = new MemoryIndexer(path);
  }
  return indexerInstance;
}

/**
 * Close the memory indexer (for cleanup)
 */
export function closeMemoryIndexer(): void {
  if (indexerInstance) {
    indexerInstance.close();
    indexerInstance = null;
  }
}
