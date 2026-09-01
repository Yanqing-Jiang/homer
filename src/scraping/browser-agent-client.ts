import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { launchIsolatedCdp, type CDPHandle } from "./chrome-launcher.js";

type RpcResponse = { id?: number; ready?: boolean; ok?: boolean; stdout?: string; error?: string };

const AGENT_BROWSER = process.env.HOMER_AGENT_BROWSER_BIN ?? "/opt/homebrew/bin/agent-browser";

/** Common surface of BrokeredAgentSession and DedicatedAgentSession. */
export interface AgentBrowserSession {
  command(args: string[], timeoutMs?: number): Promise<string>;
}

export class BrokeredAgentSession implements AgentBrowserSession {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, { resolve: (value: string) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private readonly readyPromise: Promise<void>;
  private stderrTail = "";

  constructor(surface?: string, signal?: AbortSignal) {
    const args = ["agent", ...(surface ? [surface] : []), "--rpc"];
    this.child = spawn("browserctl", args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr!.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-500);
    });
    this.readyPromise = new Promise((resolve, reject) => {
      const lines = readline.createInterface({ input: this.child.stdout!, crlfDelay: Infinity });
      lines.on("line", (line) => {
        const response = JSON.parse(line) as RpcResponse;
        if (response.ready) { resolve(); return; }
        if (response.id === undefined) return;
        const pending = this.pending.get(response.id);
        if (!pending) return;
        this.pending.delete(response.id);
        if (response.ok) pending.resolve(response.stdout ?? ""); else pending.reject(new Error(response.error ?? "agent-browser RPC failed"));
      });
      this.child.once("error", reject);
      this.child.once("exit", (code) => {
        const detail = this.stderrTail.trim();
        const error = new Error(`browserctl agent exited ${code ?? 1}${detail ? `: ${detail}` : ""}`);
        reject(error);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
      });
    });
    if (signal) {
      const abort = () => this.child.kill("SIGTERM");
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    }
  }

  async command(args: string[], timeoutMs = 120_000): Promise<string> {
    await this.readyPromise;
    const id = this.nextId++;
    return await new Promise<string>((resolve, reject) => {
      // Long-held sessions can outlive a crashed browserctl child; writing to its
      // closed stdin without a callback would emit an unhandled stream error.
      if (this.child.exitCode !== null || !this.child.stdin?.writable) {
        reject(new Error("browserctl agent session is closed"));
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, args, timeoutMs })}\n`, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async close(): Promise<void> {
    this.child.stdin?.end();
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null) resolve(); else this.child.once("exit", () => resolve());
    });
  }
}

export async function withBrokeredAgentSession<T>(surface: string | undefined, operation: (session: BrokeredAgentSession) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const session = new BrokeredAgentSession(surface, signal);
  try { return await operation(session); } finally { await session.close(); }
}

/**
 * Agent-browser session bound to a DEDICATED Chrome on its own CDP port — a
 * separate pid, profile, and tab from the shared :9222 browser. It never takes
 * (or waits on) the broker's globally serialized agent lease, so a long-running
 * shared-browser collector cannot block it. agent-browser's 0.21.4 concurrent
 * rebinding only bites sessions attached to the SAME browser; a separate
 * endpoint is safe to run alongside the shared one.
 */
export class DedicatedAgentSession implements AgentBrowserSession {
  private constructor(
    private readonly session: string,
    private readonly chrome: CDPHandle,
    private readonly signal?: AbortSignal,
  ) {}

  static async open(name: string, port: number, signal?: AbortSignal): Promise<DedicatedAgentSession> {
    const chrome = await launchIsolatedCdp(port);
    // Short suffix: session names become socket paths (103-byte cap).
    const session = new DedicatedAgentSession(`homer-${name}-ded-${randomUUID().slice(0, 8)}`, chrome, signal);
    try {
      await session.command(["connect", String(port)], 30_000);
    } catch (err) {
      chrome.cleanup();
      throw err;
    }
    return session;
  }

  command(args: string[], timeoutMs = 120_000): Promise<string> {
    return this.exec(args, timeoutMs, this.signal);
  }

  private exec(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        AGENT_BROWSER,
        ["--session", this.session, ...args],
        { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs, signal },
        (error, stdout, stderr) => {
          if (error) reject(new Error(`${error.message}${stderr ? `: ${stderr.slice(0, 400)}` : ""}`));
          else resolve(stdout);
        },
      );
    });
  }

  /** Close ignores the abort signal so teardown still runs after an abort. */
  async close(): Promise<void> {
    await this.exec(["close"], 10_000).catch(() => undefined);
    this.chrome.cleanup();
  }
}

export async function withDedicatedAgentSession<T>(name: string, port: number, operation: (session: DedicatedAgentSession) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const session = await DedicatedAgentSession.open(name, port, signal);
  try { return await operation(session); } finally { await session.close(); }
}
