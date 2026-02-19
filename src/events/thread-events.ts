import { EventEmitter } from "events";

export interface ThreadMessageEvent {
  threadId: string;
  message: {
    id: string;
    threadId: string;
    role: string;
    content: string;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  };
}

class ThreadEventBus extends EventEmitter {
  emitMessage(threadId: string, message: ThreadMessageEvent["message"]): void {
    this.emit(`thread:${threadId}`, { threadId, message });
  }

  onMessage(
    threadId: string,
    handler: (event: ThreadMessageEvent) => void
  ): () => void {
    const eventName = `thread:${threadId}`;
    this.on(eventName, handler);
    return () => this.off(eventName, handler);
  }
}

// Singleton — shared between StateManager and SSE routes
export const threadEvents = new ThreadEventBus();
threadEvents.setMaxListeners(100);
