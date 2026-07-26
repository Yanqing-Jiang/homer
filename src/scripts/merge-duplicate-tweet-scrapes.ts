/**
 * Merge the historical cross-source duplicate tweet scrapes
 * (same tweet id under 'x-bookmark' and 'link-inbox-twitter').
 *
 * Keeps the richer raw_content row as survivor, unions metadata.external_urls,
 * repoints packet_scrapes / link_inbox / scrapes.idea_id&source_packet_id
 * references, then deletes the redundant row.
 *
 * Default is dry-run. Pass --apply to write inside a single transaction.
 *
 * Dry-run:  npx tsx src/scripts/merge-duplicate-tweet-scrapes.ts
 *           npx tsx src/scripts/merge-duplicate-tweet-scrapes.ts --dry-run
 * Apply:    npx tsx src/scripts/merge-duplicate-tweet-scrapes.ts --apply
 */

import Database from "better-sqlite3";
import { PATHS } from "../config/paths.js";
import { tweetIdFromUrl } from "../scraping/scrape-store.js";

const APPLY = process.argv.includes("--apply");
const DRY = !APPLY;

interface DupRow {
  id: string;
  source: string;
  url: string | null;
  title: string | null;
  author: string | null;
  raw_content: string;
  metadata: string | null;
  idea_id: string | null;
  source_packet_id: string | null;
  len: number;
  tweet_id: string;
}

interface PacketEdge {
  packet_id: string;
  scrape_id: string;
  role: string;
}

interface MergePlan {
  tweetId: string;
  survivor: DupRow;
  loser: DupRow;
  divergentPackets: boolean;
  survivorPacket: string | null;
  loserPacket: string | null;
  packetEdgesToRepoint: PacketEdge[];
  packetEdgesToDrop: PacketEdge[];
  linkInboxRepoints: string[];
  unionExternalUrls: string[];
}

function parseExternalUrls(metadata: string | null): string[] {
  if (!metadata) return [];
  try {
    const meta = JSON.parse(metadata);
    return Array.isArray(meta.external_urls) ? meta.external_urls.map(String) : [];
  } catch {
    return [];
  }
}

function pickSurvivor(a: DupRow, b: DupRow): { survivor: DupRow; loser: DupRow } {
  if (a.len !== b.len) {
    return a.len > b.len ? { survivor: a, loser: b } : { survivor: b, loser: a };
  }
  // Tie-break: prefer x-bookmark for stable tweet_* ids, else lexicographic id
  if (a.source === "x-bookmark" && b.source !== "x-bookmark") return { survivor: a, loser: b };
  if (b.source === "x-bookmark" && a.source !== "x-bookmark") return { survivor: b, loser: a };
  return a.id <= b.id ? { survivor: a, loser: b } : { survivor: b, loser: a };
}

function buildPlans(db: Database.Database): MergePlan[] {
  const rows = db.prepare(`
    SELECT id, source, url, title, author, raw_content, metadata,
           idea_id, source_packet_id, length(raw_content) AS len,
           substr(url, instr(url, '/status/') + 8) AS tweet_id
    FROM scrapes
    WHERE source IN ('x-bookmark', 'link-inbox-twitter')
      AND instr(url, '/status/') > 0
  `).all() as DupRow[];

  // Normalize tweet_id (strip query/hash if present)
  for (const r of rows) {
    r.tweet_id = tweetIdFromUrl(r.url) ?? String(r.tweet_id).replace(/[^0-9].*$/, "");
  }

  const byTweet = new Map<string, DupRow[]>();
  for (const r of rows) {
    if (!r.tweet_id) continue;
    const list = byTweet.get(r.tweet_id) ?? [];
    list.push(r);
    byTweet.set(r.tweet_id, list);
  }

  const plans: MergePlan[] = [];
  for (const [tweetId, group] of byTweet) {
    if (group.length < 2) continue;
    // Expect pairs; if >2, merge sequentially richest-first
    const sorted = [...group].sort((a, b) => b.len - a.len || a.id.localeCompare(b.id));
    const primary = sorted[0]!;
    for (let i = 1; i < sorted.length; i++) {
      const { survivor, loser } = pickSurvivor(primary, sorted[i]!);
      const survivorPacket = survivor.source_packet_id;
      const loserPacket = loser.source_packet_id;
      const divergentPackets =
        !!survivorPacket && !!loserPacket && survivorPacket !== loserPacket;

      const loserEdges = db.prepare(
        `SELECT packet_id, scrape_id, role FROM packet_scrapes WHERE scrape_id = ?`,
      ).all(loser.id) as PacketEdge[];

      const packetEdgesToRepoint: PacketEdge[] = [];
      const packetEdgesToDrop: PacketEdge[] = [];
      for (const edge of loserEdges) {
        const conflict = db.prepare(
          `SELECT 1 FROM packet_scrapes WHERE packet_id = ? AND scrape_id = ?`,
        ).get(edge.packet_id, survivor.id);
        if (conflict) packetEdgesToDrop.push(edge);
        else packetEdgesToRepoint.push(edge);
      }

      const linkInboxRepoints = (
        db.prepare(`SELECT id FROM link_inbox WHERE scrape_id = ?`).all(loser.id) as { id: string }[]
      ).map((r) => r.id);

      const unionExternalUrls = [
        ...new Set([...parseExternalUrls(survivor.metadata), ...parseExternalUrls(loser.metadata)]),
      ];

      plans.push({
        tweetId,
        survivor,
        loser,
        divergentPackets,
        survivorPacket,
        loserPacket,
        packetEdgesToRepoint,
        packetEdgesToDrop,
        linkInboxRepoints,
        unionExternalUrls,
      });
    }
  }

  return plans.sort((a, b) => a.tweetId.localeCompare(b.tweetId));
}

function printPlan(plan: MergePlan, index: number, total: number): void {
  console.log(`\n[${index + 1}/${total}] tweet ${plan.tweetId}`);
  console.log(`  survivor: ${plan.survivor.id} (${plan.survivor.source}, len=${plan.survivor.len}) packet=${plan.survivorPacket ?? "null"}`);
  console.log(`  delete:   ${plan.loser.id} (${plan.loser.source}, len=${plan.loser.len}) packet=${plan.loserPacket ?? "null"}`);
  if (plan.divergentPackets) {
    console.log(`  !! DIVERGENT SOURCE PACKETS: survivor→${plan.survivorPacket} vs loser→${plan.loserPacket}`);
    console.log(`     (preserving both packet_scrapes edges on survivor where possible; not silently collapsing packet linkage)`);
  } else if (plan.survivorPacket !== plan.loserPacket) {
    console.log(`  packet linkage differs (one side null): survivor=${plan.survivorPacket ?? "null"} loser=${plan.loserPacket ?? "null"}`);
  }
  if (plan.packetEdgesToRepoint.length) {
    console.log(`  repoint packet_scrapes:`);
    for (const e of plan.packetEdgesToRepoint) {
      console.log(`    ${e.packet_id} role=${e.role}  ${e.scrape_id} → ${plan.survivor.id}`);
    }
  }
  if (plan.packetEdgesToDrop.length) {
    console.log(`  drop conflicting packet_scrapes (PK would collide):`);
    for (const e of plan.packetEdgesToDrop) {
      console.log(`    ${e.packet_id} role=${e.role} scrape_id=${e.scrape_id}`);
    }
  }
  if (plan.linkInboxRepoints.length) {
    console.log(`  repoint link_inbox.scrape_id: ${plan.linkInboxRepoints.join(", ")} → ${plan.survivor.id}`);
  }
  console.log(`  union external_urls (${plan.unionExternalUrls.length}): ${plan.unionExternalUrls.slice(0, 3).join(", ")}${plan.unionExternalUrls.length > 3 ? " ..." : ""}`);
}

function applyPlan(db: Database.Database, plan: MergePlan): void {
  // Union metadata external_urls onto survivor; prefer survivor content (already richer)
  const meta = plan.survivor.metadata ? JSON.parse(plan.survivor.metadata) : {};
  meta.external_urls = plan.unionExternalUrls;
  // If loser had idea_id / source_packet_id and survivor lacks them, adopt (unless divergent)
  const ideaId = plan.survivor.idea_id ?? plan.loser.idea_id;
  let sourcePacketId = plan.survivor.source_packet_id;
  if (!sourcePacketId && plan.loser.source_packet_id) {
    sourcePacketId = plan.loser.source_packet_id;
  }
  // Divergent: keep survivor's own source_packet_id; both edges stay via packet_scrapes.

  db.prepare(`
    UPDATE scrapes
    SET metadata = ?,
        idea_id = COALESCE(idea_id, ?),
        source_packet_id = COALESCE(source_packet_id, ?)
    WHERE id = ?
  `).run(JSON.stringify(meta), ideaId, sourcePacketId, plan.survivor.id);

  for (const edge of plan.packetEdgesToDrop) {
    db.prepare(`DELETE FROM packet_scrapes WHERE packet_id = ? AND scrape_id = ?`)
      .run(edge.packet_id, edge.scrape_id);
  }
  for (const edge of plan.packetEdgesToRepoint) {
    db.prepare(`
      UPDATE packet_scrapes SET scrape_id = ? WHERE packet_id = ? AND scrape_id = ?
    `).run(plan.survivor.id, edge.packet_id, edge.scrape_id);
  }
  for (const linkId of plan.linkInboxRepoints) {
    db.prepare(`UPDATE link_inbox SET scrape_id = ? WHERE id = ?`)
      .run(plan.survivor.id, linkId);
  }

  db.prepare(`DELETE FROM scrapes WHERE id = ?`).run(plan.loser.id);
}

function main() {
  const db = new Database(PATHS.db);
  const plans = buildPlans(db);

  console.log(`Cross-source tweet duplicate pairs: ${plans.length}${DRY ? " [DRY RUN — pass --apply to write]" : " [APPLY]"}`);

  const divergent = plans.filter((p) => p.divergentPackets);
  console.log(`Pairs with divergent non-null source packets: ${divergent.length}`);
  for (const p of divergent) {
    console.log(`  - tweet ${p.tweetId}: ${p.survivorPacket} vs ${p.loserPacket}`);
  }

  // Also surface one-sided packet differences for operator clarity
  const oneSided = plans.filter(
    (p) => !p.divergentPackets && p.survivorPacket !== p.loserPacket,
  );
  if (oneSided.length) {
    console.log(`Pairs with one-sided packet linkage (not both-non-null divergent): ${oneSided.length}`);
    for (const p of oneSided) {
      console.log(`  - tweet ${p.tweetId}: survivor=${p.survivorPacket ?? "null"} loser=${p.loserPacket ?? "null"}`);
    }
  }

  plans.forEach((p, i) => printPlan(p, i, plans.length));

  if (DRY) {
    console.log(`\nDry-run complete. ${plans.length} pairs would be merged. No writes.`);
    db.close();
    return;
  }

  const tx = db.transaction(() => {
    for (const plan of plans) applyPlan(db, plan);
  });
  tx();

  console.log(`\nApplied ${plans.length} merges in one transaction.`);
  db.close();
}

main();
