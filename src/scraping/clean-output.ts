/**
 * Shared utility for cleaning raw agent-browser output.
 * Strips tool_call markers, narration, plan headers, and step descriptions
 * that Gemini Flash sometimes includes alongside actual data.
 */

export function cleanAgentOutput(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (t.startsWith("[tool_call:") || t.startsWith("[bash:")) return false;
      if (t.startsWith("I will ") || t.startsWith("I'll ")) return false;
      if (t.startsWith("**Plan") || t.startsWith("**Explanation")) return false;
      if (t.startsWith("Step ") && t.includes("agent-browser")) return false;
      return true;
    })
    .join("\n")
    .trim();
}
