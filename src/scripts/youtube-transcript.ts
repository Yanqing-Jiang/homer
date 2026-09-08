/** On-demand transcript intake for the conversation's active agent. No LLM or queue. */
import { existsSync } from "node:fs";
import { config } from "dotenv";
import Database from "better-sqlite3";
import { PATHS } from "../config/paths.js";
import { extractVideoId } from "../youtube/utils.js";
import { extractTranscript, getLocalTranscript } from "../youtube/transcript.js";
import { logger } from "../utils/logger.js";

async function main(): Promise<void> {
  logger.level = "silent";
  const input = process.argv[2];
  const url = input ? new URL(input) : null;
  const allowedHosts = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"];
  const videoId = url && allowedHosts.includes(url.hostname) && /^(https?:)$/.test(url.protocol)
    ? extractVideoId(url.href) : null;
  if (!videoId) throw new Error("Usage: youtube-transcript <YouTube video URL>");

  config({ path: `${PATHS.homerRoot}/.env` });
  const db = existsSync(PATHS.db) ? new Database(PATHS.db, { readonly: true }) : undefined;
  let transcript;
  try {
    transcript = getLocalTranscript(videoId, db);
  } finally {
    db?.close();
  }
  transcript ??= await extractTranscript(videoId);
  if (!transcript) throw new Error(`Transcript unavailable for ${videoId}; no analysis was generated.`);

  process.stdout.write(`${JSON.stringify({
    videoId, url: `https://www.youtube.com/watch?v=${videoId}`, ...transcript,
  })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
