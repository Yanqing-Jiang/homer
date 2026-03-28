/**
 * Types for the plan review card system.
 * Used for rendering structured Telegram plan cards with Approve/Revise/Deny flow.
 */

export interface PlanPhase {
  name: string;       // verb-led: "Add executor", "Replace adapter"
  summary: string;    // one line
  steps: string[];
  files?: string[];
}

export interface GeneratedPlan {
  id: string;              // plan_YYYYMMDD_slug
  title: string;
  goal: string;            // one-line summary
  riskLevel: "low" | "medium" | "high";
  files: string[];
  risks: string[];
  phases: PlanPhase[];
  whyThisPlan?: string;
  revisionNumber: number;  // starts at 1
  source: string;          // "scheduler-job" | "claude-session" | "manual"
  rawText?: string;        // original plan text for executor
}

export type PlanReviewStatus =
  | "pending_review"
  | "awaiting_revision"
  | "revising"
  | "approved"
  | "executing"
  | "completed"
  | "denied"
  | "superseded"
  | "expired";

export interface PlanReviewRecord {
  id: string;
  parentPlanId: string | null;
  status: PlanReviewStatus;
  revisionNumber: number;
  title: string;
  planJson: string;        // JSON-serialized GeneratedPlan
  riskLevel: string;
  source: string | null;
  chatId: number | null;
  cardMessageId: number | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  decisionFeedback: string | null;
}

export interface RevisionFeedback {
  id: number;
  planId: string;
  revisionNumber: number;
  feedbackText: string;
  createdAt: string;
}
