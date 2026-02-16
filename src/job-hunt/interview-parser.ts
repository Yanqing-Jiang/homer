/**
 * Interview detail extraction from emails — regex-based.
 */

export interface InterviewDetails {
  dateTime: Date | null;
  interviewer: string | null;
  meetingLink: string | null;
  type: "phone_screen" | "technical" | "behavioral" | "onsite" | "unknown";
  notes: string;
}

export function parseInterviewEmail(
  subject: string,
  body: string,
  snippet: string
): InterviewDetails {
  const text = `${subject} ${body} ${snippet}`;

  return {
    dateTime: extractDateTime(text),
    interviewer: extractInterviewer(text),
    meetingLink: extractMeetingLink(text),
    type: inferInterviewType(text),
    notes: "",
  };
}

function extractDateTime(text: string): Date | null {
  // ISO format: 2026-02-15T14:00:00
  const isoMatch = text.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
  if (isoMatch) return new Date(isoMatch[1]!);

  // Common date patterns
  const datePatterns = [
    // "Monday, February 15 at 2:00 PM"
    /(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i,
    // "Feb 15 at 2pm"
    /(\w{3})\s+(\d{1,2})(?:st|nd|rd|th)?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i,
    // "2/15/2026 2:00 PM"
    /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i,
  ];

  for (const pat of datePatterns) {
    const match = pat.exec(text);
    if (match) {
      try {
        // Try to parse — this is best-effort
        const dateStr = match[0];
        const parsed = new Date(dateStr);
        if (!isNaN(parsed.getTime())) return parsed;
      } catch { /* continue */ }
    }
  }

  return null;
}

function extractInterviewer(text: string): string | null {
  const patterns = [
    /(?:speak|speaking|meet|meeting)\s+with\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/,
    /[Ii]nterviewer:\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/,
    /(?:hosted|conducted)\s+by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/,
  ];

  for (const pat of patterns) {
    const match = pat.exec(text);
    if (match?.[1]) return match[1].trim();
  }

  return null;
}

function extractMeetingLink(text: string): string | null {
  const patterns = [
    /(https?:\/\/[a-z0-9.-]*zoom\.us\/[^\s<"]+)/i,
    /(https?:\/\/teams\.microsoft\.com\/[^\s<"]+)/i,
    /(https?:\/\/meet\.google\.com\/[^\s<"]+)/i,
    /(https?:\/\/[a-z0-9.-]*webex\.com\/[^\s<"]+)/i,
    /(https?:\/\/calendly\.com\/[^\s<"]+)/i,
    /(https?:\/\/[a-z0-9.-]*goodtime\.io\/[^\s<"]+)/i,
  ];

  for (const pat of patterns) {
    const match = pat.exec(text);
    if (match?.[1]) return match[1];
  }

  return null;
}

function inferInterviewType(text: string): InterviewDetails["type"] {
  const lower = text.toLowerCase();
  if (/\b(on-?site|in-?person|office visit)\b/.test(lower)) return "onsite";
  if (/\b(technical|coding|system design|live coding|pair programming)\b/.test(lower)) return "technical";
  if (/\b(behavioral|culture|values|fit)\b/.test(lower)) return "behavioral";
  if (/\b(phone|phone screen|initial screen|recruiter call)\b/.test(lower)) return "phone_screen";
  return "unknown";
}
