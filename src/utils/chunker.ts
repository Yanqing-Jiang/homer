const TELEGRAM_MAX_LENGTH = 4096;
const SAFE_CHUNK_SIZE = 4000; // Leave room for formatting

export function chunkMessage(message: string): string[] {
  if (message.length <= TELEGRAM_MAX_LENGTH) {
    return [message];
  }

  const chunks: string[] = [];
  let remaining = message;

  while (remaining.length > 0) {
    if (remaining.length <= SAFE_CHUNK_SIZE) {
      chunks.push(remaining);
      break;
    }

    // Find a good break point
    let breakPoint = findBreakPoint(remaining, SAFE_CHUNK_SIZE);

    chunks.push(remaining.slice(0, breakPoint).trimEnd());
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}

function findBreakPoint(text: string, maxLength: number): number {
  // Try to break at paragraph
  const paragraphBreak = text.lastIndexOf("\n\n", maxLength);
  if (paragraphBreak > maxLength * 0.5) {
    return paragraphBreak + 2;
  }

  // Try to break at line
  const lineBreak = text.lastIndexOf("\n", maxLength);
  if (lineBreak > maxLength * 0.5) {
    return lineBreak + 1;
  }

  // Try to break at sentence
  const sentenceBreak = findLastSentenceBreak(text, maxLength);
  if (sentenceBreak > maxLength * 0.5) {
    return sentenceBreak;
  }

  // Try to break at word
  const wordBreak = text.lastIndexOf(" ", maxLength);
  if (wordBreak > maxLength * 0.5) {
    return wordBreak + 1;
  }

  // Hard break at max length
  return maxLength;
}

function findLastSentenceBreak(text: string, maxLength: number): number {
  const searchText = text.slice(0, maxLength);

  // Find last sentence-ending punctuation followed by space or newline
  const patterns = [". ", ".\n", "! ", "!\n", "? ", "?\n"];

  let lastBreak = -1;
  for (const pattern of patterns) {
    const idx = searchText.lastIndexOf(pattern);
    if (idx > lastBreak) {
      lastBreak = idx + pattern.length;
    }
  }

  return lastBreak;
}
