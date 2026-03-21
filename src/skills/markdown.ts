/**
 * Skill Markdown Parser — YAML frontmatter extraction and serialization
 */

import type { SkillFrontmatter, SkillStatus } from "./types.js";

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * Parse a skill markdown file into frontmatter + body.
 * Uses simple YAML key: value parsing (no external dependency).
 */
export function parseSkillMarkdown(content: string): { frontmatter: SkillFrontmatter; body: string } | null {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) return null;

  const yamlBlock = match[1] ?? "";
  const body = (match[2] ?? "").trim();

  const data: Record<string, string | string[]> = {};
  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Handle inline array: [tag1, tag2]
    if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
    } else {
      data[key] = value;
    }
  }

  const id = (data.id as string) || "";
  const title = (data.title as string) || "";
  const status = ((data.status as string) || "draft") as SkillStatus;
  const trigger = (data.trigger as string) || "";
  const category = (data.category as string) || "general";
  const source = ((data.source as string) || "manual") as "auto" | "manual" | "synthesized";

  if (!id || !title) return null;

  return {
    frontmatter: {
      id,
      title,
      status,
      trigger,
      category,
      source,
      tags: Array.isArray(data.tags) ? data.tags : data.tags ? [data.tags as string] : undefined,
      requires_approval: data.requires_approval === "true",
      created: (data.created as string) || new Date().toISOString().slice(0, 10),
      last_used: data.last_used as string | undefined,
    },
    body,
  };
}

/**
 * Serialize a skill back to markdown with YAML frontmatter.
 */
export function serializeSkillMarkdown(frontmatter: SkillFrontmatter, body: string): string {
  const lines: string[] = ["---"];

  lines.push(`id: ${frontmatter.id}`);
  lines.push(`title: "${frontmatter.title}"`);
  lines.push(`status: ${frontmatter.status}`);
  lines.push(`trigger: "${frontmatter.trigger}"`);
  lines.push(`category: ${frontmatter.category}`);
  lines.push(`source: ${frontmatter.source}`);

  if (frontmatter.tags && frontmatter.tags.length > 0) {
    lines.push(`tags: [${frontmatter.tags.join(", ")}]`);
  }
  if (frontmatter.requires_approval) {
    lines.push(`requires_approval: true`);
  }
  lines.push(`created: ${frontmatter.created}`);
  if (frontmatter.last_used) {
    lines.push(`last_used: ${frontmatter.last_used}`);
  }

  lines.push("---");
  lines.push("");
  lines.push(body);

  return lines.join("\n");
}
