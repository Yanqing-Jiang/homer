import { spawn, type ChildProcess } from "child_process";
import { readFileSync, existsSync } from "fs";
import { logger } from "../utils/logger.js";
import { processRegistry } from "../process/registry.js";
import { getRuntimePaths } from "../utils/runtime-paths.js";
import {
  buildToolLabel,
  extractTextContent,
  resolveClaudeModelVariant,
  type ClaudeExecutorResult,
  type ContentBlock,
  type StreamEvent,
  type StreamStepEvent,
} from "./claude.js";

/**
 * Per-lane long-lived Claude CLI processes.
 *
 * Instead of spawning a fresh `claude --resume <id>` per user message, we keep
 * one Claude CLI process per lane and inject new user messages via stdin using
 * `--input-format stream-json`. This preserves session state in-memory (no
 * --resume context reload on each turn) and enables CLI-style mid-session
 * message injection.
 *
 * Concurrency: one turn at a time per lane. CLIRunManager serializes via its
 * per-lane chain-queue. If a caller sends a second turn while the first is
 * still streaming, the pool rejects — upstream should queue.
 */

const IDLE_TIMEOUT_MS = 20 * 60 * 1000; // kill process after 20 min idle
const TURN_TIMEOUT_MS = 30 * 60 * 1000; // per-turn wall clock
const KILL_GRACE_MS = 5_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function resolveClaudePath(): string {
  const envPath = process.env.CLAUDE_PATH;
  if (envPath) return envPath;
  return getRuntimePaths().claudeBinaryPath;
}

function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CODE_ENTRYPOINT: "homer",
    CI: process.env.CI ?? "1",
    TERM: process.env.TERM ?? "dumb",
    NO_COLOR: process.env.NO_COLOR ?? "1",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    HOME: getRuntimePaths().homeDir,
  };
  const tokenFile = getRuntimePaths().claudeTokenFile;
  if (!env.CLAUDE_CODE_OAUTH_TOKEN && existsSync(tokenFile)) {
    try {
      const token = readFileSync(tokenFile, "utf-8").trim();
      if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
    } catch {
      // ignore
    }
  }
  return env;
}

interface ActiveTurn {
  resolve: (r: ClaudeExecutorResult) => void;
  reject: (e: Error) => void;
  onPartial?: (text: string) => void;
  onEvent?: (event: StreamStepEvent) => void;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
  resultContent: string;
  startTime: number;
  timer: NodeJS.Timeout;
  // Ignore the implicit "init" event that the CLI emits at process start —
  // only the per-turn re-init events matter for turn boundaries.
  sawInitialInit: boolean;
}

interface Session {
  lane: string;
  cwd: string;
  model: string | undefined;
  proc: ChildProcess;
  startedSessionId: string | undefined;
  capturedSessionId: string | undefined;
  idleTimer: NodeJS.Timeout | null;
  activeTurn: ActiveTurn | null;
  stdoutBuffer: string;
  stderrTail: string;
  dead: boolean;
}

const sessions = new Map<string, Session>();

function emitPartial(turn: ActiveTurn): void {
  if (!turn.onPartial || !turn.resultContent) return;
  try {
    turn.onPartial(turn.resultContent);
  } catch {
    // don't let consumer errors crash the pool
  }
}

function handleTurnEvent(session: Session, line: string): void {
  if (!line.trim()) return;
  let event: StreamEvent;
  try {
    event = JSON.parse(line) as StreamEvent;
  } catch {
    return; // non-JSON noise
  }

  if ((event.type === "system" || event.type === "init") && event.session_id) {
    if (!session.startedSessionId) session.startedSessionId = event.session_id;
    session.capturedSessionId = event.session_id;
  }

  const turn = session.activeTurn;
  if (!turn) return; // event outside any turn — ignore

  if (event.type === "assistant" && event.message?.content) {
    const content = event.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text) {
          turn.resultContent += block.text;
        } else if (block.type === "tool_use" && block.name && turn.onEvent) {
          if (turn.resultContent) emitPartial(turn);
          try {
            const labels = buildToolLabel(block.name, block.input);
            turn.onEvent({
              type: "tool_use",
              id: block.id,
              tool: block.name,
              ...labels,
            });
          } catch {
            // don't crash pool
          }
        } else if (block.type === "thinking" && turn.onEvent) {
          try {
            const thinkingText = (block.thinking ?? "").trim();
            turn.onEvent({
              type: "thinking",
              label: "Thinking...",
              labelDone: "Thought",
              preview: thinkingText || undefined,
            });
          } catch {
            // don't crash pool
          }
        }
      }
    } else {
      turn.resultContent += extractTextContent(content);
    }
    emitPartial(turn);
  }

  if (event.type === "user" && turn.onEvent) {
    const content = event.message?.content ?? event.content;
    if (Array.isArray(content)) {
      for (const block of content as ContentBlock[]) {
        if (block.type === "tool_result" && block.tool_use_id) {
          try {
            const previewText = typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? extractTextContent(block.content)
                : "";
            turn.onEvent({
              type: "tool_result",
              id: block.tool_use_id,
              label: "",
              labelDone: "",
              preview: previewText?.slice(0, 220),
            });
          } catch {
            // don't crash pool
          }
        }
      }
    }
  }

  if (event.type === "result") {
    if (event.result) turn.resultContent = event.result;
    completeTurn(session, {
      output: turn.resultContent.trim() || "(No output)",
      exitCode: 0,
      duration: Date.now() - turn.startTime,
      executor: "claude",
      claudeSessionId: session.capturedSessionId ?? session.startedSessionId,
    });
  }
}

function completeTurn(session: Session, result: ClaudeExecutorResult): void {
  const turn = session.activeTurn;
  if (!turn) return;
  clearTimeout(turn.timer);
  if (turn.abortSignal && turn.abortHandler) {
    turn.abortSignal.removeEventListener("abort", turn.abortHandler);
  }
  session.activeTurn = null;
  try {
    turn.resolve(result);
  } catch (err) {
    logger.warn({ err }, "Claude pool turn resolver threw");
  }
  scheduleIdleShutdown(session);
}

function failTurn(session: Session, error: Error): void {
  const turn = session.activeTurn;
  if (!turn) return;
  clearTimeout(turn.timer);
  if (turn.abortSignal && turn.abortHandler) {
    turn.abortSignal.removeEventListener("abort", turn.abortHandler);
  }
  session.activeTurn = null;
  try {
    turn.reject(error);
  } catch (err) {
    logger.warn({ err }, "Claude pool turn rejecter threw");
  }
}

function scheduleIdleShutdown(session: Session): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    if (session.activeTurn || session.dead) return;
    logger.debug({ lane: session.lane, pid: session.proc.pid }, "Claude pool idle timeout — closing session");
    try {
      session.proc.stdin?.end();
    } catch {
      // ignore
    }
  }, IDLE_TIMEOUT_MS);
}

function cancelIdleShutdown(session: Session): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}

function markDead(session: Session, reason: string): void {
  if (session.dead) return;
  session.dead = true;
  cancelIdleShutdown(session);
  sessions.delete(session.lane);
  logger.debug({ lane: session.lane, pid: session.proc.pid, reason }, "Claude pool session ended");
  if (session.activeTurn) {
    failTurn(session, new Error(`Claude session ended: ${reason}`));
  }
}

function spawnSession(params: {
  lane: string;
  cwd: string;
  model: string | undefined;
  resumeSessionId: string | undefined;
}): Session {
  const { lane, cwd, model, resumeSessionId } = params;

  const args = [
    "--print",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
  ];
  if (model) {
    const resolved = resolveClaudeModelVariant(model);
    args.push("--model", resolved.model);
    if (resolved.effort) args.push("--effort", resolved.effort);
  }
  if (resumeSessionId) args.push("--resume", resumeSessionId);

  const claudeBin = resolveClaudePath();
  logger.debug({ lane, cwd, model, resumeSessionId }, "Spawning pooled Claude CLI session");

  const proc = spawn(claudeBin, args, {
    cwd,
    env: buildEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  // NOTE: pooled Claude sessions are long-lived and serve many runs over their lifetime.
  // We deliberately do NOT attach a static `runId` here — that would bind the registry
  // record to whichever cli_run happens to start the session, and stay wrong for every
  // subsequent turn. If per-turn run-context joins become necessary, add an explicit
  // processRegistry.updateRunContext(pid, runId) at turn start and clear at turn end.
  processRegistry.register(proc, {
    command: "claude",
    type: "executor",
    timeoutMs: 24 * 60 * 60 * 1000, // long-lived; real limit is idle timeout + per-turn timer
    source: "cli-runner",
    detached: true,
  });

  const session: Session = {
    lane,
    cwd,
    model,
    proc,
    startedSessionId: undefined,
    capturedSessionId: resumeSessionId,
    idleTimer: null,
    activeTurn: null,
    stdoutBuffer: "",
    stderrTail: "",
    dead: false,
  };

  proc.stdout?.setEncoding("utf8");
  proc.stdout?.on("data", (chunk: string) => {
    if (proc.pid) processRegistry.touch(proc.pid);
    session.stdoutBuffer += chunk;
    const lines = session.stdoutBuffer.split("\n");
    session.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) handleTurnEvent(session, line);
  });
  proc.stdout?.on("error", (error) => logger.warn({ lane, error }, "Claude pool stdout error"));

  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk: string) => {
    session.stderrTail = (session.stderrTail + chunk).slice(-MAX_OUTPUT_BYTES);
  });
  proc.stderr?.on("error", (error) => logger.warn({ lane, error }, "Claude pool stderr error"));

  proc.once("exit", (code, signal) => {
    markDead(session, `exit code=${code} signal=${signal} stderr=${session.stderrTail.slice(-500)}`);
  });
  proc.once("error", (error) => {
    markDead(session, `spawn error: ${error.message}`);
  });

  proc.stdin?.on("error", (error) => {
    logger.warn({ lane, error }, "Claude pool stdin error");
  });

  return session;
}

function killSessionGroup(session: Session, signal: NodeJS.Signals): void {
  const pid = session.proc.pid;
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      session.proc.kill(signal);
    } catch {
      // ignore
    }
  }
}

export interface PoolTurnOptions {
  cwd: string;
  model?: string;
  /** Session ID to resume on first spawn. Ignored once the pool has a live process for this lane. */
  resumeSessionId?: string;
  signal?: AbortSignal;
  timeout?: number;
  onPartial?: (text: string) => void;
  onEvent?: (event: StreamStepEvent) => void;
}

/**
 * Execute one user turn via the per-lane pooled Claude CLI process.
 * Spawns a new process if none exists for the lane; otherwise writes the
 * user message as an NDJSON line to the existing process's stdin.
 *
 * The caller must ensure no other turn is in-flight for the same lane
 * (CLIRunManager handles this via its chain-queue). If a turn is already
 * active, this rejects immediately.
 */
export function executePooledClaudeTurn(
  lane: string,
  query: string,
  options: PoolTurnOptions
): Promise<ClaudeExecutorResult> {
  return new Promise<ClaudeExecutorResult>((resolve, reject) => {
    let session = sessions.get(lane);

    // If existing session has a different cwd or model, tear it down so the
    // new turn gets the requested context.
    if (session && (session.cwd !== options.cwd || session.model !== options.model)) {
      logger.debug(
        { lane, oldCwd: session.cwd, newCwd: options.cwd, oldModel: session.model, newModel: options.model },
        "Claude pool session config changed — restarting"
      );
      try {
        session.proc.stdin?.end();
      } catch {
        // ignore
      }
      markDead(session, "config change");
      session = undefined;
    }

    if (!session) {
      session = spawnSession({
        lane,
        cwd: options.cwd,
        model: options.model,
        resumeSessionId: options.resumeSessionId,
      });
      sessions.set(lane, session);
    }

    if (session.dead) {
      reject(new Error("Claude pool session is dead"));
      return;
    }

    if (session.activeTurn) {
      reject(new Error("Claude pool session already has an active turn on this lane"));
      return;
    }

    cancelIdleShutdown(session);

    const turnTimeout = options.timeout ?? TURN_TIMEOUT_MS;
    const turn: ActiveTurn = {
      resolve,
      reject,
      onPartial: options.onPartial,
      onEvent: options.onEvent,
      abortSignal: options.signal,
      resultContent: "",
      startTime: Date.now(),
      timer: setTimeout(() => {
        logger.error({ lane, timeoutMs: turnTimeout }, "Claude pool turn timed out — killing session");
        killSessionGroup(session!, "SIGTERM");
        setTimeout(() => {
          if (session!.proc.exitCode == null && session!.proc.signalCode == null) {
            killSessionGroup(session!, "SIGKILL");
          }
        }, KILL_GRACE_MS);
        failTurn(session!, new Error(`Claude turn timed out after ${turnTimeout / 1000}s`));
      }, turnTimeout),
      sawInitialInit: false,
    };
    session.activeTurn = turn;

    if (options.signal) {
      if (options.signal.aborted) {
        logger.warn({ lane }, "Claude pool turn aborted before send");
        killSessionGroup(session, "SIGTERM");
        failTurn(session, new Error("Cancelled"));
        return;
      }
      turn.abortHandler = () => {
        logger.warn({ lane, pid: session!.proc.pid }, "Claude pool turn aborted");
        killSessionGroup(session!, "SIGTERM");
        failTurn(session!, new Error("Cancelled"));
      };
      options.signal.addEventListener("abort", turn.abortHandler, { once: true });
    }

    const payload = JSON.stringify({
      type: "user",
      message: { role: "user", content: query },
    }) + "\n";

    if (!session.proc.stdin || session.proc.stdin.destroyed) {
      failTurn(session, new Error("Claude pool stdin unavailable"));
      markDead(session, "stdin unavailable");
      return;
    }

    const writeOk = session.proc.stdin.write(payload, (err) => {
      if (err) {
        logger.warn({ lane, err }, "Claude pool stdin write failed");
        failTurn(session!, err);
        markDead(session!, `stdin write error: ${err.message}`);
      }
    });
    if (!writeOk) {
      // Backpressure. Let node drain — we don't need to wait synchronously.
      logger.debug({ lane }, "Claude pool stdin backpressure");
    }
  });
}

/**
 * Forcibly terminate a lane's pooled Claude session (used on executor switch,
 * /new, or daemon shutdown). Any in-flight turn is rejected.
 */
export function closePooledClaudeSession(lane: string, reason = "closed"): void {
  const session = sessions.get(lane);
  if (!session) return;
  logger.debug({ lane, pid: session.proc.pid, reason }, "Closing pooled Claude session");
  try {
    session.proc.stdin?.end();
  } catch {
    // ignore
  }
  killSessionGroup(session, "SIGTERM");
  markDead(session, reason);
}

/**
 * Tear down all pooled sessions (daemon shutdown).
 */
export function closeAllPooledClaudeSessions(reason = "shutdown"): number {
  let count = 0;
  for (const lane of Array.from(sessions.keys())) {
    closePooledClaudeSession(lane, reason);
    count++;
  }
  return count;
}

/** Introspection for tests/diagnostics. */
export function getPoolStats(): { lane: string; pid: number | undefined; activeTurn: boolean; sessionId: string | undefined }[] {
  return Array.from(sessions.values()).map((s) => ({
    lane: s.lane,
    pid: s.proc.pid,
    activeTurn: s.activeTurn !== null,
    sessionId: s.capturedSessionId,
  }));
}
