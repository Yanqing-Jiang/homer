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

export interface GmailMessageMeta {
  id: string;
  from: string;
  subject: string;
  date: string;
}

export async function searchMessages(query: string, max = 10): Promise<GmailMessageMeta[]> {
  const output = await runGmailHelper(["search", "--query", query, "--max", String(max)]);
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    logger.warn({ output: output.slice(0, 200) }, "Failed to parse gmail search output");
    return [];
  }
}

export async function getMessageBody(
  messageId: string
): Promise<{ id: string; plainText: string; html: string }> {
  const output = await runGmailHelper(["body", "--message-id", messageId]);
  return JSON.parse(output) as { id: string; plainText: string; html: string };
}

const VERIFY_URL_RE = /(https?:\/\/[^\s"'<>]+(?:verif|confirm|activ|account)[^\s"'<>]*)/i;

export async function waitForVerificationEmail(
  domain: string,
  timeoutMs = 300_000
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = 15_000;

  logger.info({ domain, timeoutMs }, "Polling for verification email");

  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
    try {
      const msgs = await searchMessages(
        `from:@${domain} subject:(verify OR confirm OR activate) newer_than:8m`,
        5
      );
      for (const msg of msgs) {
        const body = await getMessageBody(msg.id);
        const combined = body.plainText + " " + body.html;
        const match = combined.match(VERIFY_URL_RE);
        if (match) {
          logger.info({ domain, url: match[1]!.slice(0, 80) }, "Found verification URL");
          return match[1]!;
        }
      }
    } catch (err) {
      logger.warn({ err, domain }, "Error polling for verification email");
    }
  }

  logger.warn({ domain }, "Verification email poll timed out");
  return null;
}
