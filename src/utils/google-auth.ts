import fs from "fs/promises";
import path from "path";
import { logger } from "./logger.js";

export interface GoogleAccount {
  email: string;
  tier?: string;
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  lastUsed?: number;
  rateLimitResetTime?: number;
  accessToken?: string;
  expiresAt?: number;
}

export interface GoogleAuthTokens {
  accessToken: string;
  expiresAt: number;
}

interface AccountsData {
  version: number;
  accounts: GoogleAccount[];
  activeIndex: number;
}

const ACCOUNTS_FILE = path.join(process.env.HOME || "", "homer/config/auth/google-accounts.json");
const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "***REMOVED_GOOGLE_OAUTH_SECRET***";

export class GoogleAccountManager {
  private accountsData: AccountsData | null = null;
  
  async load(): Promise<AccountsData> {
    if (!this.accountsData) {
      try {
        const data = await fs.readFile(ACCOUNTS_FILE, "utf-8");
        this.accountsData = JSON.parse(data) as AccountsData;
      } catch (err) {
        logger.error({ err }, "Failed to load Google accounts from %s", ACCOUNTS_FILE);
        throw new Error("Google accounts not configured");
      }
    }
    return this.accountsData;
  }

  async save(): Promise<void> {
    if (this.accountsData) {
      await fs.writeFile(ACCOUNTS_FILE, JSON.stringify(this.accountsData, null, 2), "utf-8");
    }
  }

  async refreshAccessToken(account: GoogleAccount): Promise<GoogleAuthTokens> {
    // If token is still valid for at least 5 minutes, reuse it
    if (account.accessToken && account.expiresAt && account.expiresAt > Date.now() + 5 * 60 * 1000) {
      return { accessToken: account.accessToken, expiresAt: account.expiresAt };
    }

    try {
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: account.refreshToken,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
        }),
      });

      if (!response.ok) {
        throw new Error(`Token refresh failed: ${response.status} ${await response.text()}`);
      }

      const payload = (await response.json()) as {
        access_token: string;
        expires_in: number;
      };

      account.accessToken = payload.access_token;
      account.expiresAt = Date.now() + payload.expires_in * 1000;
      
      await this.save();
      
      return { accessToken: account.accessToken, expiresAt: account.expiresAt };
    } catch (err) {
      logger.error({ err, email: account.email }, "Failed to refresh Google access token");
      throw err;
    }
  }

  async getActiveAccount(): Promise<GoogleAccount> {
    const data = await this.load();
    // Validate active index
    if (data.activeIndex < 0 || data.activeIndex >= data.accounts.length) {
      data.activeIndex = 0;
    }
    
    // Check if the current account is rate limited
    const account = data.accounts[data.activeIndex];
    if (!account) {
      throw new Error("No Google accounts configured");
    }
    
    if (account.rateLimitResetTime && account.rateLimitResetTime > Date.now()) {
      return this.rotateAccount();
    }
    
    return account;
  }

  async rotateAccount(): Promise<GoogleAccount> {
    const data = await this.load();
    if (data.accounts.length === 0) {
      throw new Error("No Google accounts configured");
    }

    const originalIndex = data.activeIndex;
    let newIndex = (originalIndex + 1) % data.accounts.length;
    
    // Find the next available account that isn't rate-limited
    while (newIndex !== originalIndex) {
      const account = data.accounts[newIndex];
      if (account && (!account.rateLimitResetTime || account.rateLimitResetTime <= Date.now())) {
        data.activeIndex = newIndex;
        await this.save();
        logger.info({ oldEmail: data.accounts[originalIndex]?.email, newEmail: account.email }, "Rotated Google account");
        return account;
      }
      newIndex = (newIndex + 1) % data.accounts.length;
    }
    
    // All accounts are rate limited! Just stick with the current one and let it fail/wait
    logger.warn("All Google accounts are currently rate-limited.");
    const fallbackAccount = data.accounts[originalIndex];
    if (!fallbackAccount) {
      throw new Error("No Google accounts configured");
    }
    return fallbackAccount;
  }

  async markRateLimited(email: string, resetDelayMs: number = 60000): Promise<void> {
    const data = await this.load();
    const account = data.accounts.find(a => a.email === email);
    if (account) {
      account.rateLimitResetTime = Date.now() + resetDelayMs;
      await this.save();
      logger.warn({ email, resetTime: new Date(account.rateLimitResetTime).toISOString() }, "Marked Google account as rate limited");
    }
  }
}

export const googleAccountManager = new GoogleAccountManager();
