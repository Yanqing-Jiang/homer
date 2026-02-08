/**
 * URL Canonicalization for idea deduplication
 * Normalizes URLs to a consistent format for comparison
 */

export interface CanonicalResult {
  canonical: string;      // Normalized URL
  repoId: string | null;  // owner/repo for GitHub
  domain: string;         // github.com, x.com, etc.
}

/**
 * Canonicalize a URL for deduplication
 * - GitHub URLs normalized to https://github.com/owner/repo
 * - Twitter/X URLs normalized to https://x.com/...
 * - Tracking params stripped from all URLs
 */
export function canonicalizeUrl(url: string): CanonicalResult {
  if (!url || typeof url !== "string") {
    return { canonical: "", repoId: null, domain: "" };
  }

  try {
    const parsed = new URL(url.toLowerCase().trim());

    // GitHub-specific normalization
    if (parsed.hostname === "github.com" || parsed.hostname === "www.github.com") {
      const pathParts = parsed.pathname.split("/").filter(Boolean);

      if (pathParts.length >= 2) {
        const owner = pathParts[0]!;
        const repo = pathParts[1]!.replace(/\.git$/, "");
        const repoId = `${owner}/${repo}`;

        return {
          canonical: `https://github.com/${repoId}`,
          repoId,
          domain: "github.com",
        };
      }

      return {
        canonical: parsed.toString(),
        repoId: null,
        domain: "github.com",
      };
    }

    // Twitter/X normalization
    if (
      parsed.hostname.includes("twitter.com") ||
      parsed.hostname.includes("x.com")
    ) {
      // Normalize to x.com, keep path
      return {
        canonical: `https://x.com${parsed.pathname}`,
        repoId: null,
        domain: "x.com",
      };
    }

    // YouTube normalization
    if (
      parsed.hostname.includes("youtube.com") ||
      parsed.hostname.includes("youtu.be")
    ) {
      let videoId: string | null = null;

      if (parsed.hostname.includes("youtu.be")) {
        videoId = parsed.pathname.split("/").filter(Boolean)[0] ?? null;
      } else {
        videoId = parsed.searchParams.get("v");
      }

      if (videoId) {
        return {
          canonical: `https://youtube.com/watch?v=${videoId}`,
          repoId: null,
          domain: "youtube.com",
        };
      }
    }

    // Generic: strip tracking params, normalize protocol
    const stripParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
      "ref",
      "source",
      "fbclid",
      "gclid",
      "mc_cid",
      "mc_eid",
    ];
    stripParams.forEach((p) => parsed.searchParams.delete(p));

    // Remove fragment
    parsed.hash = "";

    // Normalize trailing slash
    if (parsed.pathname.endsWith("/") && parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    return {
      canonical: parsed.toString(),
      repoId: null,
      domain: parsed.hostname,
    };
  } catch {
    // Invalid URL, return as-is
    return { canonical: url, repoId: null, domain: "" };
  }
}

/**
 * Extract repo identifier from URL or text
 * Returns owner/repo if found, null otherwise
 */
export function extractRepoId(text: string): string | null {
  if (!text) return null;

  // Try URL extraction first
  const urlMatch = text.match(
    /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i
  );
  if (urlMatch?.[1] && urlMatch[2]) {
    return `${urlMatch[1].toLowerCase()}/${urlMatch[2].toLowerCase().replace(/\.git$/, "")}`;
  }

  // Try bare owner/repo pattern (but be careful not to match things like "AI/ML")
  const bareMatch = text.match(
    /\b([a-z][a-z0-9_-]{1,38})\/([a-z][a-z0-9_.-]{1,100})\b/i
  );
  if (bareMatch?.[1] && bareMatch[2]) {
    // Filter out common false positives
    const falsePosFirstParts = ["ai", "ml", "ui", "ux", "ci", "cd", "os", "io"];
    if (!falsePosFirstParts.includes(bareMatch[1].toLowerCase())) {
      return `${bareMatch[1].toLowerCase()}/${bareMatch[2].toLowerCase()}`;
    }
  }

  return null;
}
