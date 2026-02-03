/**
 * Night Mode Types
 *
 * Defines the job system, risk levels, and approval states for
 * the autonomous night supervisor.
 */

// ============================================
// RISK & APPROVAL
// ============================================

export type RiskLevel = "low" | "medium" | "high";

export type ApprovalLevel = "green" | "yellow" | "red";

export type JobStatus = "pending" | "running" | "completed" | "failed" | "blocked" | "approved" | "rejected";

// Mapping of risk to approval requirements
export const RISK_TO_APPROVAL: Record<RiskLevel, ApprovalLevel> = {
  low: "green",      // Auto-execute
  medium: "yellow",  // Execute + notify
  high: "red",       // Propose only, require approval
};

// ============================================
// JOB TYPES
// ============================================

export type JobType =
  | "context_refresh"    // Pull memory/notes/system state
  | "web_research"       // Grounded web search
  | "youtube_summary"    // Process YouTube videos
  | "idea_exploration"   // Explore enhancements
  | "idea_consolidation" // Deduplicate and consolidate ideas
  | "project_plan"       // Create scoped plan
  | "code_proposal"      // Create patch/branch
  | "code_verify"        // Run tests/review
  | "execute_change"     // Apply patch/deploy
  | "notify_user"        // Send summary/alert
  | "morning_briefing";  // Generate briefing

// Default risk levels for job types
export const JOB_TYPE_RISKS: Record<JobType, RiskLevel> = {
  context_refresh: "low",
  web_research: "low",
  youtube_summary: "low",
  idea_exploration: "low",
  idea_consolidation: "low",
  project_plan: "medium",
  code_proposal: "medium",
  code_verify: "medium",
  execute_change: "high",
  notify_user: "low",
  morning_briefing: "low",
};

// ============================================
// JOB DEFINITION
// ============================================

export interface NightJob {
  id: string;
  type: JobType;
  name: string;
  description: string;
  risk: RiskLevel;
  approval: ApprovalLevel;
  status: JobStatus;

  // Execution
  payload: Record<string, unknown>;
  result?: JobResult;

  // Dependencies
  dependsOn?: string[];  // Job IDs that must complete first
  blockedBy?: string[];  // Job IDs currently blocking this

  // Timing
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;

  // Artifacts
  artifacts?: string[];  // File paths to outputs
}

export interface JobResult {
  success: boolean;
  output: string;
  error?: string;
  duration: number;
  artifacts?: string[];
}

// ============================================
// NIGHT SESSION
// ============================================

export type NightPhase = "ingestion" | "deep_work" | "synthesis" | "briefing" | "idle";

export interface NightSession {
  id: string;
  startedAt: Date;
  phase: NightPhase;
  jobs: NightJob[];

  // Gemini session continuity
  geminiSessionId?: string;

  // Outputs
  morningBriefing?: string;
  findings: string[];
  proposals: string[];

  // Stats
  jobsCompleted: number;
  jobsFailed: number;
  totalDuration: number;
}

// ============================================
// CONTEXT PACK
// ============================================

export interface ContextPack {
  // Memory
  dailyLog: string;
  recentLogs: string[];  // Last 3 days
  permanentMemory: {
    me: string;
    work: string;
    life: string;
    tools: string;
  };

  // Ideas & Projects
  pendingIdeas: string[];
  activeProjects: string[];

  // System state
  systemInfo: string;
  lastBriefing?: string;

  // Compiled prompt
  compiled: string;
}

// ============================================
// NIGHT PLAN
// ============================================

export interface NightPlan {
  summary: string;
  maintenance_tasks?: Array<{
    id: string;
    task: "idea_consolidation" | "memory_cleanup" | "log_archival";
    priority: "high" | "medium" | "low";
  }>;
  research_tasks: Array<{
    id: string;
    query: string;
    priority: "high" | "medium" | "low";
  }>;
  ideas_to_explore: Array<{
    id: string;
    topic: string;
    connection_to_projects?: string;
  }>;
  code_proposals: Array<{
    id: string;
    description: string;
    target_project: string;
    risk: RiskLevel;
  }>;
  priority_actions: string[];
}

// ============================================
// MORNING BRIEFING
// ============================================

export interface MorningBriefing {
  date: string;
  big_three: Array<{
    task: string;
    reason: string;
  }>;
  overnight_findings: string[];
  needs_approval: Array<{
    id: string;
    type: JobType;
    description: string;
    verification_status?: "pass" | "pass_with_notes" | "fail";
  }>;
  subagent_status: {
    gemini: string;
    codex?: string;
    kimi?: string;
  };
}

// ============================================
// CONFIGURATION
// ============================================

export interface NightModeConfig {
  // Schedule
  startHour: number;  // 0-23, default 1 (1 AM)
  endHour: number;    // 0-23, default 6 (6 AM)

  // Autonomy
  autoApproveGreen: boolean;
  notifyOnYellow: boolean;
  requireApprovalForRed: boolean;

  // Limits
  maxJobsPerNight: number;
  maxResearchTasks: number;
  maxCodeProposals: number;

  // Timeouts
  jobTimeout: number;  // Per job, in ms
  totalTimeout: number;  // Total night run, in ms

  // Paths
  outputDir: string;  // ~/homer/night_mode/
  memoryDir: string;  // ~/memory/
}

export const DEFAULT_CONFIG: NightModeConfig = {
  startHour: 1,
  endHour: 6,
  autoApproveGreen: true,
  notifyOnYellow: true,
  requireApprovalForRed: true,
  maxJobsPerNight: 50,
  maxResearchTasks: 10,
  maxCodeProposals: 3,
  jobTimeout: 300000,  // 5 min per job
  totalTimeout: 18000000,  // 5 hours total
  outputDir: `${process.env.HOME}/homer/night_mode`,
  memoryDir: `${process.env.HOME}/memory`,
};
