import Database from "better-sqlite3";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { logger } from "../utils/logger.js";
import { chunkText } from "../search/chunker.js";
import { generateEmbedding, generateQueryEmbedding, cosineSimilarity, mergeRRF } from "./embeddings.js";
import { PATHS } from "../config/paths.js";

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
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

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

    // Skip archived/backup files
    if (filePath.includes(`${PATHS.backups}/`) || filePath.includes("/backups/")) {
      logger.debug({ filePath }, "Skipping archived file");
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
  async indexAllMemoryFiles(): Promise<{ indexed: number; skipped: number; errors: number; transcriptsIndexed?: number }> {
    const stats = { indexed: 0, skipped: 0, errors: 0 };

    // Core memory files (identity, preferences, tools)
    const coreFiles: Array<{ path: string; context: "work" | "life" | "general" }> = [
      { path: PATHS.me, context: "general" },
      { path: PATHS.work, context: "work" },
      { path: PATHS.life, context: "life" },
      { path: PATHS.preferences, context: "general" },
      { path: PATHS.tools, context: "general" },
      { path: PATHS.patterns, context: "general" },
      { path: PATHS.denyHistory, context: "general" },
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

    // Daily log files — index last 7 days for recency, purge older entries
    const dailyDir = PATHS.daily;
    if (existsSync(dailyDir)) {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const cutoffDate = sevenDaysAgo.toISOString().slice(0, 10);

      // Purge daily logs older than 7 days from FTS
      try {
        const dailyFiles = readdirSync(dailyDir).filter(f => f.endsWith(".md"));
        const oldFiles = dailyFiles
          .filter(f => f.slice(0, 10) < cutoffDate)
          .map(f => `${dailyDir}/${f}`);

        for (const oldPath of oldFiles) {
          this.db.prepare("DELETE FROM memory_fts WHERE file_path = ?").run(oldPath);
          this.db.prepare("DELETE FROM memory_index_meta WHERE file_path = ?").run(oldPath);
          this.db.prepare("DELETE FROM memory_embeddings WHERE file_path = ?").run(oldPath);
        }

        // Index recent daily logs (last 7 days)
        const recentFiles = dailyFiles
          .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f) && f.slice(0, 10) >= cutoffDate)
          .sort()
          .reverse(); // Most recent first

        for (const file of recentFiles) {
          const entryDate = file.slice(0, 10);
          const filePath = `${dailyDir}/${file}`;
          try {
            const indexed = await this.indexFile(filePath, "general", entryDate);
            if (indexed) stats.indexed++;
            else stats.skipped++;
          } catch {
            stats.errors++;
          }
        }
      } catch (err) {
        logger.warn({ error: err }, "Failed to index daily log files");
      }
    }

    // Meeting transcripts
    const meetingsDir = PATHS.meetings;
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

    // Skills directory — recursive scan of ~/memory/skills/
    const skillsDir = PATHS.skills;
    if (existsSync(skillsDir)) {
      const collectSkillFiles = (dir: string): string[] => {
        const results: string[] = [];
        try {
          const entries = readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
              results.push(...collectSkillFiles(fullPath));
            } else if (entry.name.endsWith(".md")) {
              results.push(fullPath);
            }
          }
        } catch {
          // directory read error
        }
        return results;
      };

      const skillFiles = collectSkillFiles(skillsDir);
      for (const filePath of skillFiles) {
        try {
          const indexed = await this.indexFile(filePath, "general");
          if (indexed) stats.indexed++;
          else stats.skipped++;
        } catch {
          stats.errors++;
        }
      }
    }

    // YouTube transcripts — ~/memory/youtube/*.md
    const youtubeDir = PATHS.youtubeMemory;
    if (existsSync(youtubeDir)) {
      try {
        const files = readdirSync(youtubeDir).filter(f => f.endsWith(".md"));
        for (const file of files) {
          const filePath = `${youtubeDir}/${file}`;
          try {
            const indexed = await this.indexFile(filePath, "general");
            if (indexed) stats.indexed++;
            else stats.skipped++;
          } catch {
            stats.errors++;
          }
        }
      } catch (err) {
        logger.warn({ error: err }, "Failed to index YouTube transcript files");
      }
    }

    // Index session transcripts for verbatim search (migration 075)
    const transcriptStats = await this.indexTranscripts();
    stats.indexed += transcriptStats.indexed;
    stats.skipped += transcriptStats.skipped;
    stats.errors += transcriptStats.errors;

    logger.info({ ...stats, transcriptsIndexed: transcriptStats.indexed }, "Completed memory file indexing");
    return { ...stats, transcriptsIndexed: transcriptStats.indexed };
  }

  /**
   * Index session transcripts for verbatim search.
   * Parses messages_json, extracts conversational text (user/assistant only),
   * chunks it, and inserts into transcript_fts. Incremental — skips already-indexed.
   */
  async indexTranscripts(): Promise<{ indexed: number; skipped: number; errors: number }> {
    const stats = { indexed: 0, skipped: 0, errors: 0 };

    try {
      // Check if tables exist (migration 075 may not have run yet)
      const hasTable = this.db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='transcript_index_meta'"
      ).get();
      if (!hasTable) {
        logger.debug("transcript_index_meta table not found, skipping transcript indexing");
        return stats;
      }

      // Get unindexed transcripts
      const unindexed = this.db.prepare(`
        SELECT st.content_hash, st.agent, st.project, st.started_at, st.messages_json
        FROM session_transcripts st
        LEFT JOIN transcript_index_meta tim ON st.content_hash = tim.content_hash
        WHERE tim.content_hash IS NULL
      `).all() as Array<{
        content_hash: string;
        agent: string;
        project: string | null;
        started_at: string | null;
        messages_json: string;
      }>;

      if (unindexed.length === 0) return stats;

      logger.info({ count: unindexed.length }, "Indexing unindexed session transcripts");

      const insertFts = this.db.prepare(
        `INSERT INTO transcript_fts (content, content_hash, chunk_index, agent, project, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const insertMeta = this.db.prepare(
        `INSERT OR IGNORE INTO transcript_index_meta (content_hash, chunk_count, indexed_at)
         VALUES (?, ?, ?)`
      );

      for (const row of unindexed) {
        try {
          const text = this.extractConversationalText(row.messages_json);
          if (!text || text.length < 50) {
            // Record in meta to avoid re-processing empty/tiny transcripts
            insertMeta.run(row.content_hash, 0, new Date().toISOString());
            stats.skipped++;
            continue;
          }

          const chunks = chunkText(text, 512, 50);

          const insertMany = this.db.transaction(() => {
            for (const chunk of chunks) {
              insertFts.run(
                chunk.content,
                row.content_hash,
                chunk.chunkIndex,
                row.agent,
                row.project ?? null,
                row.started_at ?? null,
              );
            }
            insertMeta.run(row.content_hash, chunks.length, new Date().toISOString());
          });
          insertMany();

          stats.indexed++;
        } catch (err) {
          logger.error({ error: err, contentHash: row.content_hash }, "Failed to index transcript");
          stats.errors++;
        }
      }

      logger.info(stats, "Transcript indexing complete");
    } catch (err) {
      logger.debug({ error: err }, "Transcript indexing skipped (tables may not exist)");
    }

    return stats;
  }

  /**
   * Extract searchable conversational text from messages_json.
   * Keeps only user/assistant turns, skips system messages and tiny replies.
   */
  private extractConversationalText(messagesJson: string): string {
    try {
      const messages = JSON.parse(messagesJson) as Array<{ role: string; content: string | unknown }>;
      const parts: string[] = [];
      for (const msg of messages) {
        if (msg.role !== "user" && msg.role !== "assistant") continue;
        const content = typeof msg.content === "string" ? msg.content : "";
        if (content.length < 10) continue;
        parts.push(`[${msg.role}] ${content}`);
      }
      return parts.join("\n\n");
    } catch {
      return "";
    }
  }

  /**
   * Search memory files using FTS5 with chunked results
   */
  search(query: string, limit = 10, context?: "work" | "life" | "general"): MemorySearchResult[] {
    try {
      // Escape special FTS5 characters
      const escapedQuery = this.escapeFtsQuery(query);
      if (!escapedQuery) return []; // Guard: empty query would crash FTS5 MATCH

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

    // Get all memory chunks without embeddings
    const chunks = this.db.prepare(`
      SELECT f.file_path, f.chunk_index, f.content
      FROM memory_fts f
      LEFT JOIN memory_embeddings e ON f.file_path = e.file_path AND f.chunk_index = e.chunk_index
      WHERE e.file_path IS NULL
    `).all() as Array<{ file_path: string; chunk_index: number; content: string }>;

    // Also get session summaries not yet embedded (using session:{id} as file_path key)
    let sessionChunks: Array<{ file_path: string; chunk_index: number; content: string }> = [];
    try {
      sessionChunks = this.db.prepare(`
        SELECT 'session:' || s.id as file_path, 0 as chunk_index,
               COALESCE(s.title, '') || ' — ' || COALESCE(s.summary, '') as content
        FROM session_summaries s
        LEFT JOIN memory_embeddings e ON e.file_path = 'session:' || s.id AND e.chunk_index = 0
        WHERE e.file_path IS NULL
          AND s.summary IS NOT NULL AND s.summary != ''
      `).all() as typeof sessionChunks;
    } catch (err) {
      logger.debug({ error: err }, "session_summaries table may not exist yet");
    }

    const allChunks = [...chunks, ...sessionChunks];
    logger.info({ memoryChunks: chunks.length, sessionChunks: sessionChunks.length }, "Generating embeddings for chunks");

    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory_embeddings (file_path, chunk_index, embedding, dimensions, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const chunk of allChunks) {
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

      // Get memory file embeddings from database
      let embeddingSql = `
        SELECT e.file_path, e.chunk_index, e.embedding, e.dimensions,
               f.content, f.context, f.entry_date
        FROM memory_embeddings e
        JOIN memory_fts f ON e.file_path = f.file_path AND e.chunk_index = f.chunk_index
        WHERE e.file_path NOT LIKE 'session:%'
      `;
      const params: string[] = [];

      if (context) {
        embeddingSql += " AND f.context = ?";
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

      // Also get session summary embeddings (active only — exclude archived)
      let sessionEmbeddingRows: typeof embeddingRows = [];
      try {
        sessionEmbeddingRows = this.db.prepare(`
          SELECT e.file_path, e.chunk_index, e.embedding, e.dimensions,
                 COALESCE(s.title, '') || ' — ' || COALESCE(s.summary, '') as content,
                 'general' as context, s.started_at as entry_date
          FROM memory_embeddings e
          JOIN session_summaries s ON e.file_path = 'session:' || s.id
          WHERE e.file_path LIKE 'session:%'
            AND s.status = 'active'
        `).all() as typeof embeddingRows;
      } catch {
        // session_summaries table may not exist
      }

      const allEmbeddingRows = [...embeddingRows, ...sessionEmbeddingRows];

      // Calculate similarities and normalize to common type
      type SearchItem = { filePath: string; chunkIndex: number; content: string; context: "work" | "life" | "general"; entryDate: string | null };
      type SearchItemWithScore = SearchItem & { _similarity: number };

      const SIMILARITY_FLOOR = 0.40; // Filter garbage vector matches

      const vectorResults: SearchItem[] = allEmbeddingRows
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
        .filter((r): r is SearchItemWithScore => r !== null && r._similarity >= SIMILARITY_FLOOR)
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
      const merged = mergeRRF(vectorResults, ftsItems, 20, limit);

      // Map back to result format + deduplicate by content snippet
      const seen = new Set<string>();
      const results = merged
        .map(m => ({
          filePath: m.filePath,
          chunkIndex: m.chunkIndex,
          content: m.content,
          context: m.context,
          entryDate: m.entryDate,
          rank: 0,
          score: m.rrfScore,
          source: m.source,
        }))
        .filter(r => {
          // Deduplicate results that share the same content across memory_fts and session_summaries
          const snippet = r.content.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 120);
          if (seen.has(snippet)) return false;
          seen.add(snippet);
          return true;
        });

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
   * SHA256 hash for content comparison (collision-resistant)
   */
  private hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  /**
   * Escape special FTS5 query characters.
   * Space-separated terms use implicit AND (FTS5 default).
   * Quoted phrases are preserved for exact matching.
   */
  private escapeFtsQuery(query: string): string {
    // Preserve quoted phrases, clean individual terms
    const tokens: string[] = [];
    const phraseRegex = /"([^"]+)"/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = phraseRegex.exec(query)) !== null) {
      // Process unquoted text before this phrase
      const before = query.slice(lastIndex, match.index);
      for (const term of before.split(/\s+/).filter(Boolean)) {
        const cleaned = term.replace(/[*()\^$]/g, "");
        if (cleaned) tokens.push(cleaned);
      }
      // Keep the quoted phrase intact
      const phraseContent = (match[1] ?? "").replace(/[*()\^$]/g, "");
      if (phraseContent.trim()) tokens.push(`"${phraseContent}"`);
      lastIndex = match.index + match[0].length;
    }

    // Process remaining unquoted text
    const remaining = query.slice(lastIndex);
    for (const term of remaining.split(/\s+/).filter(Boolean)) {
      const cleaned = term.replace(/[*()\^$":]/g, "");
      if (cleaned) tokens.push(cleaned);
    }

    // Space = implicit AND in FTS5 (default behavior)
    return tokens.join(" ");
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
    const path = dbPath || PATHS.db;
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
