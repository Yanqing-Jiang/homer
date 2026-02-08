/**
 * YouTube Transcript Extraction
 *
 * 3-tier fallback chain:
 *   1. youtube-transcript-api (Python) — fastest, uses existing captions
 *   2. yt-dlp — manual + auto-generated subtitles
 *   3. ElevenLabs Scribe — audio extraction → high-accuracy STT
 *
 * Full transcripts are saved locally to ~/homer/data/youtube-transcripts/
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { logger } from "../utils/logger.js";

const VENV_PATH = `${process.env.HOME}/homer/youtube-venv`;
const EXTRACTION_TIMEOUT = 30000; // 30s per attempt
const ELEVENLABS_TIMEOUT = 120000; // 2 min for audio download + transcription
const TRANSCRIPTS_DIR = `${process.env.HOME}/homer/data/youtube-transcripts`;

export type TranscriptMethod = "youtube-transcript-api" | "yt-dlp" | "elevenlabs";

export interface TranscriptResult {
  text: string;
  method: TranscriptMethod;
  charCount: number;
}

/**
 * Ensure the Python venv exists with youtube-transcript-api installed.
 * One-time setup, cached after first run.
 */
async function ensureYouTubeVenv(): Promise<boolean> {
  const pythonPath = `${VENV_PATH}/bin/python`;
  if (existsSync(pythonPath)) {
    return true;
  }

  logger.info("Creating YouTube Python venv (one-time setup)");

  try {
    await runCommand("uv", ["venv", VENV_PATH], 30000);
    await runCommand(
      "uv",
      ["pip", "install", "--python", pythonPath, "youtube-transcript-api"],
      60000
    );
    logger.info("YouTube Python venv created successfully");
    return true;
  } catch (error) {
    logger.error({ error }, "Failed to create YouTube Python venv");
    return false;
  }
}

/**
 * Ensure transcripts directory exists.
 */
function ensureTranscriptsDir(): void {
  if (!existsSync(TRANSCRIPTS_DIR)) {
    mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  }
}

/**
 * Save transcript to local file for reuse and indexing.
 */
function saveTranscriptLocally(
  videoId: string,
  result: TranscriptResult
): string {
  ensureTranscriptsDir();
  const date = new Date().toISOString().split("T")[0];
  const filePath = join(TRANSCRIPTS_DIR, `${videoId}-${date}.md`);

  const content = `---
videoId: ${videoId}
method: ${result.method}
charCount: ${result.charCount}
extractedAt: ${new Date().toISOString()}
---

${result.text}
`;

  writeFileSync(filePath, content, "utf-8");
  logger.info({ videoId, filePath, method: result.method }, "Transcript saved locally");
  return filePath;
}

/**
 * Check if a transcript already exists locally.
 */
export function getLocalTranscript(videoId: string): TranscriptResult | null {
  if (!existsSync(TRANSCRIPTS_DIR)) return null;

  try {
    const files = readdirSync(TRANSCRIPTS_DIR);
    const match = files.find((f: string) => f.startsWith(`${videoId}-`));
    if (!match) return null;

    const content = readFileSync(join(TRANSCRIPTS_DIR, match), "utf-8");
    // Strip YAML frontmatter
    const bodyMatch = content.match(/---[\s\S]*?---\n([\s\S]*)/);
    const text = bodyMatch ? bodyMatch[1]!.trim() : content.trim();

    const methodMatch = content.match(/method:\s*(\S+)/);
    const method = (methodMatch?.[1] ?? "youtube-transcript-api") as TranscriptMethod;

    if (text.length > 50) {
      return { text, method, charCount: text.length };
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Extract transcript for a YouTube video.
 * 3-tier fallback: youtube-transcript-api → yt-dlp → ElevenLabs Scribe.
 * Saves result locally for reuse.
 */
export async function extractTranscript(
  videoId: string
): Promise<TranscriptResult | null> {
  // Check local cache first
  const cached = getLocalTranscript(videoId);
  if (cached) {
    logger.info({ videoId, method: cached.method }, "Using cached local transcript");
    return cached;
  }

  // Tier 1: youtube-transcript-api
  const apiResult = await extractViaApi(videoId);
  if (apiResult) {
    saveTranscriptLocally(videoId, apiResult);
    return apiResult;
  }

  // Tier 2: yt-dlp
  const ytdlpResult = await extractViaYtDlp(videoId);
  if (ytdlpResult) {
    saveTranscriptLocally(videoId, ytdlpResult);
    return ytdlpResult;
  }

  // Tier 3: ElevenLabs Scribe (audio extraction → STT)
  const elevenResult = await extractViaElevenLabs(videoId);
  if (elevenResult) {
    saveTranscriptLocally(videoId, elevenResult);
    return elevenResult;
  }

  logger.warn({ videoId }, "All transcript extraction methods failed");
  return null;
}

async function extractViaApi(
  videoId: string
): Promise<TranscriptResult | null> {
  const venvReady = await ensureYouTubeVenv();
  if (!venvReady) return null;

  const pythonPath = `${VENV_PATH}/bin/python`;
  const script = `
import json, sys
from youtube_transcript_api import YouTubeTranscriptApi

try:
    ytt_api = YouTubeTranscriptApi()
    transcript_list = ytt_api.fetch(sys.argv[1])
    text = " ".join(snippet.text for snippet in transcript_list.snippets)
    print(json.dumps({"text": text}))
except Exception as e:
    print(json.dumps({"error": str(e)}), file=sys.stderr)
    sys.exit(1)
`;

  try {
    const output = await runCommand(
      pythonPath,
      ["-c", script, videoId],
      EXTRACTION_TIMEOUT
    );

    const parsed = JSON.parse(output.trim());
    if (parsed.text && parsed.text.length > 50) {
      logger.info(
        { videoId, chars: parsed.text.length },
        "Transcript extracted via youtube-transcript-api"
      );
      return {
        text: parsed.text,
        method: "youtube-transcript-api",
        charCount: parsed.text.length,
      };
    }
  } catch (error) {
    logger.debug(
      { videoId, error: error instanceof Error ? error.message : String(error) },
      "youtube-transcript-api failed, trying yt-dlp"
    );
  }

  return null;
}

async function extractViaYtDlp(
  videoId: string
): Promise<TranscriptResult | null> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    // yt-dlp writes subtitles to stdout with --write-auto-sub --skip-download
    const output = await runCommand(
      "yt-dlp",
      [
        "--write-auto-sub",
        "--sub-lang", "en",
        "--skip-download",
        "--sub-format", "vtt",
        "-o", "-",
        "--print", "%(subtitles.en.-1.data)s",
        url,
      ],
      EXTRACTION_TIMEOUT
    );

    if (!output || output.trim() === "NA") {
      // Try auto-generated subs
      const autoOutput = await runCommand(
        "yt-dlp",
        [
          "--write-auto-sub",
          "--sub-lang", "en",
          "--skip-download",
          "--sub-format", "vtt",
          "-o", "-",
          "--print", "%(automatic_captions.en.-1.data)s",
          url,
        ],
        EXTRACTION_TIMEOUT
      );

      if (autoOutput && autoOutput.trim() !== "NA") {
        const text = parseVtt(autoOutput);
        if (text.length > 50) {
          logger.info(
            { videoId, chars: text.length },
            "Transcript extracted via yt-dlp (auto-captions)"
          );
          return { text, method: "yt-dlp", charCount: text.length };
        }
      }

      return null;
    }

    const text = parseVtt(output);
    if (text.length > 50) {
      logger.info(
        { videoId, chars: text.length },
        "Transcript extracted via yt-dlp"
      );
      return { text, method: "yt-dlp", charCount: text.length };
    }
  } catch (error) {
    logger.debug(
      { videoId, error: error instanceof Error ? error.message : String(error) },
      "yt-dlp transcript extraction failed"
    );
  }

  return null;
}

// ============================================
// TIER 3: ELEVENLABS SCRIBE
// ============================================

async function extractViaElevenLabs(
  videoId: string
): Promise<TranscriptResult | null> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const tmpDir = `${process.env.HOME}/homer/data/tmp`;

  if (!existsSync(tmpDir)) {
    mkdirSync(tmpDir, { recursive: true });
  }

  const audioPath = join(tmpDir, `${videoId}.wav`);

  try {
    // Step 1: Download audio via yt-dlp
    logger.info({ videoId }, "ElevenLabs tier: downloading audio via yt-dlp");
    await runCommand(
      "yt-dlp",
      ["-x", "--audio-format", "wav", "--audio-quality", "0", "-o", audioPath, url],
      60000
    );

    if (!existsSync(audioPath)) {
      logger.debug({ videoId }, "yt-dlp audio extraction produced no file");
      return null;
    }

    // Step 2: Transcribe via ElevenLabs API
    const apiKey = process.env.ELEVEN_LABS_API_KEY;
    if (!apiKey) {
      logger.warn("ELEVEN_LABS_API_KEY not set, skipping ElevenLabs transcription");
      cleanup(audioPath);
      return null;
    }

    logger.info({ videoId }, "ElevenLabs tier: transcribing audio via Scribe API");
    const text = await transcribeWithElevenLabs(audioPath, apiKey);

    // Cleanup audio file
    cleanup(audioPath);

    if (text && text.length > 50) {
      logger.info(
        { videoId, chars: text.length },
        "Transcript extracted via ElevenLabs Scribe"
      );
      return { text, method: "elevenlabs", charCount: text.length };
    }
  } catch (error) {
    logger.debug(
      { videoId, error: error instanceof Error ? error.message : String(error) },
      "ElevenLabs transcript extraction failed"
    );
    cleanup(audioPath);
  }

  return null;
}

async function transcribeWithElevenLabs(
  audioPath: string,
  apiKey: string
): Promise<string | null> {
  // Use Node.js fetch + FormData to call ElevenLabs Speech-to-Text API
  const audioBuffer = readFileSync(audioPath);

  const formData = new FormData();
  formData.append("file", new Blob([audioBuffer], { type: "audio/wav" }), "audio.wav");
  formData.append("model_id", "scribe_v1");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ELEVENLABS_TIMEOUT);

  try {
    const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
      },
      body: formData,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const body = await response.text();
      logger.warn(
        { status: response.status, body: body.slice(0, 200) },
        "ElevenLabs STT API error"
      );
      return null;
    }

    const data = (await response.json()) as { text?: string };
    return data.text ?? null;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

function cleanup(filePath: string): void {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // ignore cleanup errors
  }
}

// ============================================
// VTT PARSING
// ============================================

/**
 * Strip VTT timestamps and formatting, return plain text.
 */
function parseVtt(vtt: string): string {
  return vtt
    .split("\n")
    .filter((line) => {
      // Skip VTT headers, timestamps, and empty lines
      if (!line.trim()) return false;
      if (line.startsWith("WEBVTT")) return false;
      if (line.startsWith("Kind:")) return false;
      if (line.startsWith("Language:")) return false;
      if (/^\d{2}:\d{2}/.test(line)) return false; // timestamp lines
      if (/-->/.test(line)) return false;
      return true;
    })
    .map((line) => line.replace(/<[^>]+>/g, "").trim()) // strip HTML tags
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function runCommand(
  cmd: string,
  args: string[],
  timeout: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      timeout,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}
