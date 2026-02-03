export function webLane(sessionId: string): string {
  return `web:${sessionId}`;
}

export function telegramLane(chatId: number | string): string {
  return `tg:${chatId}`;
}
