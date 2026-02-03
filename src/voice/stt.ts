import { logger } from "../utils/logger.js";
import type { TranscriptionResult, TranscriptionOptions, VoiceConfig } from "./types.js";

/**
 * ElevenLabs Scribe v2 response types
 */
interface ScribeWord {
  text: string;
  start: number;
  end: number;
  speaker_id?: string;
}

interface ScribeEntity {
  text: string;
  type: string;
  start: number;
  end: number;
}

interface ScribeResponse {
  text: string;
  language_code?: string;
  language_probability?: number;
  words?: ScribeWord[];
  entities?: ScribeEntity[];
  transcription_id?: string;
}

/**
 * Transcribe audio using ElevenLabs Scribe v2 API
 *
 * Scribe v2 offers:
 * - 90+ languages with auto-detection
 * - Speaker diarization (up to 32 speakers)
 * - Entity detection (PII, PHI, PCI)
 * - Keyterm prompting for custom vocabulary
 * - Word-level timestamps
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  config: VoiceConfig,
  options: TranscriptionOptions = {}
): Promise<TranscriptionResult> {
  const formData = new FormData();

  // Audio file
  const blob = new Blob([audioBuffer], { type: "audio/ogg" });
  formData.append("file", blob, "audio.ogg");

  // Model - use Scribe v2 for best accuracy
  formData.append("model_id", options.model || "scribe_v2");

  // Language (optional - auto-detects if not specified)
  if (options.languageCode) {
    formData.append("language_code", options.languageCode);
  }

  // Speaker diarization
  if (options.diarize) {
    formData.append("diarize", "true");
    if (options.numSpeakers) {
      formData.append("num_speakers", options.numSpeakers.toString());
    }
  }

  // Timestamps
  formData.append("timestamps_granularity", options.timestampsGranularity || "word");

  // Audio event tagging (laughter, applause, etc.)
  formData.append("tag_audio_events", options.tagAudioEvents !== false ? "true" : "false");

  // Entity detection (PII, PHI, PCI)
  if (options.entityDetection) {
    formData.append("entity_detection",
      Array.isArray(options.entityDetection)
        ? options.entityDetection.join(",")
        : options.entityDetection
    );
  }

  // Keyterms for custom vocabulary (brand names, technical terms)
  if (options.keyterms && options.keyterms.length > 0) {
    // API expects keyterms as a JSON array string
    formData.append("keyterms", JSON.stringify(options.keyterms.slice(0, 100)));
  }

  const response = await fetch(
    "https://api.elevenlabs.io/v1/speech-to-text",
    {
      method: "POST",
      headers: {
        "xi-api-key": config.elevenLabsApiKey,
      },
      body: formData,
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs Scribe API error: ${response.status} - ${error}`);
  }

  const result = (await response.json()) as ScribeResponse;

  logger.debug(
    {
      textLength: result.text.length,
      language: result.language_code,
      languageConfidence: result.language_probability,
      wordCount: result.words?.length,
      entityCount: result.entities?.length,
    },
    "Audio transcribed with ElevenLabs Scribe v2"
  );

  return {
    text: result.text,
    language: result.language_code,
    languageConfidence: result.language_probability,
    words: result.words,
    entities: result.entities,
    transcriptionId: result.transcription_id,
  };
}

/**
 * Transcribe a meeting recording with full features
 * Optimized for longer audio with multiple speakers
 */
export async function transcribeMeeting(
  audioBuffer: Buffer,
  config: VoiceConfig,
  options: {
    title?: string;
    expectedSpeakers?: number;
    keyterms?: string[];
  } = {}
): Promise<TranscriptionResult> {
  return transcribeAudio(audioBuffer, config, {
    model: "scribe_v2",
    diarize: true,
    numSpeakers: options.expectedSpeakers || 8,
    timestampsGranularity: "word",
    tagAudioEvents: true,
    entityDetection: "all",
    keyterms: options.keyterms,
  });
}
