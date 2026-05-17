/**
 * Semantic Fingerprinting for idea deduplication
 * Extracts key terms and creates comparable fingerprints from titles
 */

const STOPWORDS = new Set([
  // Articles & common words
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "for", "of", "to", "in", "on", "at", "by", "with", "from", "as",
  "all", "one", "new", "your", "how", "and", "or", "but", "not",
  "this", "that", "these", "those", "it", "its",
  // Tech title common words (filter for comparison, not display)
  "framework", "library", "tool", "tools", "app", "application", "system",
  "project", "repo", "repository", "open", "source", "opensource",
  "based", "using", "powered", "built", "made", "create", "creating",
  "use", "used", "way", "best", "better", "simple", "easy", "fast",
  "modern", "next", "gen", "generation", "advanced", "smart",
]);

export interface Fingerprint {
  tokens: string[];           // Normalized key terms (sorted)
  primaryEntity: string;      // First significant term (usually project name)
  hash: string;               // Quick comparison hash
}

/**
 * Create a fingerprint from an idea title
 */
export function createFingerprint(title: string): Fingerprint {
  if (!title || typeof title !== "string") {
    return { tokens: [], primaryEntity: "", hash: "" };
  }

  // 1. Normalize: lowercase, replace separators with spaces
  const normalized = title
    .toLowerCase()
    .replace(/[:\-–—|\/\\]/g, " ")  // Treat separators as spaces
    .replace(/[^a-z0-9\s]/g, "")    // Remove punctuation
    .replace(/\s+/g, " ")           // Collapse whitespace
    .trim();

  // 2. Tokenize and filter stopwords + short tokens
  const tokens = normalized
    .split(" ")
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    .sort();  // Sort for consistent comparison

  // 3. Extract primary entity (usually the project name)
  // Look for first capitalized word in original title
  const originalWords = title.split(/[\s:\-–—|\/\\]+/);
  const primaryEntity = originalWords
    .find((w) => /^[A-Z]/.test(w) && w.length > 2 && !STOPWORDS.has(w.toLowerCase()))
    || tokens[0]
    || "";

  // 4. Create hash for quick comparison (first 5 significant tokens)
  const hash = tokens.slice(0, 5).join("|");

  return {
    tokens,
    primaryEntity: primaryEntity.toLowerCase(),
    hash,
  };
}

/**
 * Calculate Jaccard similarity between two token sets
 */
function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  const setA = new Set(a);
  const setB = new Set(b);

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Calculate similarity between two fingerprints
 * Returns a score between 0 and 1
 */
export function fingerprintSimilarity(a: Fingerprint, b: Fingerprint): number {
  // Quick rejection: different primary entities with sufficient length
  // likely means different projects
  if (
    a.primaryEntity !== b.primaryEntity &&
    a.primaryEntity.length > 3 &&
    b.primaryEntity.length > 3
  ) {
    // Still calculate Jaccard but weight it down
    const jaccard = jaccardSimilarity(a.tokens, b.tokens);
    return jaccard * 0.7;  // Penalize different primary entities
  }

  // Same primary entity or one is too short: use full Jaccard
  return jaccardSimilarity(a.tokens, b.tokens);
}

