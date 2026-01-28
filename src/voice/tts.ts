import { logger } from "../utils/logger.js";
import type { SynthesisResult, VoiceConfig } from "./types.js";

/**
 * Default ElevenLabs voice ID (Rachel - conversational)
 */
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

/**
 * Synthesize speech using ElevenLabs API
 */
export async function synthesizeSpeech(
  text: string,
  config: VoiceConfig
): Promise<SynthesisResult> {
  const voiceId = config.elevenLabsVoiceId || DEFAULT_VOICE_ID;
  const model = config.elevenLabsModel || "eleven_multilingual_v2";

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
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
          stability: 0.5,
          similarity_boost: 0.75,
        },
        output_format: "mp3_44100_128",
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs API error: ${response.status} - ${error}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const audio = Buffer.from(arrayBuffer);

  logger.debug(
    { textLength: text.length, audioSize: audio.length },
    "Speech synthesized successfully"
  );

  return {
    audio,
    format: "mp3",
  };
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
