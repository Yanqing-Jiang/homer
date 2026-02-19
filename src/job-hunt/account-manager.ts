/**
 * Career site account manager — encrypted credentials, login, cookie refresh.
 */

import { createHash, randomInt } from "crypto";
import type Database from "better-sqlite3";
import { encrypt, decrypt, type EncryptedValue } from "../utils/encryption.js";
import { logger } from "../utils/logger.js";

export interface CareerAccount {
  id: string;
  company: string;
  loginUrl: string;
  username: string | null;
  authMethod: string;
  cookies: string | null;
  cookiesExpiresAt: string | null;
  mfaMethod: string;
  lastLogin: string | null;
  accountStatus: string;
}

export class AccountManager {
  constructor(private db: Database.Database) {}

  async getAccount(company: string): Promise<CareerAccount | null> {
    const row = this.db.prepare(
      "SELECT * FROM career_accounts WHERE company = ? AND account_status = 'active' LIMIT 1"
    ).get(company) as any;
    if (!row) return null;
    return {
      id: row.id,
      company: row.company,
      loginUrl: row.login_url,
      username: row.username,
      authMethod: row.auth_method,
      cookies: row.cookies,
      cookiesExpiresAt: row.cookies_expires_at,
      mfaMethod: row.mfa_method,
      lastLogin: row.last_login,
      accountStatus: row.account_status,
    };
  }

  async createAccount(
    company: string,
    loginUrl: string,
    email: string,
    password?: string
  ): Promise<CareerAccount> {
    const id = createHash("sha256").update(`${company}${loginUrl}`).digest("hex").slice(0, 12);
    const pwd = password ?? generatePassword();
    const encrypted = encrypt(pwd);

    this.db.prepare(`
      INSERT OR REPLACE INTO career_accounts
        (id, company, login_url, username, password_encrypted, encryption_key_id, auth_method, account_status)
      VALUES (?, ?, ?, ?, ?, ?, 'password', 'active')
    `).run(
      id,
      company,
      loginUrl,
      email,
      JSON.stringify(encrypted),
      encrypted.keyId
    );

    return {
      id, company, loginUrl, username: email,
      authMethod: "password", cookies: null, cookiesExpiresAt: null,
      mfaMethod: "none", lastLogin: null, accountStatus: "active",
    };
  }

  async login(account: CareerAccount): Promise<{ success: boolean; cookies?: string }> {
    // Check if cookies are still valid
    if (account.cookies && account.cookiesExpiresAt) {
      const expires = new Date(account.cookiesExpiresAt);
      if (expires > new Date()) {
        return { success: true, cookies: account.cookies };
      }
    }

    // Decrypt password
    const row = this.db.prepare(
      "SELECT password_encrypted FROM career_accounts WHERE id = ?"
    ).get(account.id) as { password_encrypted: string } | undefined;

    if (!row?.password_encrypted) {
      return { success: false };
    }

    try {
      const encrypted: EncryptedValue = JSON.parse(row.password_encrypted);
      const password = decrypt(encrypted);

      // Browser-based login via OpenCode CLI (Gemini Flash)
      const { executeOpenCodeCLI } = await import("../executors/opencode-cli.js");
      const prompt = `Use agent-browser to log into ${account.loginUrl} with email ${account.username} and password ${password}.
Connect: agent-browser connect 9222
Navigate to the login page, fill in email and password fields, click the submit/login button.
Report COOKIE_SUCCESS if login succeeds and you land on a dashboard or profile page.
Report COOKIE_FAILED if login fails (wrong credentials, CAPTCHA, etc).`;

      const result = await executeOpenCodeCLI(prompt, "", {
        model: "google/gemini-3-flash-preview",
        researchOnly: false,
        cwd: "/Users/yj/job-hunt",
        timeout: 120_000,
      });

      const success = result.output.includes("COOKIE_SUCCESS");
      if (success) {
        this.db.prepare(
          "UPDATE career_accounts SET last_login = datetime('now') WHERE id = ?"
        ).run(account.id);
        logger.info({ company: account.company }, "Browser login succeeded");
        return { success: true };
      }

      logger.warn({ company: account.company }, "Browser login failed");
      return { success: false };
    } catch (error) {
      logger.warn({ error, accountId: account.id }, "Login failed");
      return { success: false };
    }
  }

  getDecryptedPassword(accountId: string): string | null {
    const row = this.db.prepare(
      "SELECT password_encrypted FROM career_accounts WHERE id = ?"
    ).get(accountId) as { password_encrypted: string } | undefined;
    if (!row?.password_encrypted) return null;
    try {
      const encrypted: EncryptedValue = JSON.parse(row.password_encrypted);
      return decrypt(encrypted);
    } catch {
      return null;
    }
  }

  async refreshCookies(account: CareerAccount): Promise<boolean> {
    const result = await this.login(account);
    if (result.success && result.cookies) {
      this.db.prepare(`
        UPDATE career_accounts SET cookies = ?, cookies_expires_at = datetime('now', '+7 days'),
          updated_at = datetime('now') WHERE id = ?
      `).run(result.cookies, account.id);
      return true;
    }
    return false;
  }
}

function generatePassword(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%";
  return Array.from({ length: 20 }, () => chars[randomInt(chars.length)]).join("");
}
