import { EventEmitter } from "events";

export interface SessionEvent {
  type: "activity" | "run-started" | "run-completed" | "renamed" | "unread-changed";
  sessionId: string;
  data?: Record<string, unknown>;
}

class SessionEventBus extends EventEmitter {
  emitSessionEvent(event: SessionEvent): void {
    this.emit("session-event", event);
  }

  onSessionEvent(handler: (event: SessionEvent) => void): () => void {
    this.on("session-event", handler);
    return () => this.off("session-event", handler);
  }
}

// Singleton — shared between StateManager, run routes, and SSE routes
export const sessionEvents = new SessionEventBus();
sessionEvents.setMaxListeners(50);
