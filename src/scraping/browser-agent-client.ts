import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserLeaseBroker, HttpBrowserTargetClient, startBrowserControlServer, stopBrowserControlServer } from "./browser-control.js";
import readline from "node:readline";
import { launchIsolatedCdp, type CDPHandle } from "./chrome-launcher.js";

type RpcResponse = { id?: number; ready?: boolean; ok?: boolean; stdout?: string; error?: string };

/** Common surface of BrokeredAgentSession and DedicatedAgentSession. */
export interface AgentBrowserSession {
  command(args: string[], timeoutMs?: number): Promise<string>;
}

/**
 * Broker-managed Chrome instances. `downloads` is the resident :9222 Chrome
 * (capacity 1, reserved for the Amazon portal collectors); `interactive` is the
 * on-demand :9224 Chrome with the persistent Google/X/Unusual Whales profile.
 */
export type BrowserInstanceId = "downloads" | "interactive";

export interface BrokeredAgentSessionOptions {
  /** Broker instance to lease from; omitted = the broker default (downloads). */
  instance?: BrowserInstanceId;
  /** Per-run broker socket (DedicatedAgentSession); omitted = the daemon broker. */
  socketPath?: string;
}

export class BrokeredAgentSession implements AgentBrowserSession {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, { resolve: (value: string) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private readonly readyPromise: Promise<void>;
  private stderrTail = "";

  constructor(surface?: string, signal?: AbortSignal, broker: BrokeredAgentSessionOptions = {}) {
    const args = ["agent", ...(surface ? [surface] : []), ...(broker.instance ? ["--instance", broker.instance] : []), "--rpc"];
    this.child = spawn("browserctl", args, { stdio: ["pipe", "pipe", "pipe"],
      ...(broker.socketPath ? { env: { ...process.env, HOMER_BROWSER_CONTROL_SOCKET: broker.socketPath } } : {}),
    });
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

  /** `keychainService` makes browserctl fill `fill <selector>` from that Keychain item. */
  async command(args: string[], timeoutMs = 120_000, keychainService?: string): Promise<string> {
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
      this.child.stdin.write(`${JSON.stringify({ id, args, timeoutMs, ...(keychainService ? { keychainService } : {}) })}\n`, (err) => {
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

export interface WithBrokeredAgentSessionOptions extends BrokeredAgentSessionOptions {
  signal?: AbortSignal;
}

/**
 * Run `operation` under one `browserctl agent` lease on the daemon broker.
 * `options.instance` selects the Chrome; callers that scrape non-Amazon sites
 * must pass "interactive" — the default (downloads) is held for hours by the
 * Amazon collectors and refuses everything else with "agent capacity 1 reached".
 */
export async function withBrokeredAgentSession<T>(
  surface: string | undefined,
  operation: (session: BrokeredAgentSession) => Promise<T>,
  options: WithBrokeredAgentSessionOptions | AbortSignal = {},
): Promise<T> {
  const { signal, ...broker } = options instanceof AbortSignal ? { signal: options } : options;
  const session = new BrokeredAgentSession(surface, signal, broker);
  try { return await operation(session); } finally { await session.close(); }
}

/** An isolated Chrome with a per-run broker; browserctl owns every browser command. */
export class DedicatedAgentSession implements AgentBrowserSession {
  private constructor(
    private readonly session: BrokeredAgentSession,
    private readonly chrome: CDPHandle,
    private readonly server: ReturnType<typeof startBrowserControlServer>,
    private readonly socketPath: string,
    private readonly directory: string,
  ) {}

  static async open(name: string, port: number, signal?: AbortSignal): Promise<DedicatedAgentSession> {
    signal?.throwIfAborted();
    const chrome = await launchIsolatedCdp(port);
    const directory = mkdtempSync(join(tmpdir(), "hbr-"));
    const socketPath = join(directory, "b.sock");
    let server: ReturnType<typeof startBrowserControlServer> | undefined;
    let session: BrokeredAgentSession | undefined;
    try {
      signal?.throwIfAborted();
      const broker = new BrowserLeaseBroker(new HttpBrowserTargetClient(port));
      server = startBrowserControlServer(broker, async () => {}, socketPath, undefined, [{
        id: "downloads", endpoint: `http://127.0.0.1:${port}`, broker,
        ready: async () => {}, status: async () => ({ state: "ready" }), changed: () => {},
      }]);
      if (!server.listening) await new Promise<void>((resolve, reject) => {
        server!.once("listening", resolve); server!.once("error", reject);
      });
      session = new BrokeredAgentSession(`agent.${name}`, signal, { instance: "downloads", socketPath });
      // Wait for lease acquisition before exposing the session to the scraper.
      await session.command(["get", "url"], 30_000);
      return new DedicatedAgentSession(session, chrome, server, socketPath, directory);
    } catch (error) {
      try { await session?.close(); } finally {
        if (server) await stopBrowserControlServer(server, socketPath);
        chrome.cleanup();
        rmSync(directory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  command(args: string[], timeoutMs = 120_000): Promise<string> {
    return this.session.command(args, timeoutMs);
  }

  async close(): Promise<void> {
    try { await this.session.close(); } finally {
      await stopBrowserControlServer(this.server, this.socketPath);
      this.chrome.cleanup();
      rmSync(this.directory, { recursive: true, force: true });
    }
  }
}

export async function withDedicatedAgentSession<T>(name: string, port: number, operation: (session: DedicatedAgentSession) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const session = await DedicatedAgentSession.open(name, port, signal);
  try { return await operation(session); } finally { await session.close(); }
}
