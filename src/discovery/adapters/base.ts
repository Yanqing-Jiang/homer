/**
 * Base Source Adapter
 *
 * Abstract base class for all discovery source adapters.
 */

import { createHash } from "crypto";
import type { SourceType, SourceConfig, RawDiscoveryItem, SourceAdapter } from "../types.js";

export abstract class BaseAdapter implements SourceAdapter {
  abstract readonly type: SourceType;
  abstract readonly name: string;

  abstract isAvailable(): Promise<boolean>;
  abstract fetch(config: SourceConfig): Promise<RawDiscoveryItem[]>;

  /**
   * Generate a unique ID for a discovery item
   */
  protected generateId(url: string, source: SourceType): string {
    const hash = createHash("sha256")
      .update(`${source}:${url}`)
      .digest("hex")
      .slice(0, 12);
    return `${source.slice(0, 4)}_${hash}`;
  }

  /**
   * Clean and normalize text
   */
  protected cleanText(text: string): string {
    return text
      .replace(/\s+/g, " ")
      .replace(/[\r\n]+/g, " ")
      .trim();
  }

  /**
   * Parse a date string safely
   */
  protected parseDate(dateStr: string | undefined): Date | undefined {
    if (!dateStr) return undefined;
    try {
      return new Date(dateStr);
    } catch {
      return undefined;
    }
  }
}
