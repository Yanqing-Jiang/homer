import type { Page } from "playwright";
import type { BrowserAction } from "./types.js";
import { logger } from "../utils/logger.js";

/**
 * Parse action string into BrowserAction
 * Format: "click #button" | "type #input hello" | "scroll down" | "wait 2000"
 */
export function parseAction(input: string): BrowserAction | null {
  const parts = input.trim().split(/\s+/);
  const type = parts[0]?.toLowerCase();

  switch (type) {
    case "click":
      return { type: "click", selector: parts.slice(1).join(" ") };

    case "type":
      // type <selector> <value>
      const selector = parts[1];
      const value = parts.slice(2).join(" ");
      return { type: "type", selector, value };

    case "scroll":
      return { type: "scroll", value: parts[1] || "down" };

    case "wait":
      return { type: "wait", timeout: parseInt(parts[1] || "1000", 10) };

    case "navigate":
    case "goto":
    case "go":
      return { type: "navigate", value: parts.slice(1).join(" ") };

    default:
      return null;
  }
}

/**
 * Execute a browser action
 */
export async function executeAction(
  page: Page,
  action: BrowserAction
): Promise<string> {
  const timeout = action.timeout ?? 5000;

  switch (action.type) {
    case "click":
      if (!action.selector) throw new Error("Click requires selector");
      await page.click(action.selector, { timeout });
      logger.debug({ selector: action.selector }, "Clicked element");
      return `Clicked: ${action.selector}`;

    case "type":
      if (!action.selector) throw new Error("Type requires selector");
      if (!action.value) throw new Error("Type requires value");
      await page.fill(action.selector, action.value, { timeout });
      logger.debug({ selector: action.selector }, "Typed into element");
      return `Typed into: ${action.selector}`;

    case "scroll":
      const direction = action.value?.toLowerCase() || "down";
      const delta = direction === "up" ? -500 : 500;
      await page.mouse.wheel(0, delta);
      logger.debug({ direction }, "Scrolled page");
      return `Scrolled ${direction}`;

    case "wait":
      await page.waitForTimeout(timeout);
      return `Waited ${timeout}ms`;

    case "navigate":
      if (!action.value) throw new Error("Navigate requires URL");
      await page.goto(action.value, { waitUntil: "domcontentloaded", timeout: 30000 });
      logger.debug({ url: action.value }, "Navigated to URL");
      return `Navigated to: ${action.value}`;

    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }
}

/**
 * Execute multiple actions in sequence
 */
export async function executeActions(
  page: Page,
  actions: BrowserAction[]
): Promise<string[]> {
  const results: string[] = [];

  for (const action of actions) {
    const result = await executeAction(page, action);
    results.push(result);
  }

  return results;
}
