import type { Page } from "playwright";
import type { ScreenshotResult } from "./types.js";

/**
 * Take a screenshot optimized for Telegram
 * Max 10MB, prefer smaller for mobile viewing
 */
export async function takeScreenshot(
  page: Page,
  fullPage: boolean = false
): Promise<ScreenshotResult> {
  const viewport = page.viewportSize();
  const width = viewport?.width ?? 1280;
  const height = viewport?.height ?? 720;

  const buffer = await page.screenshot({
    type: "png",
    fullPage,
  });

  return {
    buffer,
    width,
    height,
  };
}

/**
 * Take a screenshot of a specific element
 */
export async function screenshotElement(
  page: Page,
  selector: string
): Promise<ScreenshotResult | null> {
  const element = await page.$(selector);
  if (!element) return null;

  const box = await element.boundingBox();
  if (!box) return null;

  const buffer = await element.screenshot({ type: "png" });

  return {
    buffer,
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}
