/**
 * YouTube URL utilities — shared across intake paths.
 */

/**
 * Extract the 11-character video ID from a YouTube URL.
 * Handles youtube.com/watch?v=, youtu.be/, youtube.com/shorts/, and m.youtube.com variants.
 * Works regardless of query parameter order (e.g. ?si=abc&v=ID).
 */
export function extractVideoId(url: string): string | null {
  // youtu.be/VIDEO_ID
  const shortMatch = url.match(/youtu\.be\/([\w-]{11})(?:[&?\/#]|$)/);
  if (shortMatch) return shortMatch[1] ?? null;

  // youtube.com/shorts/VIDEO_ID
  const shortsMatch = url.match(/youtube\.com\/shorts\/([\w-]{11})(?:[&?\/#]|$)/);
  if (shortsMatch) return shortsMatch[1] ?? null;

  // youtube.com/watch?...v=VIDEO_ID (v can be any query param position)
  const watchMatch = url.match(/youtube\.com\/watch\?.*?(?:^|[&?])v=([\w-]{11})(?:[&#]|$)/);
  if (watchMatch) return watchMatch[1] ?? null;

  return null;
}
