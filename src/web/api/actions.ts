/**
 * Action API Routes
 *
 * Exposes /push and /push-web as API endpoints for the web UI.
 * These mirror the Claude Code slash commands but run server-side
 * as deterministic shell operations (no AI orchestration needed).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { execSync } from "child_process";
import { logger } from "../../utils/logger.js";
import { PATHS } from "../../config/paths.js";

const HOMER_DIR = PATHS.homerRoot;
const WEB_DIR = `${HOMER_DIR}/web`;

interface PushBody {
  repo?: string;
  message?: string;
}

interface ActionStep {
  name: string;
  status: "completed" | "failed" | "skipped";
  output?: string;
  error?: string;
  durationMs?: number;
}

function runStep(
  name: string,
  fn: () => string | void
): ActionStep {
  const start = Date.now();
  try {
    const output = fn();
    return {
      name,
      status: "completed",
      output: typeof output === "string" ? output.trim() : undefined,
      durationMs: Date.now() - start,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name,
      status: "failed",
      error: message,
      durationMs: Date.now() - start,
    };
  }
}

function getGitSummary(cwd: string): string {
  try {
    const stat = execSync("git diff --stat HEAD", {
      cwd,
      encoding: "utf-8",
      timeout: 10000,
    }).trim();
    // Take last line which has the summary (e.g., "3 files changed, 10 insertions(+), 5 deletions(-)")
    const lines = stat.split("\n");
    return lines[lines.length - 1] || "changes";
  } catch {
    return "changes";
  }
}

function gitPush(cwd: string): string {
  const branch = execSync("git branch --show-current", {
    cwd,
    encoding: "utf-8",
    timeout: 5000,
  }).trim();

  try {
    return execSync(`git push origin ${branch}`, {
      cwd,
      encoding: "utf-8",
      timeout: 30000,
    });
  } catch {
    // Branch might not have upstream yet
    return execSync(`git push -u origin ${branch}`, {
      cwd,
      encoding: "utf-8",
      timeout: 30000,
    });
  }
}

export function registerActionRoutes(server: FastifyInstance): void {
  /**
   * POST /api/actions/push
   *
   * Stage, commit, and push changes for a repo.
   * Default repo: ~/homer
   */
  server.post(
    "/api/actions/push",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = (request.body as PushBody) || {};
      const repo = body.repo || HOMER_DIR;
      const steps: ActionStep[] = [];

      try {
        // Check for changes
        const status = execSync("git status --porcelain", {
          cwd: repo,
          encoding: "utf-8",
          timeout: 10000,
        }).trim();

        if (!status) {
          return {
            success: true,
            message: "Nothing to commit - working tree clean",
            steps: [],
          };
        }

        const summary = getGitSummary(repo);
        const commitMsg =
          body.message || `chore: push from web UI\n\n${summary}`;

        // Stage
        steps.push(
          runStep("Stage changes", () =>
            execSync("git add -A", { cwd: repo, encoding: "utf-8", timeout: 10000 })
          )
        );
        if (steps[steps.length - 1]!.status === "failed") {
          return { success: false, steps, error: steps[steps.length - 1]!.error };
        }

        // Commit
        steps.push(
          runStep("Commit", () =>
            execSync(`git commit -m ${JSON.stringify(commitMsg)}`, {
              cwd: repo,
              encoding: "utf-8",
              timeout: 15000,
            })
          )
        );
        if (steps[steps.length - 1]!.status === "failed") {
          return { success: false, steps, error: steps[steps.length - 1]!.error };
        }

        // Push
        steps.push(runStep("Push to origin", () => gitPush(repo)));
        if (steps[steps.length - 1]!.status === "failed") {
          return { success: false, steps, error: steps[steps.length - 1]!.error };
        }

        const branch = execSync("git branch --show-current", {
          cwd: repo,
          encoding: "utf-8",
        }).trim();

        logger.info({ repo, branch, stepCount: steps.length }, "Push action completed");

        return {
          success: true,
          branch,
          steps,
          message: `Pushed to ${branch}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error, repo }, "Push action failed");
        reply.status(500);
        return { success: false, error: message, steps };
      }
    }
  );

  /**
   * POST /api/actions/push-web
   *
   * Full web deploy pipeline:
   * 1. Build web frontend (SvelteKit)
   * 2. Build backend (TypeScript)
   * 3. Commit + push (triggers Azure SWA deploy)
   * 4. Restart daemon (launchd auto-restarts with new build)
   *
   * The daemon restart kills this process, so the response is sent
   * before the restart. The frontend auto-reconnects via SSE.
   */
  server.post(
    "/api/actions/push-web",
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const homerDir = HOMER_DIR;
      const webDir = WEB_DIR;
      const steps: ActionStep[] = [];

      try {
        // Step 1: Build web frontend
        steps.push(
          runStep("Build web frontend", () =>
            execSync("npm run build", {
              cwd: webDir,
              encoding: "utf-8",
              timeout: 120000,
            })
          )
        );
        if (steps[steps.length - 1]!.status === "failed") {
          reply.status(500);
          return { success: false, steps, error: `Web build failed: ${steps[steps.length - 1]!.error}` };
        }

        // Step 2: Build backend
        steps.push(
          runStep("Build backend", () =>
            execSync("npm run build", {
              cwd: homerDir,
              encoding: "utf-8",
              timeout: 120000,
            })
          )
        );
        if (steps[steps.length - 1]!.status === "failed") {
          reply.status(500);
          return { success: false, steps, error: `Backend build failed: ${steps[steps.length - 1]!.error}` };
        }

        // Step 3: Commit + push
        const status = execSync("git status --porcelain", {
          cwd: homerDir,
          encoding: "utf-8",
          timeout: 10000,
        }).trim();

        if (status) {
          const summary = getGitSummary(homerDir);

          steps.push(
            runStep("Stage changes", () =>
              execSync("git add -A", { cwd: homerDir, encoding: "utf-8", timeout: 10000 })
            )
          );

          steps.push(
            runStep("Commit", () =>
              execSync(
                `git commit -m ${JSON.stringify(`chore: web deploy via UI\n\n${summary}`)}`,
                { cwd: homerDir, encoding: "utf-8", timeout: 15000 }
              )
            )
          );

          steps.push(runStep("Push to origin", () => gitPush(homerDir)));
        } else {
          steps.push({ name: "Commit + push", status: "skipped", output: "No changes to commit" });
        }

        // Check if any git step failed
        const gitFailed = steps.find(
          (s) => s.status === "failed" && ["Stage changes", "Commit", "Push to origin"].includes(s.name)
        );
        if (gitFailed) {
          reply.status(500);
          return { success: false, steps, error: `Git failed: ${gitFailed.error}` };
        }

        const branch = execSync("git branch --show-current", {
          cwd: homerDir,
          encoding: "utf-8",
        }).trim();

        logger.info({ branch, stepCount: steps.length }, "Push-web action completed, scheduling daemon restart");

        // Step 4: Schedule daemon restart (delayed so response can be sent)
        steps.push({ name: "Restart daemon", status: "completed", output: "Scheduled (2s delay)" });

        // Send response before killing ourselves
        const result = {
          success: true,
          branch,
          steps,
          message: `Deployed to ${branch}. Azure SWA build will follow. Daemon restarting in 2s...`,
          restarting: true,
        };

        // Schedule the restart after response is sent
        setTimeout(() => {
          logger.info("Restarting daemon via kill for push-web action");
          try {
            const pid = process.pid;
            process.kill(pid, "SIGTERM");
          } catch (err) {
            logger.error({ err }, "Failed to self-restart");
            // Fallback: hard kill via launchctl
            try {
              execSync(
                `kill -9 $(launchctl print gui/$(id -u)/com.homer.daemon 2>&1 | grep "pid = " | head -1 | awk '{print $3}')`,
                { timeout: 5000 }
              );
            } catch {
              // Last resort
              process.exit(0);
            }
          }
        }, 2000);

        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ error }, "Push-web action failed");
        reply.status(500);
        return { success: false, error: message, steps };
      }
    }
  );

  /**
   * GET /api/actions/status
   *
   * Quick check: are there uncommitted changes in the homer repo?
   */
  server.get("/api/actions/status", async () => {
    const homerDir = HOMER_DIR;
    try {
      const status = execSync("git status --porcelain", {
        cwd: homerDir,
        encoding: "utf-8",
        timeout: 10000,
      }).trim();

      const branch = execSync("git branch --show-current", {
        cwd: homerDir,
        encoding: "utf-8",
      }).trim();

      // Check if ahead of remote
      let ahead = 0;
      try {
        const aheadOutput = execSync(`git rev-list --count origin/${branch}..HEAD`, {
          cwd: homerDir,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        ahead = parseInt(aheadOutput, 10) || 0;
      } catch {
        // Remote might not exist
      }

      return {
        branch,
        hasChanges: status.length > 0,
        changedFiles: status ? status.split("\n").length : 0,
        ahead,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
}
