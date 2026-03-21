/**
 * CanonicalMemoryService — single entry point for all memory writes.
 *
 * Thin facade over StateManager + MemoryIndexer. Every write method
 * marks the appropriate pipelines dirty and emits to the MemoryEventBus
 * so the Scheduler can debounce reactive triggers.
 */

import { appendFile, writeFile, mkdir } from "fs/promises";
import { createHash } from "crypto";
import { watch, type FSWatcher } from "fs";
import { basename } from "path";
import { PATHS } from "../config/paths.js";
import { logger } from "../utils/logger.js";
import { memoryEvents } from "../events/memory-events.js";
import { serializeSkillMarkdown } from "../skills/markdown.js";
import type { SkillFrontmatter, SkillStatus } from "../skills/types.js";
import type { StateManager } from "../state/manager.js";
import type { MemoryIndexer } from "./indexer.js";

const ALL_WRITE_PIPELINES = ["reindex", "embeddings", "context_bridge", "git_commit"] as const;

export class CanonicalMemoryService {
  private sm: StateManager;
  private indexer: MemoryIndexer;
  private recentSelfWrites = new Map<string, number>(); // filename -> expiry timestamp
  private _watcher: FSWatcher | null = null;
  private selfWriteTTL = 2000; // 2 seconds

  constructor(sm: StateManager, indexer: MemoryIndexer) {
    this.sm = sm;
    this.indexer = indexer;
  }

  // ── Dirty-flag pass-through ─────────────────────────────────

  markDirty(pipeline: string, source: string): void {
    this.sm.markPipelineDirty(pipeline, source);
    memoryEvents.emitDirty(pipeline, source);
  }

  isDirty(pipeline: string): boolean {
    return this.sm.isPipelineDirty(pipeline);
  }

  clearDirty(pipeline: string): void {
    this.sm.clearPipelineDirty(pipeline);
  }

  // ── Write operations ───────────────────────────────────────

  /**
   * Promote content to a permanent memory file.
   * Replaces inline appendFile + recordPromotedFact + markContextBridgeDirty + indexFile.
   */
  async promoteToFile(
    content: string,
    file: string,
    section: string | null,
    source: string,
  ): Promise<boolean> {
    // CAS dedup
    if (this.sm.checkFactExists(content, file)) {
      logger.debug({ file, content: content.slice(0, 60) }, "Skipping duplicate promoted fact");
      return false;
    }

    const filePath = `${PATHS.memory}/${file}.md`;
    let toAppend = "\n";
    if (section) toAppend += `## ${section}\n`;
    toAppend += `${content}\n`;

    await appendFile(filePath, toAppend, "utf-8");
    this.trackSelfWrite(`${file}.md`);

    const validSources = new Set(["mcp", "nightly", "weekly", "unknown"]);
    const factSource = (validSources.has(source) ? source : "unknown") as "mcp" | "nightly" | "weekly" | "unknown";
    this.sm.recordPromotedFact(content, file, section, factSource);

    // Mark all derived pipelines dirty BEFORE indexing — ensures flags are set even if indexing fails
    for (const pipeline of ALL_WRITE_PIPELINES) {
      this.markDirty(pipeline, `promote:${source}`);
    }

    // Index the file immediately (best-effort — dirty flags already set for retry)
    const context = file === "work" ? "work" : file === "life" ? "life" : "general";
    try {
      await this.indexer.indexFile(filePath, context as "work" | "life" | "general");
    } catch (err) {
      logger.warn({ err, filePath }, "Inline indexing failed after promote — reindex will pick it up");
    }

    logger.info({ file, section, source, content: content.slice(0, 80) }, "Promoted fact via CanonicalMemoryService");
    return true;
  }

  /**
   * Write a cleaned/modified memory file.
   * Replaces inline writeFile in memory-cleanup.ts.
   */
  async writeCleanedFile(path: string, content: string, source: string): Promise<void> {
    await writeFile(path, content, "utf-8");
    this.trackSelfWrite(basename(path));

    for (const pipeline of ALL_WRITE_PIPELINES) {
      this.markDirty(pipeline, `write:${source}`);
    }

    logger.info({ path, source }, "Wrote cleaned file via CanonicalMemoryService");
  }

  /**
   * Insert a session event into session_summaries.
   * Replaces inline insertDaemonEvent calls.
   */
  insertSessionEvent(title: string, content: string, context?: string): void {
    this.sm.insertDaemonEvent(title, content, context || "general");
    this.markDirty("embeddings", "session_event");
  }

  // ── Skill operations ──────────────────────────────────────

  /**
   * Create or update a skill in the catalog and write its markdown file.
   */
  async upsertSkill(frontmatter: SkillFrontmatter, body: string): Promise<void> {
    const filePath = `${PATHS.skills}/${frontmatter.id}.md`;
    const content = serializeSkillMarkdown(frontmatter, body);
    const contentHash = createHash("sha256").update(content).digest("hex");

    // Ensure skills directory exists
    await mkdir(PATHS.skills, { recursive: true });

    // Write the file
    await writeFile(filePath, content, "utf-8");
    this.trackSelfWrite(`${frontmatter.id}.md`);

    // Upsert into skills_catalog
    try {
      this.sm.getDb().prepare(`
        INSERT INTO skills_catalog (id, title, status, trigger_pattern, category, source, content_hash, file_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          status = excluded.status,
          trigger_pattern = excluded.trigger_pattern,
          category = excluded.category,
          source = excluded.source,
          content_hash = excluded.content_hash,
          file_path = excluded.file_path
      `).run(
        frontmatter.id, frontmatter.title, frontmatter.status,
        frontmatter.trigger, frontmatter.category, frontmatter.source,
        contentHash, filePath,
      );
    } catch (err) {
      logger.warn({ err, skillId: frontmatter.id }, "Failed to upsert skill catalog entry (table may not exist)");
    }

    // Index for FTS search
    try {
      await this.indexer.indexFile(filePath, "general");
    } catch (err) {
      logger.warn({ err, filePath }, "Failed to index skill file");
    }

    this.markDirty("reindex", `skill:${frontmatter.id}`);
    this.markDirty("embeddings", `skill:${frontmatter.id}`);
    logger.info({ skillId: frontmatter.id, status: frontmatter.status }, "Upserted skill");
  }

  /**
   * Archive a skill (soft-delete, restorable on match).
   */
  archiveSkill(skillId: string): boolean {
    try {
      const result = this.sm.getDb().prepare(`
        UPDATE skills_catalog
        SET status = 'archived', archived_at = datetime('now')
        WHERE id = ? AND status != 'archived'
      `).run(skillId);
      if (result.changes > 0) {
        logger.info({ skillId }, "Archived skill");
        return true;
      }
      return false;
    } catch (err) {
      logger.warn({ err, skillId }, "Failed to archive skill");
      return false;
    }
  }

  /**
   * Record a skill usage (success or failure).
   */
  recordSkillUsage(skillId: string, success: boolean): void {
    try {
      const col = success ? "success_count" : "failure_count";
      this.sm.getDb().prepare(`
        UPDATE skills_catalog
        SET ${col} = ${col} + 1, last_used_at = datetime('now')
        WHERE id = ?
      `).run(skillId);
    } catch (err) {
      logger.debug({ err, skillId }, "Failed to record skill usage");
    }
  }

  /**
   * Get active skills for session injection.
   */
  getActiveSkills(limit = 50): Array<{ id: string; title: string; trigger_pattern: string; category: string; success_count: number; failure_count: number }> {
    try {
      return this.sm.getDb().prepare(`
        SELECT id, title, trigger_pattern, category, success_count, failure_count
        FROM skills_catalog
        WHERE status = 'active'
        ORDER BY last_used_at DESC NULLS LAST
        LIMIT ?
      `).all(limit) as Array<{ id: string; title: string; trigger_pattern: string; category: string; success_count: number; failure_count: number }>;
    } catch {
      return [];
    }
  }

  /**
   * Promote a skill from draft/observation to active if it meets thresholds.
   */
  promoteSkillIfReady(skillId: string): SkillStatus | null {
    try {
      const row = this.sm.getDb().prepare(`
        SELECT status, success_count, failure_count, requires_approval
        FROM skills_catalog WHERE id = ?
      `).get(skillId) as { status: string; success_count: number; failure_count: number; requires_approval?: number } | undefined;

      if (!row || row.status === "active" || row.status === "archived") return null;

      const total = row.success_count + row.failure_count;
      const rate = total > 0 ? row.success_count / total : 0;

      if (row.success_count >= 3 && rate >= 0.60) {
        const newStatus: SkillStatus = "active";
        this.sm.getDb().prepare(`
          UPDATE skills_catalog SET status = ?, last_promoted_at = datetime('now') WHERE id = ?
        `).run(newStatus, skillId);
        logger.info({ skillId, successCount: row.success_count, rate }, "Promoted skill to active");
        return newStatus;
      }

      // Auto-promote from draft to observation after first use
      if (row.status === "draft" && total > 0) {
        this.sm.getDb().prepare(`
          UPDATE skills_catalog SET status = 'observation' WHERE id = ?
        `).run(skillId);
        return "observation";
      }

      return null;
    } catch {
      return null;
    }
  }

  // ── File change detection ──────────────────────────────────

  /**
   * Start watching ~/memory/ for external file changes.
   * Call from daemon entry point only (not MCP — MCP is short-lived stdio).
   */
  startFileWatcher(): void {
    if (this._watcher) return;

    try {
      this._watcher = watch(PATHS.memory, (_event, filename) => {
        if (!filename?.endsWith(".md")) return;

        // Check self-write tracking
        if (this.isRecentSelfWrite(filename)) return;

        logger.info({ filename }, "External file change detected");
        for (const pipeline of ALL_WRITE_PIPELINES) {
          this.markDirty(pipeline, `fs_watch:${filename}`);
        }
      });

      logger.info("File watcher started for ~/memory/");
    } catch (err) {
      logger.warn({ error: err }, "Failed to start file watcher");
    }
  }

  stopFileWatcher(): void {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
  }

  // ── Self-write tracking ────────────────────────────────────

  private trackSelfWrite(filename: string): void {
    this.recentSelfWrites.set(filename, Date.now() + this.selfWriteTTL);
  }

  private isRecentSelfWrite(filename: string): boolean {
    const expiry = this.recentSelfWrites.get(filename);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      this.recentSelfWrites.delete(filename);
      return false;
    }
    return true;
  }
}

// ── Singleton ──────────────────────────────────────────────

let instance: CanonicalMemoryService | null = null;

export function getCanonicalMemoryService(
  sm: StateManager,
  indexer: MemoryIndexer,
): CanonicalMemoryService {
  if (!instance) {
    instance = new CanonicalMemoryService(sm, indexer);
  }
  return instance;
}
