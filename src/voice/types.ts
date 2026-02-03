/**
 * Voice processing types
 */

/** Word-level timing from Scribe v2 */
export interface TranscriptionWord {
  text: string;
  start: number;
  end: number;
  speaker_id?: string;
}

/** Detected entity (PII, PHI, PCI, etc.) from Scribe v2 */
export interface TranscriptionEntity {
  text: string;
  type: string;
  start: number;
  end: number;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  languageConfidence?: number;
  duration?: number;
  /** Word-level timestamps and speaker IDs */
  words?: TranscriptionWord[];
  /** Detected entities (PII, PHI, PCI) */
  entities?: TranscriptionEntity[];
  /** ElevenLabs transcription ID for reference */
  transcriptionId?: string;
}

export interface TranscriptionOptions {
  /** Model to use: scribe_v1 or scribe_v2 (default: scribe_v2) */
  model?: "scribe_v1" | "scribe_v2";
  /** ISO-639 language code (auto-detects if not specified) */
  languageCode?: string;
  /** Enable speaker diarization */
  diarize?: boolean;
  /** Expected number of speakers (max 32) */
  numSpeakers?: number;
  /** Timestamp granularity: none, word, or character */
  timestampsGranularity?: "none" | "word" | "character";
  /** Tag audio events like laughter, applause */
  tagAudioEvents?: boolean;
  /** Entity detection: all, or specific types (pii, phi, pci) */
  entityDetection?: "all" | string | string[];
  /** Custom vocabulary terms to bias recognition (max 100) */
  keyterms?: string[];
}

export type AudioFormat = "ogg_opus" | "mp3_44100_128" | "pcm_16000";

export interface SynthesisResult {
  audio: Buffer;
  format: "ogg" | "mp3" | "pcm";
}

export interface SynthesisOptions {
  /** Output format - ogg_opus recommended for Telegram */
  format?: AudioFormat;
  /** Enable streaming (returns chunks via callback) */
  stream?: boolean;
  /** Callback for streaming chunks */
  onChunk?: (chunk: Buffer) => void;
  /** Voice settings overrides */
  stability?: number;
  similarityBoost?: number;
  /** Use turbo model for lower latency */
  turbo?: boolean;
}

export interface VoiceConfig {
  /** ElevenLabs API key (used for both STT and TTS) */
  elevenLabsApiKey: string;
  /** ElevenLabs voice ID for TTS */
  elevenLabsVoiceId?: string;
  /** ElevenLabs TTS model */
  elevenLabsModel?: string;
  /** @deprecated - no longer used, STT now uses ElevenLabs Scribe */
  openaiApiKey?: string;
}

export interface VoiceSession {
  id: string;
  chatId: number;
  startedAt: Date;
  lastActivityAt: Date;
  conversationId?: string;
  mode: "push_to_talk" | "voice_activity";
}

export interface VoiceGatewayConfig {
  voiceConfig: VoiceConfig;
  defaultFormat: AudioFormat;
  enableStreaming: boolean;
}

/** WebSocket message types for web voice */
export type VoiceMessageType =
  | "audio_chunk"
  | "transcription"
  | "response_start"
  | "response_chunk"
  | "response_end"
  | "error";

export interface VoiceMessage {
  type: VoiceMessageType;
  data: unknown;
  timestamp: number;
}
