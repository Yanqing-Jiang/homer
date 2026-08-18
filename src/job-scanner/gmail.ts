/**
 * Digest email sender. Preferred transport: Gmail SMTP (smtp.gmail.com:465)
 * with an app password on yanqing.app@gmail.com — read from the login keychain
 * item `homer-gmail-smtp` or $HOMER_GMAIL_APP_PASSWORD. App passwords never
 * expire, so the scheduled sender has no OAuth-token deadline.
 *
 * Fallback (until the app password exists): the installed-app OAuth
 * credentials at ~/.gmail-mcp/ shared with the gmail-mcp connector. That
 * client is in Testing status, so its refresh tokens die every 7 days —
 * the reason SMTP is preferred.
 *
 * Auth account: yanqing.app@gmail.com; mail is sent AS hi@yanqing.app via the
 * verified Gmail send-as alias (honored on both transports).
 *
 * To enable SMTP: create an app password at myaccount.google.com/apppasswords
 * (requires 2FA on yanqing.app@gmail.com), then:
 *   security add-generic-password -a yanqing.app@gmail.com -s homer-gmail-smtp -w '<app password>'
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import nodemailer from "nodemailer";

export class GmailAuthError extends Error {
  constructor(detail: string) {
    super(
      `Gmail auth failed (${detail}). Durable fix: add an app password as keychain item ` +
        `homer-gmail-smtp (see src/job-scanner/gmail.ts header). OAuth stopgap: ` +
        `node ~/homer/scripts/gmail-reauth.mjs (token dies again in 7 days while the client stays in Testing).`,
    );
    this.name = "GmailAuthError";
  }
}

const SMTP_USER = process.env.JOB_SCANNER_SMTP_USER ?? "yanqing.app@gmail.com";
const SMTP_KEYCHAIN_SERVICE = "homer-gmail-smtp";

function getSmtpAppPassword(): string | null {
  const env = process.env.HOMER_GMAIL_APP_PASSWORD;
  if (env && env.trim().length > 0) return env.trim();
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", SMTP_KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

const CREDS_PATH = join(homedir(), ".gmail-mcp", "credentials.json");
const KEYS_PATH = join(homedir(), ".gmail-mcp", "gcp-oauth.keys.json");

async function getAccessToken(signal?: AbortSignal): Promise<string> {
  const creds = JSON.parse(readFileSync(CREDS_PATH, "utf-8")) as { refresh_token?: string };
  const keys = (JSON.parse(readFileSync(KEYS_PATH, "utf-8")) as {
    installed: { client_id: string; client_secret: string };
  }).installed;
  if (!creds.refresh_token) throw new GmailAuthError("no refresh_token in credentials.json");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: keys.client_id,
      client_secret: keys.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    }),
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) throw new GmailAuthError(body.error ?? `HTTP ${res.status}`);
  return body.access_token;
}

function base64url(input: string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 2047 encode a header value if it contains non-ASCII characters. */
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
}

export interface SendResult {
  messageId: string;
}

interface SendOpts {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
}

async function sendViaSmtp(password: string, opts: SendOpts): Promise<SendResult> {
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: SMTP_USER, pass: password },
    connectionTimeout: 20_000,
    socketTimeout: 30_000,
  });
  try {
    const info = await transporter.sendMail({
      from: `HOMER Job Scanner <${opts.from}>`,
      to: opts.to,
      subject: opts.subject,
      text: opts.text ?? "This digest is HTML-only; open in an HTML-capable mail client.",
      html: opts.html,
    });
    return { messageId: info.messageId };
  } catch (error) {
    if ((error as { code?: string }).code === "EAUTH") {
      throw new GmailAuthError(
        "SMTP app password rejected — regenerate at myaccount.google.com/apppasswords and update keychain item homer-gmail-smtp",
      );
    }
    throw error;
  } finally {
    transporter.close();
  }
}

export async function sendHtmlEmail(opts: SendOpts, signal?: AbortSignal): Promise<SendResult> {
  const appPassword = getSmtpAppPassword();
  if (appPassword) return sendViaSmtp(appPassword, opts);

  // OAuth fallback until the app password is provisioned.
  const token = await getAccessToken(signal);
  const boundary = `homer-${Date.now().toString(36)}`;
  const text = opts.text ?? "This digest is HTML-only; open in an HTML-capable mail client.";
  const mime = [
    `From: HOMER Job Scanner <${opts.from}>`,
    `To: ${opts.to}`,
    `Subject: ${encodeHeader(opts.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    text,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "",
    opts.html,
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: base64url(mime) }),
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as { id?: string; error?: { message?: string } };
  if (!res.ok || !body.id) {
    throw new Error(`Gmail send failed: ${body.error?.message ?? `HTTP ${res.status}`}`);
  }
  return { messageId: body.id };
}
