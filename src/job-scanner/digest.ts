/**
 * HTML digest rendering. Email-client-safe: inline styles, table layout,
 * single light palette (email clients ignore media queries inconsistently).
 */

import type { RankedJob, RunStats } from "./types.js";

function esc(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function compLabel(min: number | null, max: number | null, transparent: number): string {
  if (transparent !== 1 || (min === null && max === null)) return "comp not listed";
  const k = (n: number) => `$${Math.round(n / 1000)}K`;
  if (min !== null && max !== null) return `${k(min)}–${k(max)}`;
  return max !== null ? `up to ${k(max)}` : `from ${k(min!)}`;
}

function ageLabel(firstSeenAt: string): string {
  const seen = new Date(firstSeenAt.replace(" ", "T") + "Z").getTime();
  const hours = Math.max(0, Math.round((Date.now() - seen) / 3_600_000));
  return hours < 24 ? `first seen ${hours}h ago` : `first seen ${Math.round(hours / 24)}d ago`;
}

function verifyBadge(job: RankedJob["job"]): string {
  if (job.ats_live === 1 && job.verify_method === "feed") {
    return '<span style="color:#0a7a33;font-weight:600;">&#10003; live on employer ATS</span>';
  }
  if (job.ats_live === 1) {
    return '<span style="color:#8a6d00;">&#10003; apply URL live</span>';
  }
  return '<span style="color:#888;">unverified</span>';
}

export function renderDigestHtml(
  ranked: RankedJob[],
  runLabel: string,
  stats: RunStats,
): string {
  const rows = ranked
    .map((r, i) => {
      const j = r.job;
      const repost =
        j.repost_count > 0
          ? ` &middot; <span style="color:#b3261e;">reposted ${j.repost_count}x</span>`
          : "";
      const applyLink = j.apply_url
        ? `<a href="${esc(j.apply_url)}" style="color:#0b57d0;text-decoration:none;font-weight:600;">Apply &rarr;</a>`
        : "";
      return `
      <tr>
        <td style="padding:14px 12px;border-bottom:1px solid #e6e6e6;vertical-align:top;width:28px;color:#999;font-size:14px;">${i + 1}</td>
        <td style="padding:14px 12px 14px 0;border-bottom:1px solid #e6e6e6;">
          <div style="font-size:16px;font-weight:600;color:#1a1a1a;">
            ${j.apply_url ? `<a href="${esc(j.apply_url)}" style="color:#1a1a1a;text-decoration:none;">${esc(j.title)}</a>` : esc(j.title)}
          </div>
          <div style="font-size:14px;color:#444;margin-top:2px;">
            ${esc(j.company)} &middot; ${esc(j.location ?? "location n/a")}${j.workplace_type ? ` &middot; ${esc(j.workplace_type)}` : ""}
          </div>
          <div style="font-size:13px;color:#555;margin-top:4px;">
            <strong>${compLabel(j.yearly_min_comp, j.yearly_max_comp, j.comp_transparent)}</strong>
            &middot; rank ${r.rankScore.toFixed(0)}/100 (fit ${j.fit_score?.toFixed(1) ?? "?"}/10)
            &middot; ${verifyBadge(j)} &middot; ${ageLabel(j.first_seen_at)}${repost}
          </div>
          ${j.fit_rationale ? `<div style="font-size:13px;color:#666;margin-top:4px;font-style:italic;">${esc(j.fit_rationale)}</div>` : ""}
        </td>
        <td style="padding:14px 12px;border-bottom:1px solid #e6e6e6;vertical-align:top;text-align:right;white-space:nowrap;">${applyLink}</td>
      </tr>`;
    })
    .join("\n");

  const empty = `
      <tr><td style="padding:24px 12px;color:#666;font-size:14px;">
        No verified-fresh postings cleared the bar this run. That is a valid result —
        the list is never padded with stale or unverified jobs.
      </td></tr>`;

  return `<div style="max-width:680px;margin:0 auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#ffffff;color:#1a1a1a;">
  <div style="padding:20px 12px 8px;">
    <div style="font-size:20px;font-weight:700;">Job Scanner — ${esc(runLabel)}</div>
    <div style="font-size:13px;color:#666;margin-top:4px;">
      Fresh, employer-verified postings ranked for fit. Seattle metro + Remote US, $200K+ target.
    </div>
  </div>
  <table style="width:100%;border-collapse:collapse;" cellpadding="0" cellspacing="0">
    ${ranked.length > 0 ? rows : empty}
  </table>
  <div style="padding:16px 12px;font-size:12px;color:#999;">
    Run stats: ${stats.discovered} discovered &middot; ${stats.newJobs} new &middot; ${stats.rulesPassed} passed rules
    &middot; ${stats.verifiedLive} verified live &middot; ${stats.scored} scored.
    ${stats.errors.length > 0 ? `Errors: ${esc(stats.errors.join("; ").slice(0, 300))}` : ""}
  </div>
</div>`;
}

export function renderDigestText(ranked: RankedJob[], runLabel: string): string {
  if (ranked.length === 0) return `Job Scanner — ${runLabel}\nNo verified-fresh postings cleared the bar this run.`;
  const lines = ranked.map((r, i) => {
    const j = r.job;
    return `${i + 1}. ${j.title} — ${j.company} (${j.location ?? "n/a"}) | ${compLabel(
      j.yearly_min_comp,
      j.yearly_max_comp,
      j.comp_transparent,
    )} | rank ${r.rankScore.toFixed(0)}/100\n   ${j.apply_url ?? ""}`;
  });
  return `Job Scanner — ${runLabel}\n\n${lines.join("\n")}`;
}
