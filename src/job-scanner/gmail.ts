/**
 * Minimal Gmail API sender using the existing installed-app OAuth credentials
 * at ~/.gmail-mcp/ (shared with the gmail-mcp connector and the portfolio
 * booking backend). Plain fetch — no googleapis dependency.
 *
 * Auth account: yanqing.app@gmail.com; mail is sent AS hi@yanqing.app via the
 * verified Gmail send-as alias. If the refresh token has died (invalid_grant —
 * the OAuth client must be published to production or tokens expire in 7 days),
 * sendHtmlEmail throws GmailAuthError with the recovery command.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export class GmailAuthError extends Error {
  constructor(detail: string) {
    super(
      `Gmail OAuth refresh failed (${detail}). Re-auth with: node ~/homer/scripts/gmail-reauth.mjs ` +
        `(and publish the OAuth client to production per ~/homer/output/opus/hi-yanqing-app-email-setup-2026-08-16.md step 7, ` +
        `or the new token dies again in 7 days).`,
    );
    this.name = "GmailAuthError";
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

export async function sendHtmlEmail(
  opts: { from: string; to: string; subject: string; html: string; text?: string },
  signal?: AbortSignal,
): Promise<SendResult> {
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
