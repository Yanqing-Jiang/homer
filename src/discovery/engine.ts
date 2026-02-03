/**
 * Discovery Engine
 *
 * Main orchestrator for proactive discovery.
 * Fetches from sources, scores relevance, deduplicates, and creates proposals.
 */

import { randomUUID } from "crypto";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type Database from "better-sqlite3";
import type {
  DiscoveryEngineConfig,
  DiscoverySession,
  DiscoveryProposal,
  RawDiscoveryItem,
  ScoredDiscoveryItem,
  UserContext,
  SourceType,
} from "./types.js";
import { DEFAULT_ENGINE_CONFIG } from "./types.js";
import { loadUserContext } from "./context-loader.js";
import { createAdapters, checkAvailability } from "./adapters/index.js";
import { RelevanceScorer } from "./scorer.js";
import { Deduplicator } from "./dedup.js";
import { persistDiscoveryResults, type PersistenceResult } from "./persist.js";

// ============================================
// DISCOVERY ENGINE
// ============================================

export class DiscoveryEngine {
  private config: DiscoveryEngineConfig;
  private context: UserContext | null = null;
  private deduplicator: Deduplicator;
  private isRunning = false;
  private db: Database.Database | null = null;

  constructor(config: Partial<DiscoveryEngineConfig> = {}, db?: Database.Database) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
    this.deduplicator = new Deduplicator(
      join(this.config.outputDir, "dedup-state.json")
    );
    this.db = db ?? null;
  }

  // ============================================
  // MAIN ENTRY POINT
  // ============================================

  async discover(): Promise<DiscoverySession> {
    if (this.isRunning) {
      throw new Error("Discovery engine is already running");
    }

    this.isRunning = true;

    // Initialize session
    const session: DiscoverySession = {
      id: `disc_${randomUUID().slice(0, 8)}`,
      startedAt: new Date(),
      sources: [],
      maxProposals: this.config.maxProposalsPerSession,
      itemsFetched: 0,
      itemsScored: 0,
      itemsBlocked: 0,
      proposalsCreated: 0,
      proposals: [],
      errors: [],
    };

    try {
      // Ensure output directory exists
      await this.ensureOutputDir();

      // Load user context
      this.context = await loadUserContext(this.config);

      // Load dedup state
      await this.deduplicator.load();

      // Check source availability
      const availability = await checkAvailability(this.config.sources);

      // Fetch from all available sources
      const items = await this.fetchAllSources(session, availability);
      session.itemsFetched = items.length;

      if (items.length === 0) {
        console.log("No items fetched from any source");
        return this.finishSession(session);
      }

      // Score all items
      const scorer = new RelevanceScorer(this.context);
      const scoredItems = scorer.scoreItems(items);
      session.itemsScored = scoredItems.length;

      // Count blocked items
      session.itemsBlocked = scoredItems.filter(i => i.isBlocked).length;

      // Deduplicate
      const uniqueItems = this.deduplicator.deduplicate(scoredItems);

      // Filter by minimum score
      const qualifiedItems = uniqueItems.filter(
        item => item.score.total >= this.config.minScoreForProposal
      );

      // Apply diversity limits
      const diverseItems = this.applyDiversityLimits(qualifiedItems);

      // Create proposals for top items
      const proposals = await this.createProposals(
        diverseItems.slice(0, this.config.maxProposalsPerSession)
      );
      session.proposals = proposals;
      session.proposalsCreated = proposals.length;

      // Save dedup state
      await this.deduplicator.save();

      // Save proposals to ideas.md (audit log)
      if (proposals.length > 0) {
        await this.appendToIdeas(proposals);
      }

      // Persist to database for approval workflow
      let persistResult: PersistenceResult | null = null;
      if (proposals.length > 0 && this.db) {
        persistResult = persistDiscoveryResults(proposals, this.db);
        console.log(`Persisted ${persistResult.inserted} proposals to DB (${persistResult.skipped} duplicates skipped)`);
        if (persistResult.highPriority.length > 0) {
          console.log(`${persistResult.highPriority.length} high-priority proposals ready for notification`);
        }
      }

      return this.finishSession(session);

    } catch (error) {
      session.errors.push({
        source: "engine" as SourceType,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.finishSession(session);
    } finally {
      this.isRunning = false;
    }
  }

  // ============================================
  // SOURCE FETCHING
  // ============================================

  private async fetchAllSources(
    session: DiscoverySession,
    availability: Map<SourceType, boolean>
  ): Promise<RawDiscoveryItem[]> {
    const allItems: RawDiscoveryItem[] = [];
    const adapters = createAdapters(this.config.sources);

    // Sort sources by priority
    const sortedSources = [...this.config.sources]
      .filter(s => s.enabled && availability.get(s.type))
      .sort((a, b) => b.priority - a.priority);

    // Fetch from each source
    for (const sourceConfig of sortedSources) {
      const adapter = adapters.get(sourceConfig.type);
      if (!adapter) continue;

      session.sources.push(sourceConfig.type);

      try {
        const items = await Promise.race([
          adapter.fetch(sourceConfig),
          this.timeout(this.config.fetchTimeout),
        ]) as RawDiscoveryItem[];

        allItems.push(...items);
        console.log(`Fetched ${items.length} items from ${sourceConfig.type}`);

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        session.errors.push({ source: sourceConfig.type, error: errorMsg });
        console.error(`Error fetching from ${sourceConfig.type}: ${errorMsg}`);
      }
    }

    return allItems;
  }

  // ============================================
  // DIVERSITY LIMITS
  // ============================================

  private applyDiversityLimits(items: ScoredDiscoveryItem[]): ScoredDiscoveryItem[] {
    const result: ScoredDiscoveryItem[] = [];
    const categoryCount = new Map<string, number>();

    for (const item of items) {
      // Get category from dedupKey
      const category = item.dedupKey.split(":")[0] ?? "unknown"; // Use source as category

      const count = categoryCount.get(category) || 0;
      if (count >= this.config.maxSimilarItems) {
        continue;
      }

      result.push(item);
      categoryCount.set(category, count + 1);
    }

    return result;
  }

  // ============================================
  // PROPOSAL CREATION
  // ============================================

  private async createProposals(
    items: ScoredDiscoveryItem[]
  ): Promise<DiscoveryProposal[]> {
    const proposals: DiscoveryProposal[] = [];

    for (const item of items) {
      const proposal = this.createProposal(item);
      proposals.push(proposal);
      this.deduplicator.markProposalCreated(item.url);
    }

    return proposals;
  }

  private createProposal(item: ScoredDiscoveryItem): DiscoveryProposal {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 12);

    return {
      id: `${timestamp}_${item.id.slice(0, 6)}`,
      createdAt: now,
      stage: "idea",
      sourceItem: item,
      title: this.generateProposalTitle(item),
      summary: this.generateSummary(item),
      connectionToGoals: this.generateGoalConnection(item),
      suggestedAction: this.generateSuggestedAction(item),
      priorityScore: item.score.total,
    };
  }

  private generateProposalTitle(item: ScoredDiscoveryItem): string {
    // Extract meaningful title from item
    if (item.source === "github_trending") {
      // Format: "RepoName: Short description"
      const repoName = item.url.split("github.com/")[1] || item.title;
      return item.title.length > 100
        ? `${repoName.split("/").pop()}: ${item.description.slice(0, 80)}...`
        : item.title;
    }

    return item.title.slice(0, 120);
  }

  private generateSummary(item: ScoredDiscoveryItem): string {
    const parts: string[] = [];

    // Source and metadata
    parts.push(`**Source:** ${item.source}`);

    if (item.metadata.stars) {
      parts.push(`**Stars:** ${item.metadata.stars.toLocaleString()}`);
    }
    if (item.metadata.points) {
      parts.push(`**Points:** ${item.metadata.points}`);
    }
    if (item.metadata.language) {
      parts.push(`**Language:** ${item.metadata.language}`);
    }

    // Relevance info
    if (item.score.matchedInterests.length > 0) {
      parts.push(`**Matched interests:** ${item.score.matchedInterests.slice(0, 3).join(", ")}`);
    }

    return parts.join("\n");
  }

  private generateGoalConnection(item: ScoredDiscoveryItem): string {
    if (!this.context) return "Unable to determine goal connection";

    const connections: string[] = [];

    // Check connected projects
    if (item.score.connectedProjects.length > 0) {
      connections.push(`Connects to: ${item.score.connectedProjects.join(", ")}`);
    }

    // Match against specific goals
    const searchText = `${item.title} ${item.description}`.toLowerCase();

    if (searchText.includes("side income") || searchText.includes("monetization") || searchText.includes("revenue")) {
      connections.push("Supports side income goal");
    }
    if (searchText.includes("analytics") || searchText.includes("dashboard") || searchText.includes("data")) {
      connections.push("Aligns with analytics expertise");
    }
    if (searchText.includes("automation") || searchText.includes("agent") || searchText.includes("workflow")) {
      connections.push("Supports automation/throughput goals");
    }
    if (searchText.includes("ai") || searchText.includes("llm") || searchText.includes("gpt") || searchText.includes("claude")) {
      connections.push("Relevant to AI expertise");
    }

    return connections.join("; ") || "General interest alignment";
  }

  private generateSuggestedAction(item: ScoredDiscoveryItem): string {
    const score = item.score.total;

    if (score >= 40) {
      return "High relevance - Consider exploring today";
    } else if (score >= 30) {
      return "Worth reviewing - Add to research queue";
    } else {
      return "Note for reference - May be useful later";
    }
  }

  // ============================================
  // IDEAS.MD INTEGRATION
  // ============================================

  private async appendToIdeas(proposals: DiscoveryProposal[]): Promise<void> {
    const ideasPath = this.config.ideasFile;

    // Read current content
    let content = "";
    if (existsSync(ideasPath)) {
      const { readFile } = await import("fs/promises");
      content = await readFile(ideasPath, "utf-8");
    }

    // Find insertion point (after "## Draft Ideas" header)
    const insertMarker = "## Draft Ideas";
    const insertIndex = content.indexOf(insertMarker);

    if (insertIndex === -1) {
      // Add header if not present
      content += `\n\n${insertMarker}\n\n`;
    }

    // Build new entries
    const newEntries = proposals.map(p => this.formatProposalForIdeas(p)).join("\n\n");

    // Insert after header
    const headerEnd = content.indexOf("\n", insertIndex + insertMarker.length);
    const beforeInsert = content.slice(0, headerEnd + 1);
    const afterInsert = content.slice(headerEnd + 1);

    const updatedContent = `${beforeInsert}\n${newEntries}\n${afterInsert}`;

    await writeFile(ideasPath, updatedContent);
  }

  private formatProposalForIdeas(proposal: DiscoveryProposal): string {
    const timestamp = proposal.createdAt.toISOString().slice(0, 16).replace("T", " ");
    const item = proposal.sourceItem;

    return `### [${timestamp}] ${proposal.title}
- **ID:** ${proposal.id}
- **Source:** ${item.source}
- **Status:** draft
- **Content:** ${item.description.slice(0, 300)}
- **Context:** ${proposal.connectionToGoals}
- **Link:** ${item.url}`;
  }

  // ============================================
  // SESSION MANAGEMENT
  // ============================================

  private async ensureOutputDir(): Promise<void> {
    if (!existsSync(this.config.outputDir)) {
      await mkdir(this.config.outputDir, { recursive: true });
    }
  }

  private finishSession(session: DiscoverySession): DiscoverySession {
    session.completedAt = new Date();

    // Log summary
    console.log(`
Discovery session ${session.id} completed:
- Sources: ${session.sources.join(", ")}
- Items fetched: ${session.itemsFetched}
- Items blocked: ${session.itemsBlocked}
- Proposals created: ${session.proposalsCreated}
- Errors: ${session.errors.length}
    `.trim());

    return session;
  }

  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), ms)
    );
  }

  // ============================================
  // STATUS
  // ============================================

  getStatus(): { isRunning: boolean; dedupStats: ReturnType<Deduplicator["getStats"]> } {
    return {
      isRunning: this.isRunning,
      dedupStats: this.deduplicator.getStats(),
    };
  }
}

// ============================================
// EXPORTS
// ============================================

export type { DiscoverySession, DiscoveryProposal };
