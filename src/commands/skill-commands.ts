import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";
import { getRuntimePaths } from "../utils/runtime-paths.js";

export function getSkillCommands(): Array<{ name: string; category: "skill"; skill: string; description: string; aliases?: string[] }> {
  const root = join(getRuntimePaths().homeDir, ".codex", "skills", "homer");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((dir) => {
    const file = join(root, dir, "SKILL.md");
    if (!existsSync(file)) return [];
    const match = readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return [];
    const metadata = parse(match[1]!) as { name?: string; description?: string };
    if (!metadata?.name || !metadata.description) return [];
    return [{ name: `/${metadata.name}`, category: "skill" as const, skill: metadata.name,
      description: metadata.description,
      ...(metadata.name === "morning-reads" ? { aliases: ["/investment-research"] } : {}),
    }];
  });
}
