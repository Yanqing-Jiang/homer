/**
 * Speaker mapping using Claude Sonnet with structured output
 *
 * Maps speaker_0, speaker_1, etc. from diarization to actual names
 * using context clues from the transcript and provided attendee list.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  SpeakerMapping,
  SpeakerMappingResult,
} from "./types.js";
import type { TranscriptionResult, TranscriptionWord } from "../voice/types.js";
import { logger } from "../utils/logger.js";

const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";

// Tool schema for structured output
const SPEAKER_MAPPINGS_TOOL = {
  name: "speaker_mappings",
  description: "Record the speaker identification mappings",
  input_schema: {
    type: "object" as const,
    properties: {
      mappings: {
        type: "array" as const,
        description: "List of speaker mappings",
        items: {
          type: "object" as const,
          properties: {
            speaker_id: {
              type: "string" as const,
              description: "Original speaker ID (e.g., speaker_0)",
            },
            name: {
              type: "string" as const,
              description: "Identified name, or null if unknown",
            },
            confidence: {
              type: "number" as const,
              description: "Confidence score 0-1",
            },
            evidence: {
              type: "string" as const,
              description: "Evidence for this mapping (quote or observation)",
            },
            needs_review: {
              type: "boolean" as const,
              description: "True if this mapping is uncertain",
            },
          },
          required: ["speaker_id", "name", "confidence", "evidence", "needs_review"],
        },
      },
      overall_confidence: {
        type: "number" as const,
        description: "Overall confidence in the mappings 0-1",
      },
      notes: {
        type: "string" as const,
        description: "Any additional observations about the speakers",
      },
    },
    required: ["mappings", "overall_confidence"],
  },
};

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
 * Map speakers using Claude Sonnet
 */
export async function mapSpeakers(
  transcription: TranscriptionResult,
  attendees: string[],
  context?: string
): Promise<SpeakerMappingResult> {
  const client = new Anthropic();

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

  const prompt = `You are analyzing a meeting transcript to identify who is speaking.

## Attendees
${attendees.map((a, i) => `${i + 1}. ${a}`).join("\n")}

## Detected Speakers
${speakers.join(", ")}

${context ? `## Additional Context\n${context}\n` : ""}

## Transcript
${transcriptPreview}

## Task
Identify which attendee corresponds to each speaker ID (speaker_0, speaker_1, etc.).

Look for:
1. Self-introductions ("I'm Sarah" or "This is Mike")
2. Others addressing someone by name ("Sarah, what do you think?")
3. Speaking patterns, roles, or topics that match known attendee roles
4. Order of speaking if attendance order is known

If you cannot confidently identify a speaker, set their name to null and needs_review to true.

Use the speaker_mappings tool to record your findings.`;

  try {
    const response = await client.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 2048,
      tools: [SPEAKER_MAPPINGS_TOOL],
      tool_choice: { type: "tool", name: "speaker_mappings" },
      messages: [{ role: "user", content: prompt }],
    });

    // Extract tool use result
    const toolUse = response.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use");
    if (!toolUse) {
      throw new Error("No tool use in response");
    }

    const result = toolUse.input as MappingToolResult;

    const mappings: SpeakerMapping[] = result.mappings.map((m) => ({
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
        confidence: result.overall_confidence,
        needsReview,
      },
      "Speaker mapping completed"
    );

    return {
      mappings,
      confidence: result.overall_confidence,
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
