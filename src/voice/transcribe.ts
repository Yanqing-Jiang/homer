/**
 * Local-first speech-to-text: whisper.cpp + ffmpeg, with ElevenLabs Scribe fallback.
 *
 * Shared by the web mic route (/api/transcribe) and the Telegram voice-receive
 * handler so both get the same free-local-first, cloud-fallback behavior.
 *
 * Primary (local, free):
 *   audio buffer (webm/ogg/wav/mp3)
 *     → /tmp/whisper-<uuid>.audio          (raw)
 *     → ffmpeg -ar 16000 -ac 1 → /tmp/whisper-<uuid>.wav
 *     → whisper-cli --no-prints --no-timestamps → stdout text
 *
 * Fallback (cloud): if the local model is missing or whisper/ffmpeg fails and an
 * ElevenLabs API key is available, the raw buffer is sent to Scribe v2.
 *
 * Models live at ~/.cache/whisper/. Default: ggml-large-v3-turbo.bin (multilingual,
 * ~10x real-time on Apple Silicon via Metal). Override with WHISPER_MODEL=<filename>.
 * Binaries assumed on PATH: `whisper-cli` (brew install whisper-cpp) and `ffmpeg`.
 */

import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { logger } from "../utils/logger.js";
import { transcribeAudio } from "./stt.js";

export const WHISPER_MODEL_DIR = join(homedir(), ".cache", "whisper");
export const WHISPER_MODEL_NAME = process.env.WHISPER_MODEL || "ggml-large-v3-turbo.bin";
export const WHISPER_MODEL_PATH = join(WHISPER_MODEL_DIR, WHISPER_MODEL_NAME);

// Bound the cloud fallback — the Fastify server disables per-request timeout,
// so a stalled ElevenLabs call would otherwise hang the request indefinitely.
const SCRIBE_TIMEOUT_MS = 120_000;

export type TranscribeEngine = "whisper" | "scribe";

export interface TranscribeResult {
  text: string;
  engine: TranscribeEngine;
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

function safeUnlink(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch (e) {
    logger.debug({ path, error: e }, "transcribe: temp cleanup failed (non-fatal)");
  }
}

/**
 * Local transcription via whisper.cpp. Throws on any failure (missing model,
 * ffmpeg error, whisper-cli error) so the caller can fall back to Scribe.
 * Cleans up its own temp files.
 */
export async function transcribeLocal(audio: Buffer): Promise<string> {
  if (!existsSync(WHISPER_MODEL_PATH)) {
    throw new Error(`Whisper model not found at ${WHISPER_MODEL_PATH}`);
  }

  const tmp = tmpdir();
  if (!existsSync(tmp)) mkdirSync(tmp, { recursive: true });
  const id = randomUUID();
  const inPath = join(tmp, `whisper-${id}.audio`);
  const wavPath = join(tmp, `whisper-${id}.wav`);

  try {
    writeFileSync(inPath, audio);

    // ffmpeg → 16kHz mono PCM wav (whisper.cpp's preferred format).
    const ff = await run(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-i", inPath, "-ar", "16000", "-ac", "1", wavPath],
      30_000,
    );
    if (ff.code !== 0) {
      throw new Error(`ffmpeg conversion failed: ${ff.stderr.slice(0, 200)}`);
    }

    // whisper-cli → stdout text (no timestamps, no metadata noise).
    const ws = await run(
      "whisper-cli",
      ["-m", WHISPER_MODEL_PATH, "-f", wavPath, "--no-prints", "--no-timestamps", "--language", "en"],
      120_000,
    );
    if (ws.code !== 0) {
      throw new Error(`whisper-cli failed: ${ws.stderr.slice(0, 200)}`);
    }

    return ws.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join(" ")
      .trim();
  } finally {
    safeUnlink(inPath);
    safeUnlink(wavPath);
  }
}

/**
 * Transcribe an audio buffer local-first, falling back to ElevenLabs Scribe v2.
 *
 * - Tries whisper.cpp first (free, local).
 * - On any local failure, falls back to Scribe if an API key is available
 *   (explicit `elevenLabsApiKey` option, else ELEVEN_LABS_API_KEY env).
 * - If local fails and no key is configured, rethrows the local error.
 * - If the Scribe fallback itself errors, that error propagates.
 */
export async function transcribeWithFallback(
  audio: Buffer,
  opts: { elevenLabsApiKey?: string; mimeType?: string; filename?: string } = {},
): Promise<TranscribeResult> {
  let localError: unknown;
  try {
    const text = await transcribeLocal(audio);
    return { text, engine: "whisper" };
  } catch (e) {
    localError = e;
  }

  const apiKey = opts.elevenLabsApiKey || process.env.ELEVEN_LABS_API_KEY;
  if (!apiKey) {
    logger.warn({ error: localError }, "transcribe: local whisper failed, no Scribe fallback (no API key)");
    throw localError instanceof Error ? localError : new Error("Transcription failed");
  }

  logger.warn({ error: localError }, "transcribe: local whisper failed, falling back to Scribe");
  const result = await transcribeAudio(
    audio,
    { elevenLabsApiKey: apiKey },
    {
      model: "scribe_v2",
      mimeType: opts.mimeType,
      filename: opts.filename,
      signal: AbortSignal.timeout(SCRIBE_TIMEOUT_MS),
    },
  );
  return { text: result.text.trim(), engine: "scribe" };
}
