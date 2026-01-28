import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { logger } from "../utils/logger.js";
import type { BrowserProfile, BrowserConfig, ScreenshotResult } from "./types.js";
import {
  getOrCreateProfile,
  updateProfileAuthState,
  touchProfile,
  initBrowserProfilesTable,
  listProfiles as listProfilesFromDb,
} from "./profiles.js";
import { takeScreenshot } from "./screenshot.js";
import { parseAction, executeAction } from "./actions.js";
import { waitForGoogleAuth, navigateToGoogleLogin, navigateToNotebookLM } from "./auth.js";
import type Database from "better-sqlite3";

/**
 * Browser manager for persistent sessions
 */
export class BrowserManager {
  private db: Database.Database;
  private config: BrowserConfig;
  private contexts: Map<string, BrowserContext> = new Map();
  private browser: Browser | null = null;

  constructor(db: Database.Database, config: BrowserConfig) {
    this.db = db;
    this.config = config;
    initBrowserProfilesTable(db);
  }


  /**
   * Get or create a browser context for a profile
   */
  async getContext(profileName: string, headless?: boolean): Promise<BrowserContext> {
    // Check for existing context
    const existing = this.contexts.get(profileName);
    if (existing) {
      touchProfile(this.db, profileName);
      return existing;
    }

    // Get or create profile
    const profile = await getOrCreateProfile(this.db, this.config.profilesPath, profileName);

    // Determine if we should run headless
    const useHeadless = headless ?? (profile.headlessCapable && this.config.headless);

    // Launch browser with persistent context
    const context = await chromium.launchPersistentContext(profile.profilePath, {
      headless: useHeadless,
      viewport: { width: 1280, height: 720 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    this.contexts.set(profileName, context);
    touchProfile(this.db, profileName);

    logger.info({ profile: profileName, headless: useHeadless }, "Browser context created");

    return context;
  }

  /**
   * Navigate to URL and take screenshot
   */
  async browse(
    profileName: string,
    url: string
  ): Promise<{ screenshot: ScreenshotResult; title: string }> {
    const context = await this.getContext(profileName);
    const page = context.pages()[0] || (await context.newPage());

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: this.config.defaultTimeout,
    });

    // Wait a bit for dynamic content
    await page.waitForTimeout(1000);

    const screenshot = await takeScreenshot(page);
    const title = await page.title();

    logger.info({ profile: profileName, url, title }, "Browsed URL");

    return { screenshot, title };
  }

  /**
   * Take screenshot of current page
   */
  async snap(profileName: string): Promise<{ screenshot: ScreenshotResult; url: string; title: string }> {
    const context = await this.getContext(profileName);
    const page = context.pages()[0];

    if (!page) {
      throw new Error("No active page. Use /browse first.");
    }

    const screenshot = await takeScreenshot(page);
    const url = page.url();
    const title = await page.title();

    return { screenshot, url, title };
  }

  /**
   * Execute action on current page
   */
  async act(profileName: string, actionStr: string): Promise<string> {
    const context = await this.getContext(profileName);
    const page = context.pages()[0];

    if (!page) {
      throw new Error("No active page. Use /browse first.");
    }

    const action = parseAction(actionStr);
    if (!action) {
      throw new Error(`Invalid action: ${actionStr}`);
    }

    return executeAction(page, action);
  }

  /**
   * Start headed auth flow for Google
   */
  async startAuth(profileName: string, target: "google" | "notebooklm" = "google"): Promise<string> {
    // Force headed mode for auth
    const profile = await getOrCreateProfile(this.db, this.config.profilesPath, profileName);

    // Close existing context if any (we need headed mode)
    const existing = this.contexts.get(profileName);
    if (existing) {
      await existing.close();
      this.contexts.delete(profileName);
    }

    // Launch headed context
    const context = await chromium.launchPersistentContext(profile.profilePath, {
      headless: false,
      viewport: { width: 1280, height: 720 },
    });

    this.contexts.set(profileName, context);
    updateProfileAuthState(this.db, profileName, "pending");

    const page = context.pages()[0] || (await context.newPage());

    // Navigate to auth target
    if (target === "notebooklm") {
      await navigateToNotebookLM(page);
    } else {
      await navigateToGoogleLogin(page);
    }

    logger.info({ profile: profileName, target }, "Started auth flow");

    // Wait for auth in background
    this.waitForAuthCompletion(profileName, page).catch((err) => {
      logger.error({ error: err, profile: profileName }, "Auth wait failed");
    });

    return `Auth window opened for ${profileName}. Complete login in the browser.`;
  }

  /**
   * Wait for auth completion and update profile
   */
  private async waitForAuthCompletion(profileName: string, page: Page): Promise<void> {
    const success = await waitForGoogleAuth(page);

    if (success) {
      updateProfileAuthState(this.db, profileName, "authenticated", true);
      logger.info({ profile: profileName }, "Auth completed successfully");
    } else {
      updateProfileAuthState(this.db, profileName, "none");
      logger.warn({ profile: profileName }, "Auth failed or timed out");
    }
  }

  /**
   * Close a profile's context
   */
  async closeProfile(profileName: string): Promise<void> {
    const context = this.contexts.get(profileName);
    if (context) {
      await context.close();
      this.contexts.delete(profileName);
      logger.info({ profile: profileName }, "Profile context closed");
    }
  }

  /**
   * List all browser profiles
   */
  listProfiles(): BrowserProfile[] {
    return listProfilesFromDb(this.db);
  }

  /**
   * Close all contexts and browser
   */
  async close(): Promise<void> {
    for (const [name, context] of this.contexts) {
      await context.close();
      logger.debug({ profile: name }, "Context closed");
    }
    this.contexts.clear();

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }

    logger.info("Browser manager closed");
  }
}
