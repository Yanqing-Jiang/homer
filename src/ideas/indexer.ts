import { watch } from "chokidar";
import type Database from "better-sqlite3";
import {
  parseIdeaFile,
  loadIdeasFromDir,
  getIdeasPaths,
} from "./parser.js";
import { logger } from "../utils/logger.js";

export interface IdeaIndexEntry {
  id: string;
  title: string;
  status: string;
  source: string | null;
  tags: string | null; // JSON array
  linkedThreadId: string | null;
  linkedPlanId: string | null;
  filePath: string;
  contentHash: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * Ideas Indexer - maintains SQLite index of idea files
 */
export class IdeasIndexer {
  private db: Database.Database;
  private watcher: ReturnType<typeof watch> | null = null;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Full reindex of all ideas from disk
   */
  reindex(): number {
    const ideas = loadIdeasFromDir();
    let indexed = 0;

    // Clear existing index
    this.db.prepare("DELETE FROM idea_index").run();

    // Insert all ideas
    const insert = this.db.prepare(`
      INSERT INTO idea_index (
        id, title, status, source, tags, file_path, content_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    for (const idea of ideas) {
      try {
        insert.run(
          idea.id,
          idea.title,
          idea.status,
          idea.source || null,
          idea.tags?.length ? JSON.stringify(idea.tags) : null,
          idea.filePath || "",
          idea.contentHash || null,
          idea.timestamp || null
        );
        indexed++;
      } catch (error) {
        logger.warn({ id: idea.id, error }, "Failed to index idea");
      }
    }

    logger.info({ indexed, total: ideas.length }, "Ideas reindexed");
    return indexed;
  }

  /**
   * Update a single idea in the index
   */
  updateIdea(filePath: string): void {
    const idea = parseIdeaFile(filePath);
    if (!idea) {
      // File deleted or invalid - remove from index
      this.db.prepare("DELETE FROM idea_index WHERE file_path = ?").run(filePath);
      return;
    }

    // Check if idea exists
    const existing = this.db
      .prepare("SELECT content_hash FROM idea_index WHERE id = ?")
      .get(idea.id) as { content_hash: string } | undefined;

    if (existing?.content_hash === idea.contentHash) {
      // No changes
      return;
    }

    // Upsert
    this.db
      .prepare(`
        INSERT INTO idea_index (
          id, title, status, source, tags, file_path, content_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          status = excluded.status,
          source = excluded.source,
          tags = excluded.tags,
          file_path = excluded.file_path,
          content_hash = excluded.content_hash,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(
        idea.id,
        idea.title,
        idea.status,
        idea.source || null,
        idea.tags?.length ? JSON.stringify(idea.tags) : null,
        idea.filePath || filePath,
        idea.contentHash || null,
        idea.timestamp || null
      );

    logger.debug({ id: idea.id }, "Updated idea index");
  }

  /**
   * Get all ideas from index
   */
  list(options?: { status?: string; limit?: number }): IdeaIndexEntry[] {
    let query = "SELECT * FROM idea_index WHERE 1=1";
    const params: (string | number)[] = [];

    if (options?.status) {
      query += " AND status = ?";
      params.push(options.status);
    }

    query += " ORDER BY created_at DESC";

    if (options?.limit) {
      query += " LIMIT ?";
      params.push(options.limit);
    }

    return this.db.prepare(query).all(...params) as IdeaIndexEntry[];
  }

  /**
   * Get a single idea by ID
   */
  get(id: string): IdeaIndexEntry | null {
    return this.db
      .prepare("SELECT * FROM idea_index WHERE id = ?")
      .get(id) as IdeaIndexEntry | null;
  }

  /**
   * Update idea status
   */
  updateStatus(id: string, status: string): boolean {
    const result = this.db
      .prepare("UPDATE idea_index SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(status, id);
    return result.changes > 0;
  }

  /**
   * Link idea to a thread
   */
  linkThread(id: string, threadId: string): boolean {
    const result = this.db
      .prepare("UPDATE idea_index SET linked_thread_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(threadId, id);
    return result.changes > 0;
  }

  /**
   * Link idea to a plan
   */
  linkPlan(id: string, planId: string): boolean {
    const result = this.db
      .prepare("UPDATE idea_index SET linked_plan_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(planId, id);
    return result.changes > 0;
  }

  /**
   * Remove idea from index by ID
   */
  removeIdea(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM idea_index WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  /**
   * Start watching the ideas directory for changes
   */
  startWatching(): void {
    const { directory } = getIdeasPaths();

    this.watcher = watch(directory, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    this.watcher.on("add", (path) => {
      if (path.endsWith(".md")) {
        logger.debug({ path }, "Idea file added");
        this.updateIdea(path);
      }
    });

    this.watcher.on("change", (path) => {
      if (path.endsWith(".md")) {
        logger.debug({ path }, "Idea file changed");
        this.updateIdea(path);
      }
    });

    this.watcher.on("unlink", (path) => {
      if (path.endsWith(".md")) {
        logger.debug({ path }, "Idea file deleted");
        this.db.prepare("DELETE FROM idea_index WHERE file_path = ?").run(path);
      }
    });

    logger.info({ directory }, "Started watching ideas directory");
  }

  /**
   * Stop watching
   */
  async stopWatching(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      logger.info("Stopped watching ideas directory");
    }
  }
}
