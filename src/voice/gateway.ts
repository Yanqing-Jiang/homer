import { logger } from "../utils/logger.js";
import { transcribeAudio } from "./stt.js";
import { synthesizeSpeech, synthesizeSpeechStream, truncateForTTS } from "./tts.js";
import type {
  VoiceConfig,
  VoiceGatewayConfig,
  TranscriptionResult,
  SynthesisResult,
  SynthesisOptions,
  AudioFormat,
} from "./types.js";

/**
 * Voice Gateway - Orchestrates STT → LLM → TTS pipeline
 */
export class VoiceGateway {
  private config: VoiceGatewayConfig;

  constructor(config: VoiceGatewayConfig) {
    this.config = config;
  }

  /**
   * Process voice input and return voice output
   * Full pipeline: audio → text → LLM response → audio
   */
  async processVoice(
    audioInput: Buffer,
    processText: (text: string) => Promise<string>,
    options: {
      format?: AudioFormat;
      turbo?: boolean;
    } = {}
  ): Promise<{ transcription: TranscriptionResult; response: string; audio: SynthesisResult }> {
    // Step 1: STT
    logger.debug("Voice gateway: Starting transcription");
    const transcription = await transcribeAudio(audioInput, this.config.voiceConfig);

    if (!transcription.text.trim()) {
      throw new Error("Empty transcription");
    }

    logger.debug({ text: transcription.text.slice(0, 50) }, "Voice gateway: Transcription complete");

    // Step 2: Process with LLM
    logger.debug("Voice gateway: Processing with LLM");
    const response = await processText(transcription.text);

    // Step 3: TTS
    logger.debug("Voice gateway: Synthesizing response");
    const ttsText = truncateForTTS(response);
    const audio = await synthesizeSpeech(ttsText, this.config.voiceConfig, {
      format: options.format || this.config.defaultFormat,
      turbo: options.turbo,
    });

    logger.info(
      {
        inputLength: audioInput.length,
        transcriptionLength: transcription.text.length,
        responseLength: response.length,
        audioOutputLength: audio.audio.length,
      },
      "Voice gateway: Pipeline complete"
    );

    return { transcription, response, audio };
  }

  /**
   * Process voice with streaming TTS output
   * Returns transcription and response immediately, streams audio chunks
   */
  async processVoiceStreaming(
    audioInput: Buffer,
    processText: (text: string) => Promise<string>,
    onAudioChunk: (chunk: Buffer) => void,
    options: {
      format?: AudioFormat;
      turbo?: boolean;
    } = {}
  ): Promise<{ transcription: TranscriptionResult; response: string }> {
    // Step 1: STT
    const transcription = await transcribeAudio(audioInput, this.config.voiceConfig);

    if (!transcription.text.trim()) {
      throw new Error("Empty transcription");
    }

    // Step 2: Process with LLM
    const response = await processText(transcription.text);

    // Step 3: Stream TTS
    const ttsText = truncateForTTS(response);
    const stream = synthesizeSpeechStream(ttsText, this.config.voiceConfig, {
      format: options.format || this.config.defaultFormat,
      turbo: options.turbo,
    });

    for await (const chunk of stream) {
      onAudioChunk(chunk);
    }

    return { transcription, response };
  }

  /**
   * Transcribe audio only (no TTS response)
   */
  async transcribe(audioInput: Buffer): Promise<TranscriptionResult> {
    return transcribeAudio(audioInput, this.config.voiceConfig);
  }

  /**
   * Synthesize text to speech only
   */
  async synthesize(
    text: string,
    options: SynthesisOptions = {}
  ): Promise<SynthesisResult> {
    const ttsText = truncateForTTS(text);
    return synthesizeSpeech(ttsText, this.config.voiceConfig, {
      format: options.format || this.config.defaultFormat,
      ...options,
    });
  }

  /**
   * Stream synthesize text to speech
   */
  async *synthesizeStream(
    text: string,
    options: Omit<SynthesisOptions, "stream" | "onChunk"> = {}
  ): AsyncGenerator<Buffer, void, unknown> {
    const ttsText = truncateForTTS(text);
    yield* synthesizeSpeechStream(ttsText, this.config.voiceConfig, {
      format: options.format || this.config.defaultFormat,
      ...options,
    });
  }

  /**
   * Get voice config
   */
  getConfig(): VoiceConfig {
    return this.config.voiceConfig;
  }
}

/**
 * Create a voice gateway instance
 */
export function createVoiceGateway(voiceConfig: VoiceConfig): VoiceGateway {
  return new VoiceGateway({
    voiceConfig,
    defaultFormat: "ogg_opus",
    enableStreaming: true,
  });
}
