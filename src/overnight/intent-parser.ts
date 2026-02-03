/**
 * Overnight Intent Parser
 *
 * Detects overnight work patterns in user messages and extracts:
 * - Task type (prototype vs research)
 * - Subject and constraints
 * - Confidence score
 * - Clarification prompts when needed
 */

import type {
  ParsedOvernightIntent,
  OvernightTaskType,
  ClarificationPrompt,
} from "./types.js";
import { DEFAULT_OVERNIGHT_CONFIG } from "./types.js";

// ============================================
// PATTERN MATCHING
// ============================================

/**
 * Overnight trigger patterns
 * Matches phrases like "tonight", "while I sleep", "for me tonight"
 */
const OVERNIGHT_PATTERNS = [
  /\btonight\b/i,
  /\bovernight\b/i,
  /\bwhile\s+i\s+sleep\b/i,
  /\bfor\s+me\s+tonight\b/i,
  /\bfor\s+tonight\b/i,
  /\bby\s+(tomorrow\s+)?morning\b/i,
  /\bwhen\s+i\s+wake\s+up\b/i,
  /\bwhile\s+i('m|\s+am)\s+(asleep|sleeping)\b/i,
  /\bwork\s+on\s+.+\s+tonight\b/i,
  /\bresearch\s+.+\s+(tonight|overnight)\b/i,
];

/**
 * Prototype work indicators
 * Strong signals that user wants code/implementation
 */
const PROTOTYPE_PATTERNS = [
  /\b(work\s+on|implement|add|create|build|develop|code|write)\b/i,
  /\b(feature|component|function|api|endpoint|service)\b/i,
  /\b(fix|refactor|improve|optimize|update)\b/i,
  /\b(prototype|mvp|poc|proof\s+of\s+concept)\b/i,
  /\b(rate\s+limit|auth|caching|database|migration)\b/i,
];

/**
 * Research indicators
 * Strong signals that user wants investigation/analysis
 */
const RESEARCH_PATTERNS = [
  /\b(research|investigate|explore|analyze|study)\b/i,
  /\b(find\s+out|figure\s+out|learn\s+about|understand)\b/i,
  /\b(compare|evaluate|assess|review)\b/i,
  /\b(best\s+practices|alternatives|options|approaches)\b/i,
  /\b(how\s+to|what\s+is|why\s+does|should\s+i)\b/i,
  /\b(market|competitor|trend|opportunity)\b/i,
  /\b(documentation|paper|article|resource)\b/i,
];

/**
 * Constraint extraction patterns
 */
const CONSTRAINT_PATTERNS = [
  /\bwith(?:out)?\s+(.+?)(?:\.|,|$)/gi,
  /\busing\s+(.+?)(?:\.|,|$)/gi,
  /\bmust\s+(.+?)(?:\.|,|$)/gi,
  /\bshould\s+(.+?)(?:\.|,|$)/gi,
  /\bno\s+(.+?)(?:\.|,|$)/gi,
  /\bonly\s+(.+?)(?:\.|,|$)/gi,
  /\bprefer\s+(.+?)(?:\.|,|$)/gi,
];

// ============================================
// MAIN PARSER
// ============================================

/**
 * Parse a message to detect overnight work intent
 */
export function parseOvernightIntent(message: string): ParsedOvernightIntent {
  const trimmed = message.trim();

  // Check for overnight triggers
  const isOvernight = OVERNIGHT_PATTERNS.some((p) => p.test(trimmed));

  if (!isOvernight) {
    return {
      isOvernight: false,
      constraints: [],
      confidence: 1.0,
      rawMessage: trimmed,
    };
  }

  // Detect task type
  const { taskType, typeConfidence } = detectTaskType(trimmed);

  // Extract subject
  const subject = extractSubject(trimmed, taskType);

  // Extract constraints
  const constraints = extractConstraints(trimmed);

  // Calculate overall confidence
  const confidence = calculateConfidence(trimmed, taskType, typeConfidence, subject);

  // Check if clarification needed
  const clarificationNeeded =
    confidence < DEFAULT_OVERNIGHT_CONFIG.clarificationThreshold
      ? generateClarification(trimmed, taskType, subject)
      : undefined;

  return {
    isOvernight: true,
    taskType,
    subject,
    constraints,
    confidence,
    rawMessage: trimmed,
    clarificationNeeded,
  };
}

// ============================================
// DETECTION HELPERS
// ============================================

function detectTaskType(
  message: string
): { taskType: OvernightTaskType | undefined; typeConfidence: number } {
  const prototypeScore = countPatternMatches(message, PROTOTYPE_PATTERNS);
  const researchScore = countPatternMatches(message, RESEARCH_PATTERNS);

  if (prototypeScore === 0 && researchScore === 0) {
    return { taskType: undefined, typeConfidence: 0 };
  }

  if (prototypeScore > researchScore) {
    const confidence = prototypeScore / (prototypeScore + researchScore + 1);
    return { taskType: "prototype_work", typeConfidence: confidence };
  }

  if (researchScore > prototypeScore) {
    const confidence = researchScore / (prototypeScore + researchScore + 1);
    return { taskType: "research_dive", typeConfidence: confidence };
  }

  // Equal scores - ambiguous
  return { taskType: undefined, typeConfidence: 0.5 };
}

function countPatternMatches(message: string, patterns: RegExp[]): number {
  return patterns.filter((p) => p.test(message)).length;
}

function extractSubject(message: string, _taskType?: OvernightTaskType): string {
  let cleaned = message;

  // Remove overnight trigger phrases
  for (const pattern of OVERNIGHT_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }

  // Remove common prefixes
  cleaned = cleaned
    .replace(/^(can you|could you|please|i want you to|i need you to)\s*/i, "")
    .replace(/^(work on|implement|add|create|research|investigate)\s*/i, "")
    .replace(/\s*(for me|for tonight)$/i, "")
    .trim();

  // Extract the core subject (first meaningful phrase)
  const subjectMatch = cleaned.match(/^(.+?)(?:\s+(?:with|using|must|should|and|but|,|\.|\?|!))/i);

  if (subjectMatch && subjectMatch[1]) {
    return subjectMatch[1].trim();
  }

  // Fallback: use cleaned message up to punctuation
  const fallback = cleaned.split(/[.,!?]/)[0]?.trim() ?? "";
  return fallback || cleaned;
}

function extractConstraints(message: string): string[] {
  const constraints: string[] = [];

  for (const pattern of CONSTRAINT_PATTERNS) {
    const regex = new RegExp(pattern);
    let match;
    while ((match = regex.exec(message)) !== null) {
      const constraint = match[1]?.trim();
      if (constraint && constraint.length > 2 && constraint.length < 100) {
        constraints.push(constraint);
      }
    }
  }

  return [...new Set(constraints)]; // Deduplicate
}

function calculateConfidence(
  message: string,
  taskType: OvernightTaskType | undefined,
  typeConfidence: number,
  subject: string
): number {
  let confidence = 0.5; // Base confidence

  // Task type detected boosts confidence
  if (taskType) {
    confidence += 0.2 * typeConfidence;
  }

  // Subject length affects confidence
  if (subject.length >= 10 && subject.length <= 100) {
    confidence += 0.15;
  } else if (subject.length < 5) {
    confidence -= 0.2;
  }

  // Multiple overnight triggers boost confidence
  const overnightMatches = OVERNIGHT_PATTERNS.filter((p) => p.test(message)).length;
  confidence += Math.min(0.15, overnightMatches * 0.05);

  // Specific keywords boost confidence
  if (/\b(tonight|overnight)\b/i.test(message)) {
    confidence += 0.1;
  }

  // Cap at 0-1 range
  return Math.max(0, Math.min(1, confidence));
}

// ============================================
// CLARIFICATION GENERATION
// ============================================

function generateClarification(
  _message: string,
  taskType: OvernightTaskType | undefined,
  subject: string
): ClarificationPrompt {
  // Case: Can't determine task type
  if (!taskType) {
    return {
      question: `I'll work on "${subject}" tonight. What type of work?`,
      options: [
        {
          label: "Build/Code",
          value: "prototype_work",
          description: "Create 3 implementation approaches",
        },
        {
          label: "Research",
          value: "research_dive",
          description: "Deep investigation with synthesis",
        },
        {
          label: "Cancel",
          value: "cancel",
          description: "Don't queue this task",
        },
      ],
    };
  }

  // Case: Subject unclear
  if (subject.length < 5) {
    return {
      question: "What specifically should I work on?",
      options: [
        {
          label: "Describe",
          value: "describe",
          description: "Tell me more about the task",
        },
        {
          label: "Cancel",
          value: "cancel",
          description: "Don't queue this task",
        },
      ],
    };
  }

  // Case: Low confidence on interpretation
  return {
    question: `Confirm: ${taskType === "prototype_work" ? "Build" : "Research"} "${subject}"?`,
    options: [
      {
        label: "Yes",
        value: "confirm",
        description: "Proceed with this interpretation",
      },
      {
        label: "Modify",
        value: "modify",
        description: "Let me clarify what I need",
      },
      {
        label: "Cancel",
        value: "cancel",
        description: "Don't queue this task",
      },
    ],
  };
}

// ============================================
// UTILITIES
// ============================================

/**
 * Quick check if a message might be an overnight request
 * Use this for early filtering before full parsing
 */
export function mightBeOvernightRequest(message: string): boolean {
  return OVERNIGHT_PATTERNS.some((p) => p.test(message));
}

/**
 * Get display name for task type
 */
export function getTaskTypeDisplay(type: OvernightTaskType): string {
  switch (type) {
    case "prototype_work":
      return "Prototype generation";
    case "research_dive":
      return "Research deep-dive";
  }
}

/**
 * Format intent for confirmation message
 */
export function formatIntentConfirmation(intent: ParsedOvernightIntent): string {
  if (!intent.isOvernight || !intent.taskType || !intent.subject) {
    return "";
  }

  const typeDisplay = getTaskTypeDisplay(intent.taskType);
  let message = `🔨 *Overnight Task Queued*\n\n`;
  message += `*Type:* ${typeDisplay}\n`;
  message += `*Subject:* ${intent.subject}\n`;

  if (intent.taskType === "prototype_work") {
    message += `*Approaches:* 3 (Conservative, Innovative, Pragmatic)\n`;
  } else {
    message += `*Method:* Query expansion + parallel harvest + synthesis\n`;
  }

  if (intent.constraints.length > 0) {
    message += `*Constraints:* ${intent.constraints.join(", ")}\n`;
  }

  const confidence = Math.round(intent.confidence * 100);
  message += `\n_Confidence: ${confidence}%_`;

  return message;
}
