export { BrowserManager } from "./manager.js";
export { initBrowserProfilesTable, getOrCreateProfile, listProfiles, getProfile } from "./profiles.js";
export { takeScreenshot, screenshotElement } from "./screenshot.js";
export { parseAction, executeAction, executeActions } from "./actions.js";
export { waitForGoogleAuth, hasGoogleSession, isGoogleAuthPage } from "./auth.js";
export type { BrowserProfile, BrowserAction, ScreenshotResult, BrowserConfig } from "./types.js";
