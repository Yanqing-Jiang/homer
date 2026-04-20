/**
 * Speaker mapping using Claude CLI with JSON output
 *
 * Maps speaker_0, speaker_1, etc. from diarization to actual names
 * using context clues from the transcript and provided attendee list.
 */

import type {
  SpeakerMapping,
  SpeakerMappingResult,
} from "./types.js";
import type { TranscriptionResult, TranscriptionWord } from "../voice/types.js";
import { logger } from "../utils/logger.js";
import { executeClaudeCommand } from "../executors/claude.js";

interface MappingToolResult {
  mappings: Array<{
    speaker_id: string;
    name: string | null;
    confidence: number;
    evidence: string;
    needs_review: boolean;
  }>;
  overall_confidence: number;
  notes?: string;
}

/**
 * Extract JSON from Claude CLI output (handles markdown fences)
 */
function extractJSON(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) return fenceMatch[1]!.trim();

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];

  return text.trim();
}

/**
 * Build a transcript preview from words for the prompt
 */
function buildTranscriptPreview(
  words: TranscriptionWord[],
  maxLength: number = 8000
): string {
  if (!words || words.length === 0) return "(empty transcript)";

  const lines: string[] = [];
  let currentSpeaker: string | undefined;
  let currentLine: string[] = [];
  let totalLength = 0;

  for (const word of words) {
    if (word.speaker_id !== currentSpeaker) {
      // Save previous line
      if (currentLine.length > 0) {
        const timestamp = formatTime(words.find(w => w.speaker_id === currentSpeaker)?.start ?? 0);
        const line = `[${timestamp}] ${currentSpeaker || "unknown"}: ${currentLine.join(" ")}`;
        if (totalLength + line.length > maxLength) break;
        lines.push(line);
        totalLength += line.length;
      }
      currentSpeaker = word.speaker_id;
      currentLine = [word.text];
    } else {
      currentLine.push(word.text);
    }
  }

  // Don't forget last line
  if (currentLine.length > 0) {
    const timestamp = formatTime(words.find(w => w.speaker_id === currentSpeaker)?.start ?? 0);
    const line = `[${timestamp}] ${currentSpeaker || "unknown"}: ${currentLine.join(" ")}`;
    if (totalLength + line.length <= maxLength) {
      lines.push(line);
    }
  }

  return lines.join("\n");
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/**
 * Extract unique speaker IDs from transcript
 */
function getUniqueSpeakers(words: TranscriptionWord[]): string[] {
  const speakers = new Set<string>();
  for (const word of words) {
    if (word.speaker_id) {
      speakers.add(word.speaker_id);
    }
  }
  return Array.from(speakers).sort();
}

/**
 * Map speakers using Claude CLI
 */
export async function mapSpeakers(
  transcription: TranscriptionResult,
  attendees: string[],
  context?: string
): Promise<SpeakerMappingResult> {
  const words = transcription.words || [];
  const speakers = getUniqueSpeakers(words);

  // If no speakers detected or only one, simple case
  if (speakers.length === 0) {
    return {
      mappings: [],
      confidence: 1.0,
      needsReview: false,
    };
  }

  if (speakers.length === 1 && attendees.length === 1) {
    return {
      mappings: [{
        speakerId: speakers[0] as string,
        mappedName: attendees[0] as string,
        confidence: 1.0,
        reasoning: "Only one speaker and one attendee",
        needsReview: false,
      }],
      confidence: 1.0,
      needsReview: false,
    };
  }

  const transcriptPreview = buildTranscriptPreview(words);

  const prompt = `You are analyzing a meeting transcript to identify who is speaking. Respond with ONLY a JSON object, no other text.

## Attendees
${attendees.map((a, i) => `${i + 1}. ${a}`).join("\n")}

## Detected Speakers
${speakers.join(", ")}

${context ? `## Additional Context\n${context}\n` : ""}

## Transcript
${transcriptPreview}

## Task
Identify which attendee corresponds to each speaker ID. Respond with ONLY this JSON:

{
  "mappings": [
    {
      "speaker_id": "speaker_0",
      "name": "Person Name or null if unknown",
      "confidence": 0.0-1.0,
      "evidence": "quote or observation supporting this mapping",
      "needs_review": true/false
    }
  ],
  "overall_confidence": 0.0-1.0,
  "notes": "any additional observations"
}

Look for self-introductions, others addressing someone by name, speaking patterns, roles, or topics that match known attendee roles.
If you cannot confidently identify a speaker, set name to null and needs_review to true.`;

  try {
    const result = await executeClaudeCommand(prompt, {
      cwd: "/tmp",
      model: "opus",
      timeout: 900_000,
    });

    if (result.exitCode !== 0 || !result.output || result.output.length < 20) {
      throw new Error(`Claude CLI failed: exit=${result.exitCode}, output=${result.output?.slice(0, 200)}`);
    }

    const parsed = JSON.parse(extractJSON(result.output)) as MappingToolResult;

    const mappings: SpeakerMapping[] = parsed.mappings.map((m) => ({
      speakerId: m.speaker_id,
      mappedName: m.name,
      confidence: m.confidence,
      reasoning: m.evidence,
      needsReview: m.needs_review,
    }));

    // Ensure all detected speakers have a mapping
    for (const speakerId of speakers) {
      if (!mappings.find((m) => m.speakerId === speakerId)) {
        mappings.push({
          speakerId,
          mappedName: null,
          confidence: 0,
          reasoning: "Not identified by AI",
          needsReview: true,
        });
      }
    }

    const needsReview = mappings.some((m) => m.needsReview);

    logger.info(
      {
        attendees: attendees.length,
        speakers: speakers.length,
        mappings: mappings.length,
        confidence: parsed.overall_confidence,
        needsReview,
      },
      "Speaker mapping completed"
    );

    return {
      mappings,
      confidence: parsed.overall_confidence,
      needsReview,
    };
  } catch (error) {
    logger.error({ error, attendees, speakers }, "Speaker mapping failed");

    // Return uncertain mappings on error
    return {
      mappings: speakers.map((speakerId, idx) => ({
        speakerId,
        mappedName: idx < attendees.length ? attendees[idx] ?? null : null,
        confidence: 0.3,
        reasoning: "Fallback assignment (mapping failed)",
        needsReview: true,
      })),
      confidence: 0.3,
      needsReview: true,
    };
  }
}

/**
 * Remap speakers with additional context
 */
export async function remapSpeakers(
  transcription: TranscriptionResult,
  attendees: string[],
  existingMappings: SpeakerMapping[],
  additionalContext: string
): Promise<SpeakerMappingResult> {
  // Include existing mappings as context
  const existingInfo = existingMappings
    .filter((m) => m.mappedName)
    .map((m) => `${m.speakerId} was mapped to ${m.mappedName} (confidence: ${m.confidence})`)
    .join("\n");

  const context = `## Previous Mappings (may need correction)\n${existingInfo}\n\n## User Provided Context\n${additionalContext}`;

  return mapSpeakers(transcription, attendees, context);
}

/**
 * Apply manual speaker overrides
 */
export function applyManualOverrides(
  mappings: SpeakerMapping[],
  overrides: Record<string, string>
): SpeakerMapping[] {
  return mappings.map((mapping): SpeakerMapping => {
    const override = overrides[mapping.speakerId];
    if (override) {
      return {
        ...mapping,
        mappedName: override,
        confidence: 1.0,
        reasoning: "Manual override by user",
        needsReview: false,
      };
    }
    return mapping;
  });
}

/**
 * Validate speaker mappings against attendee list
 */
export function validateMappings(
  mappings: SpeakerMapping[],
  attendees: string[]
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  const attendeeSet = new Set(attendees.map((a) => a.toLowerCase()));
  const mappedNames = new Set<string>();

  for (const mapping of mappings) {
    if (!mapping.mappedName) continue;

    const nameLower = mapping.mappedName.toLowerCase();

    // Check if name matches an attendee
    if (!attendeeSet.has(nameLower)) {
      issues.push(`${mapping.speakerId} mapped to unknown attendee: ${mapping.mappedName}`);
    }

    // Check for duplicates
    if (mappedNames.has(nameLower)) {
      issues.push(`Multiple speakers mapped to: ${mapping.mappedName}`);
    }
    mappedNames.add(nameLower);
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
