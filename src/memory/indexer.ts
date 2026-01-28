import Database from "better-sqlite3";
import { readFile } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { logger } from "../utils/logger.js";

/**
 * Memory index search result
 */
export interface MemorySearchResult {
  filePath: string;
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
    // Create FTS5 virtual table for memory search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        file_path,
        content,
        context,
        entry_date,
        tokenize='porter unicode61'
      );

      -- Metadata table to track indexed files
      CREATE TABLE IF NOT EXISTS memory_index_meta (
        file_path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        context TEXT NOT NULL
      );
    `);

    logger.debug("Memory indexer initialized");
  }

  /**
   * Index a single memory file
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

      // Remove old entries for this file
      this.db
        .prepare("DELETE FROM memory_fts WHERE file_path = ?")
        .run(filePath);

      // Insert new content
      this.db
        .prepare(
          "INSERT INTO memory_fts (file_path, content, context, entry_date) VALUES (?, ?, ?, ?)"
        )
        .run(filePath, content, context, entryDate || null);

      // Update metadata
      this.db
        .prepare(
          `INSERT INTO memory_index_meta (file_path, content_hash, indexed_at, context)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(file_path) DO UPDATE SET
             content_hash = excluded.content_hash,
             indexed_at = excluded.indexed_at,
             context = excluded.context`
        )
        .run(filePath, contentHash, new Date().toISOString(), context);

      logger.info({ filePath, context, contentLength: content.length }, "Indexed memory file");
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

    // Global memory files
    const globalFiles = [
      "/Users/yj/memory/user.md",
      "/Users/yj/memory/facts.md",
      "/Users/yj/memory/preferences.md",
    ];

    for (const file of globalFiles) {
      try {
        const indexed = await this.indexFile(file, "general");
        if (indexed) stats.indexed++;
        else stats.skipped++;
      } catch {
        stats.errors++;
      }
    }

    // Context memory files
    const contextFiles: Array<{ path: string; context: "work" | "life" }> = [
      { path: "/Users/yj/work/memory.md", context: "work" },
      { path: "/Users/yj/life/memory.md", context: "life" },
    ];

    for (const { path, context } of contextFiles) {
      try {
        const indexed = await this.indexFile(path, context);
        if (indexed) stats.indexed++;
        else stats.skipped++;
      } catch {
        stats.errors++;
      }
    }

    // Daily log files
    const dailyLogsDir = "/Users/yj/memory";
    if (existsSync(dailyLogsDir)) {
      const files = readdirSync(dailyLogsDir);
      const datePattern = /^\d{4}-\d{2}-\d{2}\.md$/;

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

    logger.info(stats, "Completed memory file indexing");
    return stats;
  }

  /**
   * Search memory files using FTS5
   */
  search(query: string, limit = 10, context?: "work" | "life" | "general"): MemorySearchResult[] {
    try {
      // Escape special FTS5 characters
      const escapedQuery = this.escapeFtsQuery(query);

      let sql = `
        SELECT
          file_path as filePath,
          snippet(memory_fts, 1, '>>>', '<<<', '...', 50) as content,
          context,
          entry_date as entryDate,
          rank
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
    totalDocuments: number;
    fileStats: Array<{ filePath: string; context: string; indexedAt: string }>;
  } {
    const total = this.db
      .prepare("SELECT COUNT(*) as count FROM memory_fts")
      .get() as { count: number };

    const files = this.db
      .prepare(
        "SELECT file_path as filePath, context, indexed_at as indexedAt FROM memory_index_meta ORDER BY indexed_at DESC"
      )
      .all() as Array<{ filePath: string; context: string; indexedAt: string }>;

    return {
      totalDocuments: total.count,
      fileStats: files,
    };
  }

  /**
   * Remove a file from the index
   */
  removeFile(filePath: string): boolean {
    try {
      this.db.prepare("DELETE FROM memory_fts WHERE file_path = ?").run(filePath);
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
    logger.info("Cleared memory index");
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
