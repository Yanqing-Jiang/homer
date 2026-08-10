import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

type RpcResponse = { id?: number; ready?: boolean; ok?: boolean; stdout?: string; error?: string };

export class BrokeredAgentSession {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, { resolve: (value: string) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private readonly readyPromise: Promise<void>;

  constructor(surface?: string, signal?: AbortSignal) {
    const args = ["agent", ...(surface ? [surface] : []), "--rpc"];
    this.child = spawn("browserctl", args, { stdio: ["pipe", "pipe", "pipe"] });
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
        const error = new Error(`browserctl agent exited ${code ?? 1}`);
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
      this.pending.set(id, { resolve, reject });
      this.child.stdin!.write(`${JSON.stringify({ id, args, timeoutMs })}\n`);
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
