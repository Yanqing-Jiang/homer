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

function ageLabel(firstSeenAt: string, publishDate: string | null): string {
  // The posting's own publish date is what the reader cares about; scanner
  // first-seen is the fallback when the source didn't estimate one.
  if (publishDate) {
    const published = Date.parse(publishDate);
    if (Number.isFinite(published)) {
      const days = Math.max(0, Math.round((Date.now() - published) / 86_400_000));
      return days === 0 ? "posted today" : `posted ${days}d ago`;
    }
  }
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
            &middot; ${verifyBadge(j)} &middot; ${ageLabel(j.first_seen_at, j.publish_date)}${repost}
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
      Fresh (&lt;7d), employer-verified postings ranked for fit. Seattle metro onsite/hybrid, $250K+ target.
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

/** Once-a-day midday status for quiet stretches: confirms the scanner is
 * alive and shows the closest below-the-bar roles sitting in the queue. */
export function renderQuietDayHtml(nearMisses: RankedJob[], dayLabel: string, stats: RunStats): string {
  const rows = nearMisses
    .map((r) => {
      const j = r.job;
      return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e6e6e6;">
          <div style="font-size:14px;font-weight:600;color:#1a1a1a;">${esc(j.title)}</div>
          <div style="font-size:13px;color:#555;margin-top:2px;">
            ${esc(j.company)} &middot; ${esc(j.location ?? "location n/a")}
            &middot; ${compLabel(j.yearly_min_comp, j.yearly_max_comp, j.comp_transparent)}
            &middot; rank ${r.rankScore.toFixed(0)}/100 &middot; ${ageLabel(j.first_seen_at, j.publish_date)}
          </div>
        </td>
      </tr>`;
    })
    .join("\n");

  return `<div style="max-width:680px;margin:0 auto;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#ffffff;color:#1a1a1a;">
  <div style="padding:20px 12px 8px;">
    <div style="font-size:20px;font-weight:700;">Job Scanner — ${esc(dayLabel)}: no qualifying roles</div>
    <div style="font-size:13px;color:#666;margin-top:4px;">
      Nothing has cleared the bar since the last digest (fresh &lt;7d, Seattle metro onsite/hybrid, $250K+ target, rank &ge; 70).
      ${nearMisses.length > 0 ? "Closest below-the-bar roles in the queue:" : "The queue is empty."}
    </div>
  </div>
  ${nearMisses.length > 0 ? `<table style="width:100%;border-collapse:collapse;" cellpadding="0" cellspacing="0">${rows}</table>` : ""}
  <div style="padding:16px 12px;font-size:12px;color:#999;">
    This run: ${stats.discovered} discovered &middot; ${stats.newJobs} new &middot; ${stats.rulesPassed} passed rules
    &middot; ${stats.verifiedLive} verified live.
    ${stats.errors.length > 0 ? `Errors: ${esc(stats.errors.join("; ").slice(0, 300))}` : ""}
  </div>
</div>`;
}

export function renderQuietDayText(nearMisses: RankedJob[], dayLabel: string): string {
  const head = `Job Scanner — ${dayLabel}: no qualifying roles since the last digest.`;
  if (nearMisses.length === 0) return `${head}\nThe queue is empty.`;
  const lines = nearMisses.map(
    (r) =>
      `- ${r.job.title} — ${r.job.company} (${r.job.location ?? "n/a"}) | rank ${r.rankScore.toFixed(0)}/100`,
  );
  return `${head}\nClosest below-the-bar roles:\n${lines.join("\n")}`;
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
