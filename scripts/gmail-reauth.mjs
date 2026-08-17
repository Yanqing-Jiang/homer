#!/usr/bin/env node
/**
 * One-command Gmail OAuth re-auth for the yanqing.app@gmail.com sender.
 *
 * Reuses the installed-app client in ~/.gmail-mcp/gcp-oauth.keys.json,
 * opens the consent URL in the default browser, catches the redirect on
 * localhost, and rewrites ~/.gmail-mcp/credentials.json in the same shape
 * the gmail-mcp connector and the portfolio booking backend expect.
 *
 * IMPORTANT: sign in as yanqing.app@gmail.com in the consent screen.
 * If the OAuth client is still in "Testing" publishing status, the new
 * refresh token dies in 7 days — publish it to production first
 * (Google Cloud Console → APIs & Services → OAuth consent screen → Publish).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";

const KEYS_PATH = join(homedir(), ".gmail-mcp", "gcp-oauth.keys.json");
const CREDS_PATH = join(homedir(), ".gmail-mcp", "credentials.json");
const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/oauth2callback`;
// gmail.modify covers read + send + labels for both the MCP connector and the digest sender.
const SCOPES = "https://www.googleapis.com/auth/gmail.modify";

const keys = JSON.parse(readFileSync(KEYS_PATH, "utf-8")).installed;

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: keys.client_id,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    login_hint: "yanqing.app@gmail.com",
  }).toString();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/oauth2callback") { res.writeHead(404).end(); return; }
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end(`OAuth error: ${url.searchParams.get("error") ?? "no code"}`);
    return;
  }
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: keys.client_id,
        client_secret: keys.client_secret,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT,
      }),
    });
    const tok = await tokenRes.json();
    if (!tokenRes.ok || !tok.refresh_token) {
      throw new Error(JSON.stringify(tok).slice(0, 300));
    }
    writeFileSync(CREDS_PATH, JSON.stringify({
      access_token: tok.access_token,
      expires_in: tok.expires_in,
      refresh_token: tok.refresh_token,
      scope: tok.scope,
      token_type: tok.token_type,
    }, null, 2), { mode: 0o600 });
    res.writeHead(200, { "Content-Type": "text/plain" }).end("Gmail re-auth complete. You can close this tab.");
    console.log(`✓ New refresh token written to ${CREDS_PATH}`);
    console.log("Reminder: if the OAuth client is still in Testing status, this token expires in 7 days.");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end(`Token exchange failed: ${err.message}`);
    console.error("Token exchange failed:", err.message);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log("Opening Google consent screen (sign in as yanqing.app@gmail.com)...");
  console.log(`If the browser does not open, visit:\n${authUrl}`);
  execFile("open", [authUrl]);
});
