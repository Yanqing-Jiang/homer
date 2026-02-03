/**
 * Relevance Scorer
 *
 * Scores discovery items against user context for relevance.
 * Uses a multi-factor scoring algorithm with configurable weights.
 */

import type {
  RawDiscoveryItem,
  ScoredDiscoveryItem,
  RelevanceScore,
  UserContext,
  ScoringWeights,
} from "./types.js";
import { DEFAULT_SCORING_WEIGHTS } from "./types.js";

// ============================================
// SCORER CLASS
// ============================================

export class RelevanceScorer {
  private context: UserContext;
  private weights: ScoringWeights;
  private recentItems: Map<string, number> = new Map(); // dedupKey -> count

  constructor(
    context: UserContext,
    weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
  ) {
    this.context = context;
    this.weights = weights;
  }

  /**
   * Score a batch of items
   */
  scoreItems(items: RawDiscoveryItem[]): ScoredDiscoveryItem[] {
    // Reset recent items tracking for diversity scoring
    this.recentItems.clear();

    return items
      .map(item => this.scoreItem(item))
      .sort((a, b) => b.score.total - a.score.total);
  }

  /**
   * Score a single item
   */
  scoreItem(item: RawDiscoveryItem): ScoredDiscoveryItem {
    // Check blocklist first
    const blockResult = this.checkBlocklist(item);
    if (blockResult.blocked) {
      return {
        ...item,
        score: this.createZeroScore(blockResult.reason),
        dedupKey: this.generateDedupKey(item),
        isBlocked: true,
        blockReason: blockResult.reason,
      };
    }

    // Calculate component scores
    const interestScore = this.scoreInterestMatch(item);
    const projectScore = this.scoreProjectConnection(item);
    const recencyScore = this.scoreRecency(item);
    const popularityScore = this.scorePopularity(item);
    const diversityScore = this.scoreDiversity(item);

    // Calculate weighted total
    const total = Math.min(100, Math.max(0,
      interestScore.score * this.weights.interestMatch +
      projectScore.score * this.weights.projectConnection +
      recencyScore.score * this.weights.recency +
      popularityScore.score * this.weights.popularity +
      diversityScore.score * this.weights.diversity // Note: diversity weight is negative
    ));

    const score: RelevanceScore = {
      total: Math.round(total),
      interestMatch: interestScore.score,
      projectConnection: projectScore.score,
      recency: recencyScore.score,
      popularity: popularityScore.score,
      diversity: diversityScore.score,
      matchedInterests: interestScore.matched,
      connectedProjects: projectScore.matched,
      scoringReason: this.buildScoringReason(
        interestScore,
        projectScore,
        recencyScore,
        popularityScore,
        diversityScore
      ),
    };

    const dedupKey = this.generateDedupKey(item);

    // Track for diversity scoring
    this.trackForDiversity(dedupKey);

    return {
      ...item,
      score,
      dedupKey,
      isBlocked: false,
    };
  }

  // ============================================
  // BLOCKLIST CHECKING
  // ============================================

  private checkBlocklist(item: RawDiscoveryItem): { blocked: boolean; reason?: string } {
    const { blocklist } = this.context;
    const searchText = `${item.title} ${item.description} ${item.url}`.toLowerCase();

    // Check repo blocklist (for GitHub items)
    if (item.source === "github_trending") {
      const repoName = item.url.split("github.com/")[1]?.toLowerCase();
      if (repoName) {
        for (const blocked of blocklist.repos) {
          if (repoName.includes(blocked) || blocked.includes(repoName.split("/").pop() || "")) {
            return { blocked: true, reason: `Repo "${blocked}" is in blocklist` };
          }
        }
      }

      // Check language blocklist
      const lang = item.metadata.language?.toLowerCase();
      if (lang && blocklist.languages.includes(lang)) {
        return { blocked: true, reason: `Language "${lang}" is deprioritized` };
      }
    }

    // Check topic blocklist
    for (const topic of blocklist.topics) {
      if (searchText.includes(topic.toLowerCase())) {
        return { blocked: true, reason: `Topic "${topic}" is deprioritized` };
      }
    }

    // Check seen items
    if (this.context.seenItems.has(item.id)) {
      return { blocked: true, reason: "Already seen" };
    }

    return { blocked: false };
  }

  // ============================================
  // INTEREST MATCHING
  // ============================================

  private scoreInterestMatch(item: RawDiscoveryItem): { score: number; matched: string[] } {
    const searchText = `${item.title} ${item.description}`.toLowerCase();
    const matched: string[] = [];

    // Check against user interests
    for (const interest of this.context.interests) {
      const keywords = interest.split(/[,\s]+/).filter(k => k.length > 2);
      for (const keyword of keywords) {
        if (searchText.includes(keyword.toLowerCase())) {
          matched.push(interest);
          break;
        }
      }
    }

    // Check against boost patterns
    for (const boost of this.context.preferences.boost) {
      const keywords = boost.split(/[,\s]+/).filter(k => k.length > 2);
      for (const keyword of keywords) {
        if (searchText.includes(keyword.toLowerCase())) {
          matched.push(`boost:${boost}`);
          break;
        }
      }
    }

    // Check against goals
    for (const goal of this.context.goals) {
      const keywords = this.extractSignificantWords(goal);
      for (const keyword of keywords) {
        if (searchText.includes(keyword.toLowerCase())) {
          matched.push(`goal:${goal.slice(0, 30)}`);
          break;
        }
      }
    }

    // Score: 0-10 based on number of matches (diminishing returns)
    const score = Math.min(10, matched.length * 2.5);

    return { score, matched: [...new Set(matched)] };
  }

  // ============================================
  // PROJECT CONNECTION
  // ============================================

  private scoreProjectConnection(item: RawDiscoveryItem): { score: number; matched: string[] } {
    const searchText = `${item.title} ${item.description}`.toLowerCase();
    const matched: string[] = [];

    for (const project of this.context.activeProjects) {
      const projectNameMatch = searchText.includes(project.name.toLowerCase());
      const keywordMatches = project.keywords.filter(k =>
        searchText.includes(k.toLowerCase())
      );

      if (projectNameMatch || keywordMatches.length >= 2) {
        matched.push(project.name);
      }
    }

    // Check career focus
    for (const focus of this.context.careerFocus) {
      const keywords = this.extractSignificantWords(focus);
      const matchCount = keywords.filter(k => searchText.includes(k.toLowerCase())).length;
      if (matchCount >= 2) {
        matched.push(`career:${focus.slice(0, 30)}`);
      }
    }

    // Score: 0-10 based on connections
    const score = Math.min(10, matched.length * 3);

    return { score, matched: [...new Set(matched)] };
  }

  // ============================================
  // RECENCY SCORING
  // ============================================

  private scoreRecency(item: RawDiscoveryItem): { score: number; matched: string[] } {
    const now = Date.now();
    let itemTime: number;

    // Determine item timestamp
    if (item.metadata.publishedAt) {
      itemTime = item.metadata.publishedAt.getTime();
    } else if (item.metadata.bookmarkedAt) {
      itemTime = item.metadata.bookmarkedAt.getTime();
    } else {
      itemTime = item.fetchedAt.getTime();
    }

    const ageHours = (now - itemTime) / (1000 * 60 * 60);

    // Score: 10 for < 6 hours, linear decay to 0 at 168 hours (1 week)
    let score: number;
    if (ageHours < 6) {
      score = 10;
    } else if (ageHours < 24) {
      score = 8;
    } else if (ageHours < 48) {
      score = 6;
    } else if (ageHours < 168) {
      score = Math.max(0, 6 - (ageHours - 48) / 20);
    } else {
      score = 0;
    }

    const ageLabel = ageHours < 24 ? `${Math.round(ageHours)}h old` : `${Math.round(ageHours / 24)}d old`;

    return { score, matched: [ageLabel] };
  }

  // ============================================
  // POPULARITY SCORING
  // ============================================

  private scorePopularity(item: RawDiscoveryItem): { score: number; matched: string[] } {
    const matched: string[] = [];
    let score = 5; // Default middle score

    // GitHub stars
    if (item.metadata.stars !== undefined) {
      const stars = item.metadata.stars;
      if (stars >= 10000) score = 10;
      else if (stars >= 5000) score = 9;
      else if (stars >= 1000) score = 8;
      else if (stars >= 500) score = 7;
      else if (stars >= 100) score = 6;
      else score = 5;
      matched.push(`${stars.toLocaleString()} stars`);
    }

    // HN points
    if (item.metadata.points !== undefined) {
      const points = item.metadata.points;
      if (points >= 500) score = 10;
      else if (points >= 300) score = 9;
      else if (points >= 200) score = 8;
      else if (points >= 100) score = 7;
      else if (points >= 50) score = 6;
      else score = 5;
      matched.push(`${points} points`);
    }

    // Twitter engagement
    if (item.metadata.likeCount !== undefined || item.metadata.retweetCount !== undefined) {
      const engagement = (item.metadata.likeCount || 0) + (item.metadata.retweetCount || 0) * 2;
      if (engagement >= 1000) score = 10;
      else if (engagement >= 500) score = 9;
      else if (engagement >= 200) score = 8;
      else if (engagement >= 100) score = 7;
      else if (engagement >= 50) score = 6;
      else score = 5;
      matched.push(`${engagement} engagement`);
    }

    return { score, matched };
  }

  // ============================================
  // DIVERSITY SCORING
  // ============================================

  private scoreDiversity(item: RawDiscoveryItem): { score: number; matched: string[] } {
    const dedupKey = this.generateDedupKey(item);
    const count = this.recentItems.get(dedupKey) || 0;

    // Score is a penalty (0 = no penalty, higher = more penalty)
    // Weight is negative, so higher score here means lower total score
    const score = Math.min(10, count * 3);

    return {
      score,
      matched: count > 0 ? [`${count} similar items`] : [],
    };
  }

  // ============================================
  // HELPERS
  // ============================================

  private generateDedupKey(item: RawDiscoveryItem): string {
    // Create a category key for diversity tracking
    const parts: string[] = [item.source];

    // Add language/topic for grouping
    if (item.metadata.language) {
      parts.push(item.metadata.language.toLowerCase());
    }
    if (item.metadata.topics?.length && item.metadata.topics[0]) {
      parts.push(item.metadata.topics[0].toLowerCase());
    }

    // For GitHub, group by org
    if (item.source === "github_trending") {
      const org = item.url.split("github.com/")[1]?.split("/")[0];
      if (org) parts.push(org.toLowerCase());
    }

    return parts.join(":");
  }

  private trackForDiversity(dedupKey: string): void {
    const current = this.recentItems.get(dedupKey) || 0;
    this.recentItems.set(dedupKey, current + 1);
  }

  private extractSignificantWords(text: string): string[] {
    const stopWords = new Set([
      "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
      "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
      "being", "have", "has", "had", "do", "does", "did", "will", "would",
      "could", "should", "may", "might", "must", "shall", "can", "need",
      "that", "this", "these", "those", "it", "its", "i", "you", "he", "she",
      "we", "they", "my", "your", "his", "her", "our", "their", "what", "which",
      "who", "when", "where", "why", "how", "all", "each", "every", "both",
      "few", "more", "most", "other", "some", "such", "no", "nor", "not",
      "only", "own", "same", "so", "than", "too", "very", "just", "also",
    ]);

    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(word => word.length > 3 && !stopWords.has(word));
  }

  private createZeroScore(reason?: string): RelevanceScore {
    return {
      total: 0,
      interestMatch: 0,
      projectConnection: 0,
      recency: 0,
      popularity: 0,
      diversity: 0,
      matchedInterests: [],
      connectedProjects: [],
      scoringReason: reason ? `Blocked: ${reason}` : "Blocked",
    };
  }

  private buildScoringReason(
    interest: { score: number; matched: string[] },
    project: { score: number; matched: string[] },
    _recency: { score: number; matched: string[] },
    popularity: { score: number; matched: string[] },
    diversity: { score: number; matched: string[] }
  ): string {
    const parts: string[] = [];

    if (interest.matched.length > 0) {
      parts.push(`Interests: ${interest.matched.slice(0, 3).join(", ")}`);
    }
    if (project.matched.length > 0) {
      parts.push(`Projects: ${project.matched.slice(0, 2).join(", ")}`);
    }
    if (popularity.matched.length > 0 && popularity.matched[0]) {
      parts.push(popularity.matched[0]);
    }
    if (diversity.score > 0) {
      parts.push(`-${diversity.score} diversity penalty`);
    }

    return parts.join(" | ") || "No specific matches";
  }
}

// ============================================
// CONVENIENCE FUNCTIONS
// ============================================

export function scoreItems(
  items: RawDiscoveryItem[],
  context: UserContext,
  weights?: ScoringWeights
): ScoredDiscoveryItem[] {
  const scorer = new RelevanceScorer(context, weights);
  return scorer.scoreItems(items);
}
