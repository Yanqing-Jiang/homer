/**
 * Workspace Manager
 *
 * Manages isolated git worktrees for parallel prototype iterations.
 * Each approach gets its own workspace to avoid conflicts.
 */

import { spawn } from "child_process";
import { mkdir, rm, readdir, stat } from "fs/promises";
import { join } from "path";
import type { ApproachLabel, Workspace, WorkspaceConfig } from "./types.js";
import { DEFAULT_OVERNIGHT_CONFIG } from "./types.js";
import { logger } from "../utils/logger.js";

// ============================================
// WORKSPACE MANAGER
// ============================================

export class WorkspaceManager {
  private baseDir: string;
  private retentionDays: number;

  constructor(baseDir?: string, retentionDays?: number) {
    this.baseDir = baseDir ?? DEFAULT_OVERNIGHT_CONFIG.workspacesDir;
    this.retentionDays = retentionDays ?? DEFAULT_OVERNIGHT_CONFIG.workspaceRetentionDays;
  }

  /**
   * Create an isolated workspace for a prototype iteration
   */
  async createWorkspace(config: WorkspaceConfig): Promise<Workspace> {
    const taskDir = join(this.baseDir, config.taskId);
    const workspacePath = join(taskDir, config.approachLabel);
    const branchName = `overnight/${config.taskId}/${config.approachLabel.toLowerCase()}`;

    // Ensure base directories exist
    await mkdir(taskDir, { recursive: true });

    // If source path is a git repo, create a worktree
    if (config.sourcePath) {
      const isGitRepo = await this.isGitRepository(config.sourcePath);

      if (isGitRepo) {
        await this.createGitWorktree(config.sourcePath, workspacePath, branchName);
      } else {
        // Just copy the directory
        await this.copyDirectory(config.sourcePath, workspacePath);
      }
    } else {
      // Create empty workspace
      await mkdir(workspacePath, { recursive: true });
      await this.initGitRepo(workspacePath, branchName);
    }

    logger.info({ taskId: config.taskId, approach: config.approachLabel, path: workspacePath }, "Created workspace");

    return {
      path: workspacePath,
      branch: branchName,
      created: true,
    };
  }

  /**
   * Get workspace path for a task/approach combination
   */
  getWorkspacePath(taskId: string, approachLabel: ApproachLabel): string {
    return join(this.baseDir, taskId, approachLabel);
  }

  /**
   * Check if workspace exists
   */
  async workspaceExists(taskId: string, approachLabel: ApproachLabel): Promise<boolean> {
    const path = this.getWorkspacePath(taskId, approachLabel);
    try {
      const stats = await stat(path);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Remove workspace after use
   */
  async removeWorkspace(taskId: string, approachLabel: ApproachLabel): Promise<void> {
    const path = this.getWorkspacePath(taskId, approachLabel);
    try {
      await rm(path, { recursive: true, force: true });
      logger.debug({ taskId, approach: approachLabel }, "Removed workspace");
    } catch (error) {
      logger.warn({ taskId, approach: approachLabel, error }, "Failed to remove workspace");
    }
  }

  /**
   * Remove all workspaces for a task
   */
  async removeTaskWorkspaces(taskId: string): Promise<void> {
    const taskDir = join(this.baseDir, taskId);
    try {
      await rm(taskDir, { recursive: true, force: true });
      logger.info({ taskId }, "Removed all task workspaces");
    } catch (error) {
      logger.warn({ taskId, error }, "Failed to remove task workspaces");
    }
  }

  /**
   * Cleanup old workspaces based on retention policy
   */
  async cleanupOldWorkspaces(): Promise<number> {
    let removed = 0;
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;

    try {
      const entries = await readdir(this.baseDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const taskDir = join(this.baseDir, entry.name);
        const stats = await stat(taskDir);

        if (stats.mtimeMs < cutoff) {
          await rm(taskDir, { recursive: true, force: true });
          removed++;
          logger.debug({ taskId: entry.name }, "Cleaned up old workspace");
        }
      }
    } catch (error) {
      logger.warn({ error }, "Error during workspace cleanup");
    }

    if (removed > 0) {
      logger.info({ removed }, "Cleaned up old workspaces");
    }

    return removed;
  }

  /**
   * Get all workspace paths for a task
   */
  async getTaskWorkspaces(taskId: string): Promise<string[]> {
    const taskDir = join(this.baseDir, taskId);
    try {
      const entries = await readdir(taskDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => join(taskDir, e.name));
    } catch {
      return [];
    }
  }

  /**
   * Collect artifacts from a workspace
   */
  async collectArtifacts(
    workspacePath: string,
    patterns: string[] = ["*.patch", "*.diff", "CHANGELOG.md", "SUMMARY.md"]
  ): Promise<string[]> {
    const artifacts: string[] = [];

    try {
      const entries = await readdir(workspacePath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile()) continue;

        const matches = patterns.some((p) => {
          if (p.startsWith("*")) {
            return entry.name.endsWith(p.slice(1));
          }
          return entry.name === p;
        });

        if (matches) {
          artifacts.push(join(workspacePath, entry.name));
        }
      }
    } catch (error) {
      logger.warn({ workspacePath, error }, "Error collecting artifacts");
    }

    return artifacts;
  }

  // ============================================
  // GIT OPERATIONS
  // ============================================

  private async isGitRepository(path: string): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn("git", ["rev-parse", "--git-dir"], {
        cwd: path,
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.on("close", (code) => {
        resolve(code === 0);
      });

      proc.on("error", () => {
        resolve(false);
      });
    });
  }

  private async createGitWorktree(
    repoPath: string,
    worktreePath: string,
    branchName: string
  ): Promise<void> {
    // First, try to create the branch (might already exist)
    await this.runGitCommand(repoPath, ["branch", branchName], true);

    // Create the worktree
    await this.runGitCommand(repoPath, [
      "worktree",
      "add",
      "-B",
      branchName,
      worktreePath,
    ]);
  }

  private async initGitRepo(path: string, branchName: string): Promise<void> {
    await this.runGitCommand(path, ["init"]);
    await this.runGitCommand(path, ["checkout", "-b", branchName]);
  }

  private async runGitCommand(
    cwd: string,
    args: string[],
    ignoreError = false
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0 || ignoreError) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Git command failed: ${stderr}`));
        }
      });

      proc.on("error", (error) => {
        if (ignoreError) {
          resolve("");
        } else {
          reject(error);
        }
      });
    });
  }

  // ============================================
  // DIRECTORY OPERATIONS
  // ============================================

  private async copyDirectory(src: string, dest: string): Promise<void> {
    await mkdir(dest, { recursive: true });

    return new Promise((resolve, reject) => {
      const proc = spawn("cp", ["-R", `${src}/.`, dest], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Failed to copy directory: ${src} to ${dest}`));
        }
      });

      proc.on("error", reject);
    });
  }

  /**
   * Create a git patch from workspace changes
   */
  async createPatch(workspacePath: string, outputPath?: string): Promise<string> {
    const patchPath = outputPath ?? join(workspacePath, "changes.patch");

    // Stage all changes
    await this.runGitCommand(workspacePath, ["add", "-A"], true);

    // Create patch
    const patch = await this.runGitCommand(workspacePath, [
      "diff",
      "--cached",
      "--no-color",
    ]);

    // Write to file if there are changes
    if (patch.trim()) {
      const { writeFile } = await import("fs/promises");
      await writeFile(patchPath, patch);
    }

    return patchPath;
  }

  /**
   * Get stats about changes in workspace
   */
  async getChangeStats(workspacePath: string): Promise<{
    filesChanged: number;
    insertions: number;
    deletions: number;
  }> {
    try {
      await this.runGitCommand(workspacePath, ["add", "-A"], true);
      const output = await this.runGitCommand(workspacePath, [
        "diff",
        "--cached",
        "--shortstat",
      ]);

      // Parse "X files changed, Y insertions(+), Z deletions(-)"
      const match = output.match(
        /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/
      );

      if (match && match[1]) {
        return {
          filesChanged: parseInt(match[1], 10) || 0,
          insertions: parseInt(match[2] ?? "0", 10) || 0,
          deletions: parseInt(match[3] ?? "0", 10) || 0,
        };
      }
    } catch {
      // Ignore errors
    }

    return { filesChanged: 0, insertions: 0, deletions: 0 };
  }
}

// ============================================
// SINGLETON INSTANCE
// ============================================

let workspaceManager: WorkspaceManager | null = null;

export function getWorkspaceManager(): WorkspaceManager {
  if (!workspaceManager) {
    workspaceManager = new WorkspaceManager();
  }
  return workspaceManager;
}
