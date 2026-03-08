/**
 * CanonicalMemoryService — single entry point for all memory writes.
 *
 * Thin facade over StateManager + MemoryIndexer. Every write method
 * marks the appropriate pipelines dirty and emits to the MemoryEventBus
 * so the Scheduler can debounce reactive triggers.
 */

import { appendFile, writeFile } from "fs/promises";
import { watch, type FSWatcher } from "fs";
import { basename } from "path";
import { PATHS } from "../config/paths.js";
import { logger } from "../utils/logger.js";
import { memoryEvents } from "../events/memory-events.js";
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

    // Index the file immediately
    const context = file === "work" ? "work" : file === "life" ? "life" : "general";
    await this.indexer.indexFile(filePath, context as "work" | "life" | "general");

    // Mark all derived pipelines dirty
    for (const pipeline of ALL_WRITE_PIPELINES) {
      this.markDirty(pipeline, `promote:${source}`);
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
