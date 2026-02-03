/**
 * Proposals Web UI Routes
 *
 * HTMX-based dashboard for managing discovery proposals.
 * Provides approve/snooze/reject actions without requiring full page reloads.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { StateManager } from "../../state/manager.js";
import { logger } from "../../utils/logger.js";

interface ProposalRow {
  id: string;
  title: string;
  summary: string | null;
  content: string;
  stage: string;
  risk_level: string;
  source: string;
  source_url: string | null;
  relevance_score: number | null;
  approval_status: string;
  snooze_until: string | null;
  created_at: string;
}

export function registerProposalRoutes(
  server: FastifyInstance,
  stateManager: StateManager
): void {
  // Dashboard HTML page
  server.get("/proposals", async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.type("text/html");
    return getProposalsDashboard();
  });

  // HTMX partial: proposal list
  server.get("/proposals/list", async (_req: FastifyRequest, reply: FastifyReply) => {
    const proposals = getPendingProposals(stateManager);
    reply.type("text/html");
    return renderProposalList(proposals);
  });

  // Approve action
  server.post("/proposals/:id/approve", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };

    try {
      const proposal = stateManager.db.prepare(
        "SELECT stage, version FROM proposals WHERE id = ?"
      ).get(id) as { stage: string; version: number } | undefined;

      if (!proposal) {
        reply.type("text/html");
        return `<div class="alert error">Proposal not found</div>`;
      }

      // Advance stage: idea -> research -> plan -> archived
      const stageMap: Record<string, string> = {
        idea: "research",
        research: "plan",
        plan: "archived",
      };
      const nextStage = stageMap[proposal.stage] || "archived";

      stateManager.db.prepare(`
        UPDATE proposals
        SET stage = ?,
            approval_status = 'approved',
            approved_at = CURRENT_TIMESTAMP,
            version = version + 1
        WHERE id = ? AND version = ?
      `).run(nextStage, id, proposal.version);

      logger.info({ id, from: proposal.stage, to: nextStage }, "Proposal approved via web");

      reply.type("text/html");
      return `<div class="alert success">Approved! Stage: ${proposal.stage} -> ${nextStage}</div>`;
    } catch (error) {
      logger.error({ error, id }, "Failed to approve proposal");
      reply.type("text/html");
      return `<div class="alert error">Failed to approve</div>`;
    }
  });

  // Snooze action (24 hours)
  server.post("/proposals/:id/snooze", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };

    try {
      const snoozeUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      stateManager.db.prepare(`
        UPDATE proposals
        SET snooze_until = ?, version = version + 1
        WHERE id = ?
      `).run(snoozeUntil, id);

      logger.info({ id, snoozeUntil }, "Proposal snoozed via web");

      reply.type("text/html");
      return `<div class="alert info">Snoozed for 24 hours</div>`;
    } catch (error) {
      logger.error({ error, id }, "Failed to snooze proposal");
      reply.type("text/html");
      return `<div class="alert error">Failed to snooze</div>`;
    }
  });

  // Reject action
  server.post("/proposals/:id/reject", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { reason?: string } | undefined;
    const reason = body?.reason || "Rejected via web UI";

    try {
      stateManager.db.prepare(`
        UPDATE proposals
        SET stage = 'rejected',
            approval_status = 'rejected',
            rejection_reason = ?,
            version = version + 1
        WHERE id = ?
      `).run(reason, id);

      logger.info({ id, reason }, "Proposal rejected via web");

      reply.type("text/html");
      return `<div class="alert warning">Rejected</div>`;
    } catch (error) {
      logger.error({ error, id }, "Failed to reject proposal");
      reply.type("text/html");
      return `<div class="alert error">Failed to reject</div>`;
    }
  });

  logger.info("Proposal web routes registered");
}

function getPendingProposals(stateManager: StateManager): ProposalRow[] {
  try {
    return stateManager.db.prepare(`
      SELECT id, title, summary, content, stage, risk_level, source, source_url,
             relevance_score, approval_status, snooze_until, created_at
      FROM proposals
      WHERE approval_status = 'pending'
        AND (snooze_until IS NULL OR snooze_until <= datetime('now'))
      ORDER BY relevance_score DESC NULLS LAST, created_at DESC
      LIMIT 50
    `).all() as ProposalRow[];
  } catch {
    return [];
  }
}

function getProposalsDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Proposals - HOMER</title>
  <script src="https://unpkg.com/htmx.org@1.9.10"></script>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background: #0f172a; color: #e2e8f0; }
    .card { background: #1e293b; border-radius: 0.5rem; padding: 1rem; margin-bottom: 1rem; }
    .btn { padding: 0.5rem 1rem; border-radius: 0.375rem; cursor: pointer; font-size: 0.875rem; }
    .btn-approve { background: #22c55e; color: white; }
    .btn-approve:hover { background: #16a34a; }
    .btn-snooze { background: #eab308; color: black; }
    .btn-snooze:hover { background: #ca8a04; }
    .btn-reject { background: #ef4444; color: white; }
    .btn-reject:hover { background: #dc2626; }
    .alert { padding: 0.75rem 1rem; border-radius: 0.375rem; margin-bottom: 0.5rem; }
    .alert.success { background: #166534; color: #bbf7d0; }
    .alert.error { background: #991b1b; color: #fecaca; }
    .alert.warning { background: #92400e; color: #fef3c7; }
    .alert.info { background: #1e40af; color: #dbeafe; }
    .badge { display: inline-block; padding: 0.125rem 0.5rem; border-radius: 9999px; font-size: 0.75rem; }
    .badge-idea { background: #3b82f6; }
    .badge-research { background: #8b5cf6; }
    .badge-plan { background: #22c55e; }
    .score { font-weight: bold; }
    .score-high { color: #22c55e; }
    .score-medium { color: #eab308; }
    .score-low { color: #6b7280; }
    .htmx-request .btn { opacity: 0.5; pointer-events: none; }
  </style>
</head>
<body class="p-8">
  <div class="max-w-4xl mx-auto">
    <header class="mb-8">
      <h1 class="text-3xl font-bold mb-2">Proposals</h1>
      <p class="text-gray-400">Review and approve discovery proposals</p>
      <a href="/" class="text-blue-400 hover:underline text-sm">Back to Dashboard</a>
    </header>

    <div id="proposal-list" hx-get="/proposals/list" hx-trigger="load" hx-swap="innerHTML">
      <p class="text-gray-500">Loading proposals...</p>
    </div>

    <div class="mt-4">
      <button class="btn bg-gray-700 text-white" hx-get="/proposals/list" hx-target="#proposal-list" hx-swap="innerHTML">
        Refresh
      </button>
    </div>
  </div>
</body>
</html>`;
}

function renderProposalList(proposals: ProposalRow[]): string {
  if (proposals.length === 0) {
    return `<div class="card text-center text-gray-400">
      <p>No pending proposals</p>
      <p class="text-sm mt-2">New discoveries will appear here</p>
    </div>`;
  }

  return proposals.map((p) => renderProposalCard(p)).join("\n");
}

function renderProposalCard(p: ProposalRow): string {
  const score = p.relevance_score ?? 0;
  const scoreClass = score >= 70 ? "score-high" : score >= 50 ? "score-medium" : "score-low";
  const riskBadge = p.risk_level === "high" ? "bg-red-600" : p.risk_level === "medium" ? "bg-yellow-600" : "bg-green-600";
  const stageBadge = p.stage === "idea" ? "badge-idea" : p.stage === "research" ? "badge-research" : "badge-plan";
  const summary = p.summary || (p.content ? p.content.slice(0, 200) : "No summary");
  const createdAt = new Date(p.created_at).toLocaleDateString();

  // Escape HTML in title and summary
  const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c] || c));

  return `<div class="card" id="proposal-${p.id}">
    <div class="flex justify-between items-start mb-3">
      <div>
        <h3 class="text-lg font-semibold">${escapeHtml(p.title)}</h3>
        <div class="flex gap-2 mt-1">
          <span class="badge ${stageBadge}">${p.stage}</span>
          <span class="badge ${riskBadge}">${p.risk_level} risk</span>
          <span class="text-gray-500 text-sm">${p.source}</span>
        </div>
      </div>
      <div class="text-right">
        <div class="score ${scoreClass}">${score.toFixed(0)}</div>
        <div class="text-xs text-gray-500">${createdAt}</div>
      </div>
    </div>

    <p class="text-gray-300 text-sm mb-3">${escapeHtml(summary)}</p>

    ${p.source_url ? `<a href="${p.source_url}" target="_blank" class="text-blue-400 text-sm hover:underline block mb-3">View source</a>` : ""}

    <div class="flex gap-2" id="actions-${p.id}">
      <button class="btn btn-approve"
              hx-post="/proposals/${p.id}/approve"
              hx-target="#proposal-${p.id}"
              hx-swap="outerHTML">
        Approve
      </button>
      <button class="btn btn-snooze"
              hx-post="/proposals/${p.id}/snooze"
              hx-target="#proposal-${p.id}"
              hx-swap="outerHTML">
        Snooze 24h
      </button>
      <button class="btn btn-reject"
              hx-post="/proposals/${p.id}/reject"
              hx-target="#proposal-${p.id}"
              hx-swap="outerHTML"
              hx-confirm="Reject this proposal?">
        Reject
      </button>
    </div>
  </div>`;
}
