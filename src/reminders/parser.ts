import * as chrono from "chrono-node";

export interface ParsedReminder {
  time: Date | null;
  message: string;
  originalInput: string;
}

/**
 * Parse a natural language reminder string
 * Examples:
 *   "in 30 minutes check the oven"
 *   "tomorrow at 9am call dentist"
 *   "at 5pm today review PR"
 *   "in 2 hours stand up and stretch"
 */
export function parseReminder(input: string): ParsedReminder {
  const trimmed = input.trim();

  if (!trimmed) {
    return { time: null, message: "", originalInput: input };
  }

  // Use chrono to parse the time from the input
  const parsed = chrono.parse(trimmed, new Date(), { forwardDate: true });

  if (parsed.length === 0 || !parsed[0]) {
    // No time found - treat the whole thing as the message
    return { time: null, message: trimmed, originalInput: input };
  }

  const result = parsed[0];
  const time = result.start.date();
  const resultIndex = result.index ?? 0;
  const resultText = result.text ?? "";

  // Extract the message by removing the time expression
  // The time expression is between result.index and result.index + result.text.length
  let message = trimmed;

  // Remove the parsed time expression from the message
  const before = trimmed.slice(0, resultIndex).trim();
  const after = trimmed.slice(resultIndex + resultText.length).trim();

  // Combine remaining parts
  message = [before, after].filter(Boolean).join(" ").trim();

  // Remove common connecting words at the start
  message = message.replace(/^(to|that|about)\s+/i, "");

  return {
    time,
    message: message || "(no message)",
    originalInput: input,
  };
}

/**
 * Format a relative time string for display
 */
export function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const targetTime = date.getTime();
  const diff = targetTime - now;

  if (diff < 0) {
    return "past due";
  }

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    if (remainingHours > 0) {
      return `${days}d ${remainingHours}h`;
    }
    return `${days}d`;
  }

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    if (remainingMinutes > 0) {
      return `${hours}h ${remainingMinutes}m`;
    }
    return `${hours}h`;
  }

  if (minutes > 0) {
    return `${minutes}m`;
  }

  return `${seconds}s`;
}

/**
 * Format a date for display (absolute time)
 */
export function formatDateTime(date: Date): string {
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  const timeStr = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  if (isToday) {
    return `today at ${timeStr}`;
  }

  if (isTomorrow) {
    return `tomorrow at ${timeStr}`;
  }

  const dateStr = date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  return `${dateStr} at ${timeStr}`;
}
