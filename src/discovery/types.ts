/**
 * Discovery Engine Types
 *
 * Core types for the proactive discovery system that finds interesting
 * things while the user sleeps.
 */

// ============================================
// DISCOVERY SOURCES
// ============================================

export type SourceType =
  | "twitter_bookmarks"   // Via Bird CLI
  | "github_trending"     // GitHub trending repos
  | "hackernews"          // HN front page
  | "rss"                 // RSS feeds
  | "email_digest";       // Future: email newsletters

export interface SourceConfig {
  type: SourceType;
  enabled: boolean;
  priority: number;          // 1-10, higher = fetch first
  maxItems: number;          // Max items per fetch
  fetchInterval?: number;    // Minutes between fetches (optional)
  options?: Record<string, unknown>;
}

// Default source configurations
export const DEFAULT_SOURCES: SourceConfig[] = [
  {
    type: "twitter_bookmarks",
    enabled: true,
    priority: 10,
    maxItems: 50,
    options: { includeThreads: true },
  },
  {
    type: "github_trending",
    enabled: true,
    priority: 9,
    maxItems: 25,
    options: { since: "daily", languages: ["python", "typescript", "rust"] },
  },
  {
    type: "hackernews",
    enabled: true,
    priority: 8,
    maxItems: 30,
    options: { minPoints: 50 },
  },
  {
    type: "rss",
    enabled: false,
    priority: 5,
    maxItems: 20,
  },
  {
    type: "email_digest",
    enabled: false,
    priority: 3,
    maxItems: 10,
  },
];

// ============================================
// RAW DISCOVERY ITEM
// ============================================

export interface RawDiscoveryItem {
  id: string;                // Unique ID (hash of url + source)
  source: SourceType;
  fetchedAt: Date;

  // Content
  title: string;
  description: string;
  url: string;
  author?: string;

  // Metadata
  metadata: {
    // Twitter-specific
    tweetId?: string;
    likeCount?: number;
    retweetCount?: number;
    bookmarkedAt?: Date;

    // GitHub-specific
    stars?: number;
    language?: string;
    topics?: string[];
    todayStars?: number;

    // HN-specific
    hnId?: number;
    points?: number;
    commentCount?: number;

    // RSS-specific
    feedName?: string;
    publishedAt?: Date;
  };

  // Raw content for scoring
  rawContent?: string;
}

// ============================================
// SCORED DISCOVERY ITEM
// ============================================

export interface RelevanceScore {
  total: number;              // 0-100 final score

  // Component scores (each 0-10)
  interestMatch: number;      // Match against me.md interests
  projectConnection: number;  // Connection to active projects
  recency: number;            // Freshness boost
  popularity: number;         // Social proof (stars, points)
  diversity: number;          // Penalty if similar to recent items

  // Scoring metadata
  matchedInterests: string[]; // Which interests matched
  connectedProjects: string[]; // Which projects connected
  scoringReason: string;      // Human-readable explanation
}

export interface ScoredDiscoveryItem extends RawDiscoveryItem {
  score: RelevanceScore;
  dedupKey: string;           // Key for deduplication
  isBlocked: boolean;         // Matches deny-history.md
  blockReason?: string;       // Why blocked
}

// ============================================
// USER CONTEXT (for scoring)
// ============================================

export interface UserContext {
  // From me.md
  interests: string[];
  goals: string[];
  techStack: string[];
  preferences: {
    boost: string[];          // Topics to boost
    deprioritize: string[];   // Topics to lower
    languages: string[];      // Programming languages
  };

  // From work.md
  activeProjects: Array<{
    name: string;
    keywords: string[];
  }>;
  careerFocus: string[];

  // From life.md
  currentFocus: string[];

  // From deny-history.md
  blocklist: {
    repos: string[];          // Specific repos to skip
    topics: string[];         // Topics to deprioritize
    languages: string[];      // Languages to skip
  };
  seenItems: Set<string>;     // Already seen IDs
}

// ============================================
// DISCOVERY PROPOSAL
// ============================================

export type ProposalStage = "idea" | "researched" | "planned" | "approved" | "archived";

export interface DiscoveryProposal {
  id: string;
  createdAt: Date;
  stage: ProposalStage;

  // Source item
  sourceItem: ScoredDiscoveryItem;

  // Generated content
  title: string;
  summary: string;            // Why this is relevant
  connectionToGoals: string;  // How it connects to user goals
  suggestedAction: string;    // What to do with it

  // Scoring
  priorityScore: number;      // Final priority (0-100)

  // Tracking
  presentedAt?: Date;
  userAction?: "approved" | "denied" | "deferred";
  userFeedback?: string;
}

// ============================================
// DISCOVERY SESSION
// ============================================

export interface DiscoverySession {
  id: string;
  startedAt: Date;
  completedAt?: Date;

  // Config
  sources: SourceType[];
  maxProposals: number;

  // Results
  itemsFetched: number;
  itemsScored: number;
  itemsBlocked: number;
  proposalsCreated: number;

  // Output
  proposals: DiscoveryProposal[];

  // Errors
  errors: Array<{
    source: SourceType;
    error: string;
  }>;
}

// ============================================
// DISCOVERY ENGINE CONFIG
// ============================================

export interface DiscoveryEngineConfig {
  // Sources
  sources: SourceConfig[];

  // Scoring thresholds
  minScoreForProposal: number;  // Minimum score to create proposal (default: 25)
  maxProposalsPerSession: number;  // Max proposals to create (default: 10)

  // Diversity settings
  maxSimilarItems: number;      // Max items from same category (default: 3)
  diversityPenalty: number;     // Score penalty for similar items (default: 5)

  // Paths
  memoryDir: string;
  ideasFile: string;
  denyHistoryFile: string;
  outputDir: string;

  // Timing
  fetchTimeout: number;         // Per-source timeout in ms
  scoringTimeout: number;       // Total scoring timeout in ms
}

export const DEFAULT_ENGINE_CONFIG: DiscoveryEngineConfig = {
  sources: DEFAULT_SOURCES,
  minScoreForProposal: 25,
  maxProposalsPerSession: 10,
  maxSimilarItems: 3,
  diversityPenalty: 5,
  memoryDir: `${process.env.HOME}/memory`,
  ideasFile: `${process.env.HOME}/memory/ideas.md`,
  denyHistoryFile: `${process.env.HOME}/memory/deny-history.md`,
  outputDir: `${process.env.HOME}/homer/discovery`,
  fetchTimeout: 60000,   // 1 minute per source
  scoringTimeout: 120000, // 2 minutes total scoring
};

// ============================================
// SOURCE ADAPTER INTERFACE
// ============================================

export interface SourceAdapter {
  readonly type: SourceType;
  readonly name: string;

  /**
   * Check if the source is available (credentials, API, etc.)
   */
  isAvailable(): Promise<boolean>;

  /**
   * Fetch items from the source
   */
  fetch(config: SourceConfig): Promise<RawDiscoveryItem[]>;
}

// ============================================
// SCORING WEIGHTS
// ============================================

export interface ScoringWeights {
  interestMatch: number;    // Default: 3.0
  projectConnection: number; // Default: 2.5
  recency: number;          // Default: 1.5
  popularity: number;       // Default: 1.0
  diversity: number;        // Default: -1.0 (penalty)
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  interestMatch: 3.0,
  projectConnection: 2.5,
  recency: 1.5,
  popularity: 1.0,
  diversity: -1.0,
};
