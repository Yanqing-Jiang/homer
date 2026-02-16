import { spawn } from "child_process";
import { logger } from "../utils/logger.js";

const GMAIL_HELPER = "/Users/yj/job-hunt/gmail/gmail_helper.py";
const PYTHON = "/Users/yj/job-hunt/gmail/.venv/bin/python3";

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  category: "interview-invite" | "rejection" | "recruiter-reply" | "other";
}

export interface GmailThread {
  threadId: string;
  messageCount: number;
  messages: Omit<GmailMessage, "category">[];
}

export interface SendResult {
  status: string;
  id: string;
  threadId: string;
}

function runGmailHelper(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [GMAIL_HELPER, ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        VIRTUAL_ENV: "/Users/yj/job-hunt/gmail/.venv",
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? "",
        TELEGRAM_CHAT_ID: process.env.ALLOWED_CHAT_ID ?? "",
      },
      timeout: 30_000,
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on("data", (d) => chunks.push(d));
    proc.stderr.on("data", (d) => errChunks.push(d));
    proc.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf8");
      const stderr = Buffer.concat(errChunks).toString("utf8");
      if (code !== 0) {
        reject(new Error(`gmail_helper exited ${code}: ${stderr || stdout}`));
      } else {
        resolve(stdout);
      }
    });
    proc.on("error", reject);
  });
}

export async function checkInbox(sinceMinutes = 30): Promise<GmailMessage[]> {
  const output = await runGmailHelper(["check", "--since-minutes", String(sinceMinutes)]);
  try {
    const parsed = JSON.parse(output);
    if (parsed.status === "no_new_messages") return [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    logger.warn({ output: output.slice(0, 200) }, "Failed to parse gmail check output");
    return [];
  }
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  threadId?: string
): Promise<SendResult> {
  const args = ["send", "--to", to, "--subject", subject, "--body", body];
  if (threadId) args.push("--thread-id", threadId);
  const output = await runGmailHelper(args);
  return JSON.parse(output) as SendResult;
}

export async function getThread(threadId: string): Promise<GmailThread> {
  const output = await runGmailHelper(["thread", "--thread-id", threadId]);
  return JSON.parse(output) as GmailThread;
}
