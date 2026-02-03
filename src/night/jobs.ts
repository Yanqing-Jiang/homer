/**
 * Night Mode Job Queue
 *
 * Manages the queue of jobs for the night supervisor,
 * including creation, execution, and status tracking.
 */

import { randomUUID } from "crypto";
import type {
  NightJob,
  JobType,
  JobStatus,
  RiskLevel,
  ApprovalLevel,
  JobResult,
  NightPlan,
} from "./types.js";
import { JOB_TYPE_RISKS, RISK_TO_APPROVAL } from "./types.js";
import { logger } from "../utils/logger.js";

// ============================================
// JOB QUEUE CLASS
// ============================================

export class JobQueue {
  private jobs: Map<string, NightJob> = new Map();
  private executionOrder: string[] = [];

  // ----------------------------------------
  // Job Creation
  // ----------------------------------------

  createJob(
    type: JobType,
    name: string,
    description: string,
    payload: Record<string, unknown> = {},
    options: {
      risk?: RiskLevel;
      dependsOn?: string[];
    } = {}
  ): NightJob {
    const id = `job_${randomUUID().slice(0, 8)}`;
    const risk = options.risk ?? JOB_TYPE_RISKS[type];
    const approval = RISK_TO_APPROVAL[risk];

    const job: NightJob = {
      id,
      type,
      name,
      description,
      risk,
      approval,
      status: "pending",
      payload,
      dependsOn: options.dependsOn,
      createdAt: new Date(),
    };

    this.jobs.set(id, job);
    this.executionOrder.push(id);

    logger.debug({ jobId: id, type, name, risk, approval }, "Job created");

    return job;
  }

  // ----------------------------------------
  // Job Creation from Night Plan
  // ----------------------------------------

  createJobsFromPlan(plan: NightPlan): NightJob[] {
    const createdJobs: NightJob[] = [];

    // Maintenance tasks (always run first - includes idea_consolidation)
    if (plan.maintenance_tasks) {
      for (const task of plan.maintenance_tasks) {
        if (task.task === "idea_consolidation") {
          const job = this.createJob(
            "idea_consolidation",
            "Consolidate and deduplicate ideas",
            "Merge duplicate ideas, archive stale drafts, update blocklist",
            { priority: task.priority }
          );
          createdJobs.push(job);
        }
      }
    }

    // Research tasks
    for (const task of plan.research_tasks) {
      const job = this.createJob(
        "web_research",
        `Research: ${task.query.slice(0, 50)}...`,
        task.query,
        { query: task.query, priority: task.priority }
      );
      createdJobs.push(job);
    }

    // Ideas to explore
    for (const idea of plan.ideas_to_explore) {
      const job = this.createJob(
        "idea_exploration",
        `Explore: ${idea.topic.slice(0, 50)}...`,
        idea.topic,
        { topic: idea.topic, connection: idea.connection_to_projects }
      );
      createdJobs.push(job);
    }

    // Code proposals (depend on research completion)
    const researchJobIds = createdJobs
      .filter(j => j.type === "web_research")
      .map(j => j.id);

    for (const proposal of plan.code_proposals) {
      const job = this.createJob(
        "code_proposal",
        `Proposal: ${proposal.description.slice(0, 50)}...`,
        proposal.description,
        {
          description: proposal.description,
          targetProject: proposal.target_project,
        },
        {
          risk: proposal.risk,
          dependsOn: researchJobIds.length > 0 && researchJobIds[0] ? [researchJobIds[0]] : undefined,
        }
      );
      createdJobs.push(job);
    }

    logger.info(
      { totalJobs: createdJobs.length, research: plan.research_tasks.length, proposals: plan.code_proposals.length },
      "Jobs created from night plan"
    );

    return createdJobs;
  }

  // ----------------------------------------
  // Job Status Management
  // ----------------------------------------

  getJob(id: string): NightJob | undefined {
    return this.jobs.get(id);
  }

  getAllJobs(): NightJob[] {
    return Array.from(this.jobs.values());
  }

  getJobsByStatus(status: JobStatus): NightJob[] {
    return this.getAllJobs().filter(j => j.status === status);
  }

  getJobsByType(type: JobType): NightJob[] {
    return this.getAllJobs().filter(j => j.type === type);
  }

  getJobsByApproval(approval: ApprovalLevel): NightJob[] {
    return this.getAllJobs().filter(j => j.approval === approval);
  }

  updateJobStatus(id: string, status: JobStatus): void {
    const job = this.jobs.get(id);
    if (!job) {
      logger.warn({ jobId: id }, "Attempted to update unknown job");
      return;
    }

    job.status = status;

    if (status === "running") {
      job.startedAt = new Date();
    } else if (status === "completed" || status === "failed") {
      job.completedAt = new Date();
    }

    logger.debug({ jobId: id, status }, "Job status updated");
  }

  setJobResult(id: string, result: JobResult): void {
    const job = this.jobs.get(id);
    if (!job) return;

    job.result = result;
    job.status = result.success ? "completed" : "failed";
    job.completedAt = new Date();

    if (result.artifacts) {
      job.artifacts = result.artifacts;
    }
  }

  // ----------------------------------------
  // Job Dependencies
  // ----------------------------------------

  getNextExecutableJob(): NightJob | null {
    for (const id of this.executionOrder) {
      const job = this.jobs.get(id);
      if (!job) continue;

      // Skip non-pending jobs
      if (job.status !== "pending") continue;

      // Check dependencies
      if (job.dependsOn && job.dependsOn.length > 0) {
        const allDepsComplete = job.dependsOn.every(depId => {
          const depJob = this.jobs.get(depId);
          return depJob && depJob.status === "completed";
        });

        if (!allDepsComplete) {
          // Check if any dependency failed
          const anyDepFailed = job.dependsOn.some(depId => {
            const depJob = this.jobs.get(depId);
            return depJob && depJob.status === "failed";
          });

          if (anyDepFailed) {
            job.status = "blocked";
            job.blockedBy = job.dependsOn.filter(depId => {
              const depJob = this.jobs.get(depId);
              return depJob && depJob.status === "failed";
            });
          }

          continue;
        }
      }

      // Check approval requirements
      if (job.approval === "red" && job.status === "pending") {
        // Red jobs need explicit approval before execution
        continue;
      }

      return job;
    }

    return null;
  }

  getBlockedJobs(): NightJob[] {
    return this.getAllJobs().filter(j => j.status === "blocked");
  }

  getPendingApprovals(): NightJob[] {
    return this.getAllJobs().filter(
      j => j.approval === "red" && j.status === "pending"
    );
  }

  approveJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;

    if (job.approval !== "red") {
      logger.warn({ jobId: id }, "Attempted to approve non-red job");
      return false;
    }

    job.status = "approved";
    logger.info({ jobId: id, type: job.type }, "Job approved for execution");
    return true;
  }

  rejectJob(id: string, reason?: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;

    job.status = "rejected";
    if (reason) {
      job.result = {
        success: false,
        output: "",
        error: `Rejected: ${reason}`,
        duration: 0,
      };
    }

    logger.info({ jobId: id, type: job.type, reason }, "Job rejected");
    return true;
  }

  // ----------------------------------------
  // Statistics
  // ----------------------------------------

  getStats(): {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    blocked: number;
    pendingApproval: number;
  } {
    const jobs = this.getAllJobs();
    return {
      total: jobs.length,
      pending: jobs.filter(j => j.status === "pending").length,
      running: jobs.filter(j => j.status === "running").length,
      completed: jobs.filter(j => j.status === "completed").length,
      failed: jobs.filter(j => j.status === "failed").length,
      blocked: jobs.filter(j => j.status === "blocked").length,
      pendingApproval: this.getPendingApprovals().length,
    };
  }

  // ----------------------------------------
  // Serialization
  // ----------------------------------------

  toJSON(): object {
    return {
      jobs: Array.from(this.jobs.values()),
      executionOrder: this.executionOrder,
      stats: this.getStats(),
    };
  }

  clear(): void {
    this.jobs.clear();
    this.executionOrder = [];
  }
}

// ============================================
// JOB EXECUTION HELPERS
// ============================================

export function shouldAutoExecute(job: NightJob, config: { autoApproveGreen: boolean }): boolean {
  if (job.approval === "green" && config.autoApproveGreen) {
    return true;
  }

  if (job.approval === "yellow") {
    // Yellow jobs execute but notify
    return true;
  }

  // Red jobs and others require explicit approval
  return job.status === "approved";
}

export function formatJobForTelegram(job: NightJob): string {
  const statusEmoji = {
    pending: "⏳",
    running: "🔄",
    completed: "✅",
    failed: "❌",
    blocked: "🚫",
    approved: "👍",
    rejected: "👎",
  };

  const riskEmoji = {
    low: "🟢",
    medium: "🟡",
    high: "🔴",
  };

  let text = `${statusEmoji[job.status]} **${job.name}**\n`;
  text += `Risk: ${riskEmoji[job.risk]} ${job.risk.toUpperCase()}\n`;
  text += `Type: ${job.type}\n`;

  if (job.result) {
    text += `Duration: ${(job.result.duration / 1000).toFixed(1)}s\n`;
    if (job.result.error) {
      text += `Error: ${job.result.error}\n`;
    }
  }

  return text;
}

export function formatJobsForBriefing(jobs: NightJob[]): string {
  const completed = jobs.filter(j => j.status === "completed");
  const failed = jobs.filter(j => j.status === "failed");
  const pendingApproval = jobs.filter(j => j.approval === "red" && j.status === "pending");

  let briefing = "";

  if (completed.length > 0) {
    briefing += "### Completed Jobs\n";
    for (const job of completed) {
      briefing += `- ✅ ${job.name}\n`;
    }
    briefing += "\n";
  }

  if (failed.length > 0) {
    briefing += "### Failed Jobs\n";
    for (const job of failed) {
      briefing += `- ❌ ${job.name}: ${job.result?.error || "Unknown error"}\n`;
    }
    briefing += "\n";
  }

  if (pendingApproval.length > 0) {
    briefing += "### Needs Approval\n";
    for (const job of pendingApproval) {
      briefing += `- 🔴 ${job.name} (${job.type})\n`;
    }
    briefing += "\n";
  }

  return briefing;
}
