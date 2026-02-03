import { logger } from "../utils/logger.js";
import type { SynthesisResult, SynthesisOptions, VoiceConfig, AudioFormat } from "./types.js";

/**
 * Default ElevenLabs voice ID (Rachel - conversational)
 */
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

/**
 * ElevenLabs output format mapping
 */
const FORMAT_MAP: Record<AudioFormat, { elevenLabsFormat: string; outputFormat: "ogg" | "mp3" | "pcm" }> = {
  ogg_opus: { elevenLabsFormat: "ogg_opus", outputFormat: "ogg" },
  mp3_44100_128: { elevenLabsFormat: "mp3_44100_128", outputFormat: "mp3" },
  pcm_16000: { elevenLabsFormat: "pcm_16000", outputFormat: "pcm" },
};

/**
 * Synthesize speech using ElevenLabs API
 * Supports both batch and streaming modes
 */
export async function synthesizeSpeech(
  text: string,
  config: VoiceConfig,
  options: SynthesisOptions = {}
): Promise<SynthesisResult> {
  const voiceId = config.elevenLabsVoiceId || DEFAULT_VOICE_ID;

  // Use turbo model for lower latency when requested
  const model = options.turbo
    ? "eleven_turbo_v2_5"
    : (config.elevenLabsModel || "eleven_multilingual_v2");

  const format = options.format || "ogg_opus";
  const { elevenLabsFormat, outputFormat } = FORMAT_MAP[format];

  const url = options.stream
    ? `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`
    : `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": config.elevenLabsApiKey,
    },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: {
        stability: options.stability ?? 0.5,
        similarity_boost: options.similarityBoost ?? 0.75,
      },
      output_format: elevenLabsFormat,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs API error: ${response.status} - ${error}`);
  }

  // Handle streaming response
  if (options.stream && options.onChunk && response.body) {
    const chunks: Buffer[] = [];
    const reader = response.body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = Buffer.from(value);
        chunks.push(chunk);
        options.onChunk(chunk);
      }
    } finally {
      reader.releaseLock();
    }

    const audio = Buffer.concat(chunks);

    logger.debug(
      { textLength: text.length, audioSize: audio.length, streaming: true },
      "Speech synthesized (streaming)"
    );

    return { audio, format: outputFormat };
  }

  // Batch response
  const arrayBuffer = await response.arrayBuffer();
  const audio = Buffer.from(arrayBuffer);

  logger.debug(
    { textLength: text.length, audioSize: audio.length, format: outputFormat },
    "Speech synthesized successfully"
  );

  return { audio, format: outputFormat };
}

/**
 * Synthesize speech with streaming - returns an async generator
 */
export async function* synthesizeSpeechStream(
  text: string,
  config: VoiceConfig,
  options: Omit<SynthesisOptions, "stream" | "onChunk"> = {}
): AsyncGenerator<Buffer, void, unknown> {
  const voiceId = config.elevenLabsVoiceId || DEFAULT_VOICE_ID;
  const model = options.turbo
    ? "eleven_turbo_v2_5"
    : (config.elevenLabsModel || "eleven_multilingual_v2");

  const format = options.format || "ogg_opus";
  const { elevenLabsFormat } = FORMAT_MAP[format];

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": config.elevenLabsApiKey,
      },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: {
          stability: options.stability ?? 0.5,
          similarity_boost: options.similarityBoost ?? 0.75,
        },
        output_format: elevenLabsFormat,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs API error: ${response.status} - ${error}`);
  }

  if (!response.body) {
    throw new Error("No response body for streaming");
  }

  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield Buffer.from(value);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Truncate text for TTS (ElevenLabs has limits)
 * Max ~5000 characters per request
 */
export function truncateForTTS(text: string, maxLength: number = 4000): string {
  if (text.length <= maxLength) {
    return text;
  }

  // Try to truncate at a sentence boundary
  const truncated = text.slice(0, maxLength);
  const lastPeriod = truncated.lastIndexOf(".");
  const lastQuestion = truncated.lastIndexOf("?");
  const lastExclamation = truncated.lastIndexOf("!");

  const cutPoint = Math.max(lastPeriod, lastQuestion, lastExclamation);

  if (cutPoint > maxLength * 0.5) {
    return truncated.slice(0, cutPoint + 1);
  }

  return truncated + "...";
}

/**
 * Estimate TTS cost in characters
 * ElevenLabs charges per character
 */
export function estimateTTSCost(text: string): { characters: number; estimatedCostUSD: number } {
  const characters = text.length;
  // Rough estimate: ~$0.30 per 1000 characters on Starter plan
  const estimatedCostUSD = (characters / 1000) * 0.30;
  return { characters, estimatedCostUSD };
}
