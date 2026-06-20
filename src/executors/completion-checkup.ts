import { executeClaudeCommand } from "./claude.js";
import { executeOpenCodeCLI } from "./opencode-cli.js";
import { executeCodexCLI } from "./codex-cli.js";
import { executeKimiCLI } from "./kimi-cli.js";
import type { ExecutorKind } from "./fallback-orchestrator.js";

export interface CheckupResult {
  complete: boolean;
  summary?: string;
  missing?: string[];
  next_steps?: string[];
  confidence?: number;
}

function parseCheckup(output: string): CheckupResult | null {
  const fenced = output.match(/```json\n?([\s\S]*?)\n?```/);
  const jsonText = fenced?.[1] ?? output.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText);
    if (typeof parsed.complete !== "boolean") return null;
    return {
      complete: parsed.complete,
      summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
      missing: Array.isArray(parsed.missing) ? parsed.missing : undefined,
      next_steps: Array.isArray(parsed.next_steps) ? parsed.next_steps : undefined,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
    };
  } catch {
    return null;
  }
}

function truncate(text: string, max = 2000): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function buildPrompt(name: string, id: string, query: string, output: string): string {
  return `You are performing a completion check for a scheduled/queued job.\n\n` +
    `Job: ${name} (${id})\n` +
    `Task:\n${truncate(query, 1800)}\n\n` +
    `Output:\n${truncate(output, 3000)}\n\n` +
    `Determine whether the task is complete. Return JSON only:\n` +
    "```json\n" +
    "{\n" +
    '  "complete": true,\n' +
    '  "summary": "1-2 sentence verdict",\n' +
    '  "missing": ["missing item"],\n' +
    '  "next_steps": ["next step"],\n' +
    '  "confidence": 0.0\n' +
    "}\n" +
    "```\n" +
    "If complete, keep missing/next_steps empty.";
}

async function runCheckupWithExecutor(
  executor: ExecutorKind,
  prompt: string
): Promise<string | null> {
  try {
    if (executor === "gemini") {
      const res = await executeOpenCodeCLI(prompt, "", {
        timeout: 300000,
        sandbox: true,
        model: "google/gemini-3.5-flash",
        forceOpenCode: true,
      });
      return res.exitCode === 0 ? res.output : null;
    }
    if (executor === "claude") {
      const res = await executeClaudeCommand(prompt, {
        cwd: process.env.HOME ?? "/Users/yj",
        model: "sonnet",
      });
      return res.exitCode === 0 ? res.output : null;
    }
    if (executor === "codex") {
      const res = await executeCodexCLI(prompt, {
        cwd: process.env.HOME ?? "/Users/yj",
        timeout: 300000,
      });
      return res.exitCode === 0 ? res.output : null;
    }
    const res = await executeKimiCLI(prompt, "", {
      timeout: 300000,
      yolo: true,
      workDir: process.env.HOME ?? "/Users/yj",
    });
    return res.exitCode === 0 ? res.output : null;
  } catch {
    return null;
  }
}

export async function runCompletionCheckup(
  params: {
    name: string;
    id: string;
    query: string;
    output: string;
    isMemoryJob?: boolean;
  }
): Promise<CheckupResult | null> {
  const prompt = buildPrompt(params.name, params.id, params.query, params.output);
  const chain: ExecutorKind[] = params.isMemoryJob
    ? ["gemini", "claude", "codex", "kimi"]
    : ["claude", "gemini", "codex", "kimi"];

  for (const executor of chain) {
    const output = await runCheckupWithExecutor(executor, prompt);
    if (!output) continue;
    const parsed = parseCheckup(output);
    if (parsed) return parsed;
  }

  return null;
}
