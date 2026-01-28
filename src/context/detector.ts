import { existsSync, readdirSync } from "fs";
import { logger } from "../utils/logger.js";

/**
 * Detected context from query analysis
 */
export interface DetectedContext {
  type: "work" | "life" | "general";
  confidence: number; // 0-1 scale
  suggestedCwd: string;
  project?: string; // detected project name for work
  area?: string; // detected life area
}

/**
 * Signal pattern for context detection
 */
interface SignalPattern {
  pattern: RegExp;
  weight: number;
  capture?: "project" | "area"; // which group to capture
}

// Work context signals - things that indicate work-related queries
const WORK_SIGNALS: SignalPattern[] = [
  // Technical terms
  { pattern: /\b(code|coding|debug|bug|fix|error|exception)\b/i, weight: 2 },
  { pattern: /\b(deploy|deployment|release|ship|production)\b/i, weight: 2 },
  { pattern: /\b(api|endpoint|server|database|db|query)\b/i, weight: 2 },
  { pattern: /\b(test|testing|spec|coverage|ci|cd)\b/i, weight: 2 },
  { pattern: /\b(pr|pull request|commit|push|merge|branch|git)\b/i, weight: 2 },
  { pattern: /\b(refactor|optimize|performance|memory leak)\b/i, weight: 2 },
  { pattern: /\b(frontend|backend|fullstack|devops|infra)\b/i, weight: 2 },
  { pattern: /\b(typescript|javascript|python|rust|go|java)\b/i, weight: 1.5 },
  { pattern: /\b(react|vue|angular|node|express|fastify)\b/i, weight: 1.5 },
  { pattern: /\b(docker|kubernetes|aws|gcp|azure)\b/i, weight: 1.5 },

  // Work communication
  { pattern: /\b(meeting|standup|retro|sprint|backlog)\b/i, weight: 2 },
  { pattern: /\b(jira|slack|notion|confluence|linear)\b/i, weight: 2 },
  { pattern: /\b(client|stakeholder|product|feature|requirement)\b/i, weight: 1.5 },
  { pattern: /\b(deadline|milestone|roadmap|estimate)\b/i, weight: 1.5 },

  // Project references - high confidence
  { pattern: /\bproject[- ]?([a-zA-Z0-9_-]+)\b/i, weight: 3, capture: "project" },
  { pattern: /\b(?:in|on|for)\s+([a-zA-Z0-9_-]+)\s+(?:repo|project|codebase)\b/i, weight: 3, capture: "project" },

  // Path references
  { pattern: /~\/work\//i, weight: 5 },
  { pattern: /\/Users\/yj\/work\//i, weight: 5 },
];

// Life context signals - personal, health, family, finance
const LIFE_SIGNALS: SignalPattern[] = [
  // Health & fitness
  { pattern: /\b(health|workout|exercise|gym|run|running)\b/i, weight: 2 },
  { pattern: /\b(diet|nutrition|calories|weight|sleep)\b/i, weight: 2 },
  { pattern: /\b(meditation|mindfulness|mental health|therapy)\b/i, weight: 2 },
  { pattern: /\b(doctor|dentist|appointment|checkup|prescription)\b/i, weight: 2 },

  // Family & relationships
  { pattern: /\b(family|mom|dad|wife|husband|kids|children|parents)\b/i, weight: 2 },
  { pattern: /\b(friends|social|party|gathering|dinner)\b/i, weight: 1.5 },
  { pattern: /\b(birthday|anniversary|wedding|holiday)\b/i, weight: 2 },

  // Finance & home
  { pattern: /\b(finance|budget|savings|investment|401k|ira)\b/i, weight: 2 },
  { pattern: /\b(bank|credit|debt|mortgage|rent|bills)\b/i, weight: 2 },
  { pattern: /\b(house|apartment|furniture|repair|maintenance)\b/i, weight: 1.5 },
  { pattern: /\b(grocery|shopping|amazon|order)\b/i, weight: 1 },

  // Travel & leisure
  { pattern: /\b(vacation|travel|trip|flight|hotel|booking)\b/i, weight: 2 },
  { pattern: /\b(hobby|hobby|reading|book|movie|game|music)\b/i, weight: 1.5 },

  // Life area references
  { pattern: /\b(?:in|for)\s+(health|finance|family)\b/i, weight: 3, capture: "area" },

  // Path references
  { pattern: /~\/life\//i, weight: 5 },
  { pattern: /\/Users\/yj\/life\//i, weight: 5 },
];

// Context paths
const CONTEXT_PATHS = {
  work: "/Users/yj/work",
  life: "/Users/yj/life",
  general: "/Users/yj",
} as const;

// Confidence threshold - below this, return general context
// With alternation patterns, single matches give 2/8 = 0.25
const CONFIDENCE_THRESHOLD = 0.2;

// Max score for normalization (roughly: 2-3 strong signals)
const MAX_EXPECTED_SCORE = 8;

/**
 * Find existing projects in ~/work directory
 */
function getExistingProjects(): Set<string> {
  const workPath = CONTEXT_PATHS.work;
  try {
    if (!existsSync(workPath)) return new Set();
    const entries = readdirSync(workPath, { withFileTypes: true });
    return new Set(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name.toLowerCase())
    );
  } catch {
    return new Set();
  }
}

/**
 * Find existing life areas in ~/life directory
 */
function getExistingAreas(): Set<string> {
  const lifePath = CONTEXT_PATHS.life;
  try {
    if (!existsSync(lifePath)) return new Set();
    const entries = readdirSync(lifePath, { withFileTypes: true });
    return new Set(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name.toLowerCase())
    );
  } catch {
    return new Set();
  }
}

/**
 * Calculate score for a set of signals against query
 */
function calculateScore(
  query: string,
  signals: SignalPattern[],
  existingNames: Set<string>
): { score: number; captured?: string } {
  let score = 0;
  let captured: string | undefined;

  for (const signal of signals) {
    const match = query.match(signal.pattern);
    if (match) {
      score += signal.weight;

      // Capture project/area name if pattern specifies
      if (signal.capture && match[1]) {
        const name = match[1].toLowerCase();
        // Boost score if the captured name exists as a directory
        if (existingNames.has(name)) {
          score += 2;
          captured = match[1];
        }
      }
    }
  }

  return { score, captured };
}

/**
 * Check if query mentions a known project name directly
 */
function findMentionedProject(query: string, projects: Set<string>): string | undefined {
  const words = query.toLowerCase().split(/\s+/);
  for (const word of words) {
    // Clean punctuation
    const clean = word.replace(/[^a-z0-9_-]/g, "");
    if (clean && projects.has(clean)) {
      return clean;
    }
  }
  return undefined;
}

/**
 * Detect context from query text using weighted keyword scoring
 *
 * @param query - The user's query text
 * @returns DetectedContext with type, confidence, and suggested cwd
 */
export function detectContext(query: string): DetectedContext {
  const projects = getExistingProjects();
  const areas = getExistingAreas();

  // Calculate scores
  const workResult = calculateScore(query, WORK_SIGNALS, projects);
  const lifeResult = calculateScore(query, LIFE_SIGNALS, areas);

  // Check for direct project mention
  const mentionedProject = findMentionedProject(query, projects);
  if (mentionedProject && !workResult.captured) {
    workResult.score += 3;
  }

  // Normalize scores to confidence
  // Confidence is based on how strong the signal is relative to expected max
  const workConfidence = workResult.score / MAX_EXPECTED_SCORE;
  const lifeConfidence = lifeResult.score / MAX_EXPECTED_SCORE;

  logger.debug(
    {
      query: query.slice(0, 50),
      workScore: workResult.score,
      lifeScore: lifeResult.score,
      workConfidence,
      lifeConfidence,
      mentionedProject,
    },
    "Context detection scores"
  );

  // Determine winner
  if (workResult.score > lifeResult.score && workConfidence >= CONFIDENCE_THRESHOLD) {
    const project = workResult.captured || mentionedProject;
    const baseCwd = CONTEXT_PATHS.work;
    const suggestedCwd = project ? `${baseCwd}/${project}` : baseCwd;

    // Verify cwd exists, fall back to work root
    const finalCwd = existsSync(suggestedCwd) ? suggestedCwd : baseCwd;

    return {
      type: "work",
      confidence: Math.min(workConfidence, 1),
      suggestedCwd: finalCwd,
      project,
    };
  }

  if (lifeResult.score > workResult.score && lifeConfidence >= CONFIDENCE_THRESHOLD) {
    const area = lifeResult.captured;
    const baseCwd = CONTEXT_PATHS.life;
    const suggestedCwd = area ? `${baseCwd}/${area}` : baseCwd;

    const finalCwd = existsSync(suggestedCwd) ? suggestedCwd : baseCwd;

    return {
      type: "life",
      confidence: Math.min(lifeConfidence, 1),
      suggestedCwd: finalCwd,
      area,
    };
  }

  // Default to general context
  return {
    type: "general",
    confidence: 1 - Math.max(workConfidence, lifeConfidence),
    suggestedCwd: CONTEXT_PATHS.general,
  };
}

/**
 * Map detected context type to memory context string
 */
export function contextTypeToMemoryContext(type: "work" | "life" | "general"): string {
  return type === "general" ? "default" : type;
}
