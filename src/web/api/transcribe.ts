/**
 * Local speech-to-text via whisper.cpp + ffmpeg.
 *
 * POST /api/transcribe — multipart/form-data with a single `file` field (audio).
 * Returns { text, durationMs } where text is the trimmed transcript.
 *
 * Pipeline:
 *   client blob (webm/ogg/wav)
 *     → /tmp/whisper-<uuid>.<ext>          (raw upload)
 *     → ffmpeg -ar 16000 -ac 1 → /tmp/whisper-<uuid>.wav
 *     → whisper-cli --no-prints --no-timestamps → stdout text
 *
 * Models live at ~/.cache/whisper/. Default: ggml-base.en.bin.
 * Override with WHISPER_MODEL=ggml-large-v3-turbo.bin (or any filename in the cache dir).
 * Binaries assumed on PATH: `whisper-cli` (brew install whisper-cpp) and `ffmpeg`.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { logger } from "../../utils/logger.js";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25MB — covers ~30 min at 128kbps
const MODEL_DIR = join(homedir(), ".cache", "whisper");
const MODEL_NAME = process.env.WHISPER_MODEL || "ggml-base.en.bin";
const MODEL_PATH = join(MODEL_DIR, MODEL_NAME);

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

export function registerTranscribeRoutes(server: FastifyInstance): void {
  server.post("/api/transcribe", async (request: FastifyRequest, reply: FastifyReply) => {
    const contentType = request.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      reply.status(400);
      return { error: "Content-Type must be multipart/form-data" };
    }

    if (!existsSync(MODEL_PATH)) {
      reply.status(500);
      return {
        error: `Whisper model not found at ${MODEL_PATH}. Download from https://huggingface.co/ggerganov/whisper.cpp/tree/main`,
      };
    }

    const startedAt = Date.now();
    const tmp = tmpdir();
    if (!existsSync(tmp)) mkdirSync(tmp, { recursive: true });

    const id = randomUUID();
    const inPath = join(tmp, `whisper-${id}.audio`);
    const wavPath = join(tmp, `whisper-${id}.wav`);

    try {
      const data = await request.file();
      if (!data) {
        reply.status(400);
        return { error: "No audio file provided" };
      }

      // Read upload into memory with a hard size cap.
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of data.file) {
        total += chunk.length;
        if (total > MAX_AUDIO_BYTES) {
          reply.status(400);
          return { error: `Audio too large. Max ${MAX_AUDIO_BYTES / 1024 / 1024}MB` };
        }
        chunks.push(chunk);
      }
      writeFileSync(inPath, Buffer.concat(chunks));

      // ffmpeg → 16kHz mono PCM wav (whisper.cpp's preferred format).
      const ff = await run(
        "ffmpeg",
        ["-y", "-loglevel", "error", "-i", inPath, "-ar", "16000", "-ac", "1", wavPath],
        30_000,
      );
      if (ff.code !== 0) {
        logger.warn({ ff }, "transcribe: ffmpeg failed");
        reply.status(500);
        return { error: `ffmpeg conversion failed: ${ff.stderr.slice(0, 200)}` };
      }

      // whisper-cli → stdout text (no timestamps, no metadata noise).
      const ws = await run(
        "whisper-cli",
        [
          "-m", MODEL_PATH,
          "-f", wavPath,
          "--no-prints",
          "--no-timestamps",
          "--language", "en",
        ],
        120_000,
      );
      if (ws.code !== 0) {
        logger.warn({ ws }, "transcribe: whisper-cli failed");
        reply.status(500);
        return { error: `whisper-cli failed: ${ws.stderr.slice(0, 200)}` };
      }

      const text = ws.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .join(" ")
        .trim();

      const durationMs = Date.now() - startedAt;
      logger.info(
        { id, bytes: total, durationMs, textLen: text.length, model: MODEL_NAME },
        "transcribe: ok",
      );
      return { text, durationMs };
    } catch (e) {
      logger.error({ error: e }, "transcribe: failed");
      reply.status(500);
      return { error: e instanceof Error ? e.message : "Transcription failed" };
    } finally {
      safeUnlink(inPath);
      safeUnlink(wavPath);
    }
  });

  logger.info({ model: MODEL_PATH }, "Transcribe route registered (/api/transcribe)");
}
