import type { BrowserContext, Page } from "playwright";
import { logger } from "../utils/logger.js";

/**
 * Google OAuth domains to detect
 */
const GOOGLE_AUTH_DOMAINS = [
  "accounts.google.com",
  "accounts.google.co",
  "myaccount.google.com",
];

/**
 * Check if current page is a Google auth page
 */
export function isGoogleAuthPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return GOOGLE_AUTH_DOMAINS.some((domain) => parsed.hostname.includes(domain));
  } catch {
    return false;
  }
}

/**
 * Wait for user to complete Google auth
 * Returns true if auth appears complete
 */
export async function waitForGoogleAuth(
  page: Page,
  timeoutMs: number = 120000
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const url = page.url();

    // If we're no longer on Google auth pages, auth may be complete
    if (!isGoogleAuthPage(url)) {
      logger.info({ url }, "Left Google auth page");
      return true;
    }

    // Wait a bit before checking again
    await page.waitForTimeout(1000);
  }

  logger.warn("Google auth timeout");
  return false;
}

/**
 * Check if context has Google cookies (indicates prior auth)
 */
export async function hasGoogleSession(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies(["https://google.com", "https://accounts.google.com"]);

  // Look for session cookies
  const sessionCookies = cookies.filter(
    (c: { name: string }) => c.name.includes("SID") || c.name.includes("SAPISID")
  );

  return sessionCookies.length > 0;
}

/**
 * Navigate to Google login page
 */
export async function navigateToGoogleLogin(page: Page): Promise<void> {
  await page.goto("https://accounts.google.com/signin", {
    waitUntil: "domcontentloaded",
  });
}

/**
 * Navigate to NotebookLM (will trigger Google auth if needed)
 */
export async function navigateToNotebookLM(page: Page): Promise<void> {
  await page.goto("https://notebooklm.google.com/", {
    waitUntil: "domcontentloaded",
  });
}
