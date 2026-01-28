/**
 * Browser automation types
 */

export interface BrowserProfile {
  id: string;
  name: string;
  profilePath: string;
  authState: "none" | "pending" | "authenticated";
  headlessCapable: boolean;
  lastUsedAt: number;
}

export interface BrowserAction {
  type: "click" | "type" | "scroll" | "wait" | "navigate";
  selector?: string;
  value?: string;
  timeout?: number;
}

export interface ScreenshotResult {
  buffer: Buffer;
  width: number;
  height: number;
}

export interface BrowserConfig {
  profilesPath: string;
  defaultTimeout: number;
  headless: boolean;
}
