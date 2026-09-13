/**
 * Run the bounded Antigravity edit specialist against one prompt file.
 *
 * Usage:
 *   tsx src/scripts/gemini-specialist.ts --cwd <directory> --prompt-file <file> [--timeout-ms <ms>]
 *
 * Specialist runs always receive at least 15 minutes; a larger --timeout-ms is preserved.
 */

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { executeGeminiSpecialist } from "../executors/gemini-cli.js";

interface SpecialistCliArgs {
  cwd: string;
  promptFile: string;
  timeout?: number;
}

function usage(): never {
  throw new Error("Usage: gemini-specialist --cwd <directory> --prompt-file <file> [--timeout-ms <ms>]");
}

function parseArgs(argv: string[]): SpecialistCliArgs {
  let cwd: string | undefined;
  let promptFile: string | undefined;
  let timeout: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--cwd" && value) {
      cwd = value;
      index += 1;
    } else if (arg === "--prompt-file" && value) {
      promptFile = value;
      index += 1;
    } else if (arg === "--timeout-ms" && value) {
      timeout = Number(value);
      index += 1;
    } else {
      usage();
    }
  }

  if (!cwd || !promptFile || (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout <= 0))) {
    usage();
  }
  if (!statSync(cwd).isDirectory()) throw new Error(`--cwd is not a directory: ${cwd}`);
  if (!statSync(promptFile).isFile()) throw new Error(`--prompt-file is not a file: ${promptFile}`);
  return { cwd, promptFile, timeout };
}

export async function runGeminiSpecialistCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const prompt = readFileSync(args.promptFile, "utf8");
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const result = await executeGeminiSpecialist(prompt, {
      cwd: args.cwd,
      timeout: args.timeout,
      signal: controller.signal,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.exitCode === 0 ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runGeminiSpecialistCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
