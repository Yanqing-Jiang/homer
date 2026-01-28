import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { logger } from "../utils/logger.js";
import type { TranscriptionResult, VoiceConfig } from "./types.js";

/**
 * Transcribe audio using OpenAI Whisper API
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  config: VoiceConfig
): Promise<TranscriptionResult> {
  // Write buffer to temp file (Whisper API requires a file)
  const tempPath = join(tmpdir(), `voice-${randomUUID()}.ogg`);

  try {
    await writeFile(tempPath, audioBuffer);

    // Create form data with the audio file
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: "audio/ogg" });
    formData.append("file", blob, "audio.ogg");
    formData.append("model", "whisper-1");

    const response = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.openaiApiKey}`,
        },
        body: formData,
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Whisper API error: ${response.status} - ${error}`);
    }

    const result = (await response.json()) as { text: string };

    logger.debug(
      { textLength: result.text.length },
      "Audio transcribed successfully"
    );

    return {
      text: result.text,
    };
  } finally {
    // Cleanup temp file
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}
