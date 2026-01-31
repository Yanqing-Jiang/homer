import { watch } from "chokidar";
import type Database from "better-sqlite3";
import { parsePlanFile, loadPlansFromDir, getPlansPath } from "./parser.js";
import { logger } from "../utils/logger.js";

export interface PlanIndexEntry {
  id: string;
  title: string;
  status: string;
  currentPhase: string | null;
  progress: number;
  totalTasks: number;
  completedTasks: number;
  filePath: string;
  contentHash: string | null;
  sourceIdeaId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * Plans Indexer - maintains SQLite index of plan files
 */
export class PlansIndexer {
  private db: Database.Database;
  private watcher: ReturnType<typeof watch> | null = null;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Full reindex of all plans from disk
   */
  reindex(): number {
    const plans = loadPlansFromDir();
    let indexed = 0;

    // Clear existing index
    this.db.prepare("DELETE FROM plan_index").run();

    // Insert all plans
    const insert = this.db.prepare(`
      INSERT INTO plan_index (
        id, title, status, current_phase, progress, total_tasks, completed_tasks,
        file_path, content_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    for (const plan of plans) {
      try {
        insert.run(
          plan.id,
          plan.title,
          plan.status,
          plan.currentPhase,
          plan.progress,
          plan.totalTasks,
          plan.completedTasks,
          plan.filePath,
          plan.contentHash,
          plan.createdAt
        );
        indexed++;
      } catch (error) {
        logger.warn({ id: plan.id, error }, "Failed to index plan");
      }
    }

    logger.info({ indexed, total: plans.length }, "Plans reindexed");
    return indexed;
  }

  /**
   * Update a single plan in the index
   */
  updatePlan(filePath: string): void {
    const plan = parsePlanFile(filePath);
    if (!plan) {
      // File deleted or invalid - remove from index
      this.db.prepare("DELETE FROM plan_index WHERE file_path = ?").run(filePath);
      return;
    }

    // Check if plan exists
    const existing = this.db
      .prepare("SELECT content_hash FROM plan_index WHERE id = ?")
      .get(plan.id) as { content_hash: string } | undefined;

    if (existing?.content_hash === plan.contentHash) {
      // No changes
      return;
    }

    // Upsert
    this.db
      .prepare(`
        INSERT INTO plan_index (
          id, title, status, current_phase, progress, total_tasks, completed_tasks,
          file_path, content_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          status = excluded.status,
          current_phase = excluded.current_phase,
          progress = excluded.progress,
          total_tasks = excluded.total_tasks,
          completed_tasks = excluded.completed_tasks,
          file_path = excluded.file_path,
          content_hash = excluded.content_hash,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(
        plan.id,
        plan.title,
        plan.status,
        plan.currentPhase,
        plan.progress,
        plan.totalTasks,
        plan.completedTasks,
        plan.filePath,
        plan.contentHash,
        plan.createdAt
      );

    logger.debug({ id: plan.id, progress: plan.progress }, "Updated plan index");
  }

  /**
   * Get all plans from index
   */
  list(options?: { status?: string; limit?: number }): PlanIndexEntry[] {
    let query = "SELECT * FROM plan_index WHERE 1=1";
    const params: (string | number)[] = [];

    if (options?.status) {
      query += " AND status = ?";
      params.push(options.status);
    }

    query += " ORDER BY CASE status WHEN 'execution' THEN 0 WHEN 'planning' THEN 1 ELSE 2 END, updated_at DESC";

    if (options?.limit) {
      query += " LIMIT ?";
      params.push(options.limit);
    }

    return this.db.prepare(query).all(...params) as PlanIndexEntry[];
  }

  /**
   * Get a single plan by ID
   */
  get(id: string): PlanIndexEntry | null {
    return this.db
      .prepare("SELECT * FROM plan_index WHERE id = ?")
      .get(id) as PlanIndexEntry | null;
  }

  /**
   * Update plan status
   */
  updateStatus(id: string, status: string): boolean {
    const result = this.db
      .prepare("UPDATE plan_index SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(status, id);
    return result.changes > 0;
  }

  /**
   * Link plan to a source idea
   */
  linkSourceIdea(id: string, ideaId: string): boolean {
    const result = this.db
      .prepare("UPDATE plan_index SET source_idea_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(ideaId, id);
    return result.changes > 0;
  }

  /**
   * Start watching the plans directory for changes
   */
  startWatching(): void {
    const plansDir = getPlansPath();

    this.watcher = watch(plansDir, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    this.watcher.on("add", (path) => {
      if (path.endsWith(".md")) {
        logger.debug({ path }, "Plan file added");
        this.updatePlan(path);
      }
    });

    this.watcher.on("change", (path) => {
      if (path.endsWith(".md")) {
        logger.debug({ path }, "Plan file changed");
        this.updatePlan(path);
      }
    });

    this.watcher.on("unlink", (path) => {
      if (path.endsWith(".md")) {
        logger.debug({ path }, "Plan file deleted");
        this.db.prepare("DELETE FROM plan_index WHERE file_path = ?").run(path);
      }
    });

    logger.info({ plansDir }, "Started watching plans directory");
  }

  /**
   * Stop watching
   */
  async stopWatching(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      logger.info("Stopped watching plans directory");
    }
  }
}
