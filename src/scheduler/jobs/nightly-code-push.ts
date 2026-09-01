/**
 * Auto-commit ~/homer/ code changes nightly and push to GitHub without
 * Telegram approval.
 *
 *   1. If the working tree has changes → `git add -A` + Codex-generated commit.
 *   2. If there are unpushed commits → `git push origin main` (with retries).
 *
 * The private overlay checkout (HOMER_PRIVATE_ROOT, see src/private-overlay.ts) is
 * committed the same way but never pushed: it has no remote and must not get one.
 * For the public repository, staged paths are checked against the overlay's link
 * table and a deny-list before committing, so a .gitignore regression can never
 * publish overlay files or symlinks.
 */

import { execSync, spawn } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
import type { Bot } from "grammy";
import { logger } from "../../utils/logger.js";
import type { StateManager } from "../../state/manager.js";
import { PROJECT_DIR } from "../code-push-proposal.js";
import { getPrivateOverlay } from "../../private-overlay.js";
import type { RegisteredJob } from "../types.js";
import { runInternalJobHarness } from "../executor.js";

const PUSH_RETRIES = 3;
const PUSH_RETRY_DELAY_MS = 5_000;
const MAX_DIFF_CHARS = 12_000;

interface CodePushRepo {
  name: string;
  dir: string;
  /** false = commit locally only (no remote, never pushed) */
  push: boolean;
  /** true = refuse to commit overlay/private paths (the public shell repository) */
  guardPrivatePaths: boolean;
}

function codePushRepos(): CodePushRepo[] {
  const repos: CodePushRepo[] = [
    { name: "homer", dir: PROJECT_DIR, push: true, guardPrivatePaths: true },
    { name: "homer-web", dir: process.env.HOMER_WEB_PROJECT_DIR ?? join(dirname(PROJECT_DIR), "homer-web"), push: true, guardPrivatePaths: false },
  ];
  const overlay = getPrivateOverlay();
  if (overlay) repos.push({ name: "homer-private", dir: overlay.root, push: false, guardPrivatePaths: false });
  return repos;
}

/**
 * Paths that must never be committed to the public repository: every overlay link
 * plus the structural private locations. Matched as path prefixes.
 */
function privatePathPrefixes(): string[] {
  const prefixes = new Set<string>([
    "src/private/", "tests/private/", "scripts/private/",
    "skills/skills/", "skills/commands/", "skills/agents/", "skills/dist/",
    "generated/", "run/", "tools/", "archive/",
  ]);
  for (const link of getPrivateOverlay()?.manifest.links ?? []) prefixes.add(link.link.replace(/\/+$/, ""));
  return [...prefixes];
}

/** Return the staged paths that would publish private material (empty = safe). */
export function findPrivateStagedPaths(stagedRaw: string, prefixes = privatePathPrefixes()): string[] {
  const offenders: string[] = [];
  for (const line of stagedRaw.split("\n")) {
    if (!line.trim()) continue;
    // `git diff --cached --raw` line: :<old mode> <new mode> <old sha> <new sha> <status>\t<path>
    const match = line.match(/^:(\d{6}) (\d{6}) \S+ \S+ (\S+)\t(.+)$/);
    if (!match) continue;
    const newMode = match[2] ?? "";
    const status = match[3] ?? "";
    const file = match[4] ?? "";
    if (!file || status.startsWith("D")) continue;
    if (newMode === "120000") { offenders.push(`${file} (symlink)`); continue; }
    if (prefixes.some((prefix) => file === prefix || file.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) offenders.push(file);
  }
  return offenders;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function logPrefix(repo?: CodePushRepo): string {
  return repo ? `[NightlyPush:${repo.name}]` : "[NightlyPush]";
}

/**
 * Use Codex GPT-5.4 to generate a descriptive commit message from the staged diff.
 * Falls back to a generic message if Codex is unavailable or fails.
 */
async function generateCommitMessage(
  repo: CodePushRepo,
  date: string,
  fileCount: number,
  job?: RegisteredJob,
  startedAt = new Date(),
  signal?: AbortSignal,
): Promise<string> {
  const fallback = `chore: nightly snapshot ${date} (${fileCount} files)`;
  if (!job) return fallback;

  try {
    const stat = execSync("git diff --cached --stat", {
      cwd: repo.dir,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();

    let diff = execSync("git diff --cached", {
      cwd: repo.dir,
      encoding: "utf-8",
      timeout: 15_000,
    }).trim();

    if (diff.length > MAX_DIFF_CHARS) {
      diff = diff.slice(0, MAX_DIFF_CHARS) + "\n... (truncated)";
    }

    const prompt = `You are generating a git commit message for the ${repo.name} repo's nightly snapshot.

Stat summary:
${stat}

Diff:
${diff}

Write a commit message with:
- Title line: start with "chore: nightly snapshot ${date} —" then a short (max 72 chars total) summary of the most significant change
- Blank line
- Body: 3-8 bullet points (- prefix) describing what changed and why it matters, grouped by theme

Output ONLY the commit message. No preamble, no explanation, no markdown fences.`;

    const result = await runInternalJobHarness(job, prompt, {
      stage: "push",
      startedAt,
      emitCompletedEvent: false,
      signal,
    });

    const output = result.output?.trim() ?? "";
    if (!output || output.length < 10) {
      logger.warn(`${logPrefix(repo)} Codex returned empty response, using fallback`);
      return fallback;
    }

    logger.info(`${logPrefix(repo)} Generated commit message via Codex`);
    return output;
  } catch (err: any) {
    logger.warn(`${logPrefix(repo)} Codex commit generation failed: ${err.message ?? err}, using fallback`);
    return fallback;
  }
}

async function pushWithRetries(repo: CodePushRepo, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> {
  const GH_BIN = "/opt/homebrew/bin/gh";
  let lastErr: string | undefined;
  for (let attempt = 1; attempt <= PUSH_RETRIES; attempt++) {
    if (signal?.aborted) return { ok: false, error: "aborted before push attempt" };
    try {
      let ghToken = process.env.GH_TOKEN ?? "";
      if (!ghToken) {
        ghToken = execSync(`${GH_BIN} auth token`, {
          encoding: "utf-8",
          timeout: 5_000,
        }).trim();
      }
      // spawn(detached) — not execSync, not execFile: a 900s blocking push ignored
      // the scheduler abort entirely and kept running underneath takeover. `git push`
      // spawns git-remote-https/credential-helper descendants; detached gives the
      // tree its own process group so abort/timeout kills the whole group via -pid.
      // The promise settles on 'exit', so the parent-owned stderr pipe (kept for
      // diagnostics) cannot hold it unsettled past the 30s settle grace.
      await new Promise<void>((resolve, reject) => {
        const child = spawn("git", ["push", "origin", "main"], {
          cwd: repo.dir,
          detached: true,
          stdio: ["ignore", "ignore", "pipe"],
          env: {
            ...process.env,
            GH_TOKEN: ghToken,
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "credential.helper",
            GIT_CONFIG_VALUE_0: `!${GH_BIN} auth git-credential`,
          },
        });
        let done = false;
        let timer: ReturnType<typeof setTimeout>;
        let stderrTail = "";
        child.stderr?.on("data", (d: Buffer) => {
          stderrTail = (stderrTail + d.toString()).slice(-2000);
        });
        const onAbort = () => killGroup("aborted");
        const finish = (fn: () => void) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          fn();
        };
        function killGroup(why: string): void {
          try { process.kill(-child.pid!, "SIGTERM"); } catch { /* group already gone */ }
          // Escalate if the group ignores SIGTERM; unref so this never holds the
          // daemon open. Probe (signal 0) before killing: a fully-exited group
          // no-ops here, while a SIGTERM-ignoring descendant that outlived the
          // leader still gets reaped. Leader exit must NOT cancel this timer —
          // survivors in the detached group would escape escalation.
          setTimeout(() => {
            try {
              process.kill(-child.pid!, 0);
              process.kill(-child.pid!, "SIGKILL");
            } catch { /* group already gone */ }
          }, 5_000).unref();
          finish(() => reject(new Error(`git push ${why}`)));
        }
        timer = setTimeout(() => killGroup("timed out after 900s"), 900_000);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) killGroup("aborted");
        child.on("error", (err) => finish(() => reject(err)));
        child.on("exit", (code, sig) => {
          finish(() =>
            code === 0
              ? resolve()
              : reject(new Error(
                  `git push exited code=${code} signal=${sig}${stderrTail.trim() ? `: ${stderrTail.trim()}` : ""}`,
                )));
        });
      });
      return { ok: true };
    } catch (err: any) {
      lastErr = err.message ?? String(err);
      logger.warn(`${logPrefix(repo)} Push attempt ${attempt}/${PUSH_RETRIES} failed: ${lastErr}`);
      if (signal?.aborted) return { ok: false, error: `push aborted: ${lastErr}` };
      if (attempt < PUSH_RETRIES) await sleep(PUSH_RETRY_DELAY_MS);
    }
  }
  return { ok: false, error: lastErr ?? "unknown push error" };
}

interface CodePushDeps {
  bot?: Bot;
  chatId?: number;
  stateManager?: StateManager;
  job?: RegisteredJob;
  startedAt?: Date;
  signal?: AbortSignal;
}

async function runNightlyCodePushForRepo(repo: CodePushRepo, deps: CodePushDeps): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  const prefix = logPrefix(repo);

  try {
    if (!existsSync(repo.dir)) {
      return { success: false, output: "", error: `Directory not found: ${repo.dir}` };
    }

    const status = execSync("git status --porcelain", {
      cwd: repo.dir,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();

    let commitMsg = "";
    if (status) {
      const lines = status.split("\n").filter(Boolean);
      const date = new Date().toISOString().slice(0, 10);

      logger.info({ fileCount: lines.length }, `${prefix} Staging + committing locally...`);
      execSync("git add -A", { cwd: repo.dir, timeout: 30_000 });

      if (repo.guardPrivatePaths) {
        const stagedRaw = execSync("git diff --cached --raw", { cwd: repo.dir, encoding: "utf-8", timeout: 10_000 });
        const offenders = findPrivateStagedPaths(stagedRaw);
        if (offenders.length > 0) {
          execSync("git reset -q", { cwd: repo.dir, timeout: 30_000 });
          const error = `refusing to commit private paths to the public repo: ${offenders.slice(0, 10).join(", ")}${offenders.length > 10 ? ` (+${offenders.length - 10} more)` : ""}`;
          logger.error({ offenders }, `${prefix} ${error}`);
          return { success: false, output: "", error };
        }
      }

      commitMsg = await generateCommitMessage(repo, date, lines.length, deps.job, deps.startedAt, deps.signal);

      execSync(`git commit -F -`, {
        cwd: repo.dir,
        timeout: 30_000,
        input: commitMsg,
      });
      logger.info(`${prefix} Committed locally: ${commitMsg.split("\n")[0]}`);
    }

    if (!repo.push) {
      return { success: true, output: commitMsg ? `Committed locally (no remote): ${commitMsg.split("\n")[0]}` : "No changes to commit (local-only repo)" };
    }

    const unpushedRaw = execSync("git rev-list --count origin/main..HEAD", {
      cwd: repo.dir,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
    const unpushedCount = parseInt(unpushedRaw, 10) || 0;

    if (unpushedCount === 0) {
      return { success: true, output: "No changes to commit" };
    }

    logger.info({ unpushedCount }, `${prefix} Auto-pushing ${unpushedCount} commit(s) to origin/main`);
    const pushResult = await pushWithRetries(repo, deps.signal);
    if (!pushResult.ok) {
      return { success: false, output: "", error: `Push failed: ${pushResult.error}` };
    }

    const summary = commitMsg
      ? `Pushed: ${commitMsg.split("\n")[0]} — ${unpushedCount} commit(s)`
      : `Pushed ${unpushedCount} commit(s)`;
    logger.info({ unpushedCount }, `${prefix} ${summary}`);
    return { success: true, output: summary };

  } catch (error: any) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, `${prefix} Failed`);
    return { success: false, output: "", error: msg };
  }
}

export async function runNightlyCodePush(deps: CodePushDeps = {}): Promise<{
  success: boolean;
  output: string;
  error?: string;
}> {
  const results: Array<{ repo: CodePushRepo; success: boolean; output: string; error?: string }> = [];
  for (const repo of codePushRepos()) {
    results.push({ repo, ...(await runNightlyCodePushForRepo(repo, deps)) });
  }

  const failures = results.filter((result) => !result.success);
  const output = results
    .map((result) => `${result.repo.name}: ${result.output || result.error || "no output"}`)
    .join("; ");
  if (failures.length > 0) {
    return {
      success: false,
      output,
      error: failures.map((result) => `${result.repo.name}: ${result.error ?? "unknown error"}`).join("; "),
    };
  }
  return { success: true, output };
}
