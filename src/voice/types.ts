/**
 * Voice processing types
 */

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
}

export interface SynthesisResult {
  audio: Buffer;
  format: "ogg" | "mp3";
}

export interface VoiceConfig {
  openaiApiKey: string;
  elevenLabsApiKey: string;
  elevenLabsVoiceId: string;
  elevenLabsModel: string;
}
