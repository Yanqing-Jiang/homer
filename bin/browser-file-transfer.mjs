import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ssh = "/usr/bin/ssh";
const scp = "/usr/bin/scp";

export async function stageUploadArgs(args, env) {
  // DEBT: arbitrary download destinations remain Mac-local driver paths; implement a
  // receipt-gated pull when a workflow requires `download <selector> <Mac-path>`.
  const host = env.HOMER_BROWSER_REMOTE_HOST;
  if (!host || !args.includes("upload")) return args;
  const index = args.indexOf("upload");
  if (index + 2 >= args.length) return args;
  const session = env.AGENT_BROWSER_SESSION;
  if (!/^homer-[a-f0-9]{8}$/.test(session ?? "")) throw new Error("upload requires a browserctl-owned session");
  const { stdout } = await exec(ssh, ["-o", "BatchMode=yes", host, "printf '%s' \"$HOME\""], { timeout: 10_000 });
  const directory = `${stdout.trim()}/homer-browser/uploads/${session}`;
  await exec(ssh, ["-o", "BatchMode=yes", host, "mkdir", "-p", "--", directory], { timeout: 10_000 });
  const rewritten = [...args];
  for (let i = index + 2; i < args.length && !args[i].startsWith("--"); i++) {
    const source = await realpath(args[i]);
    if (!(await stat(source)).isFile()) throw new Error("upload source must be a regular file");
    const destination = `${directory}/${randomUUID()}`;
    await exec(ssh, ["-o", "BatchMode=yes", host, "mkdir", "-p", "--", destination], { timeout: 10_000 });
    await exec(scp, ["-q", "-o", "BatchMode=yes", "--", source, `${host}:${destination}/`], { timeout: 120_000 });
    const remote = `${destination}/${basename(source)}`;
    rewritten[i] = remote;
  }
  return rewritten;
}

export async function cleanupUploads(env) {
  if (!env.HOMER_BROWSER_REMOTE_HOST || !/^homer-[a-f0-9]{8}$/.test(env.AGENT_BROWSER_SESSION ?? "")) return;
  await exec(ssh, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", env.HOMER_BROWSER_REMOTE_HOST,
    "rm", "-rf", "--", `homer-browser/uploads/${env.AGENT_BROWSER_SESSION}`], { timeout: 10_000 });
}
