import { EventEmitter } from "events";

export interface PipelineDirtyEvent {
  pipeline: string;
  source: string;
}

class MemoryEventBus extends EventEmitter {
  emitDirty(pipeline: string, source: string): void {
    this.emit("pipeline:dirty", { pipeline, source } as PipelineDirtyEvent);
  }
}

// Singleton — shared between CanonicalMemoryService and Scheduler
export const memoryEvents = new MemoryEventBus();
memoryEvents.setMaxListeners(50);
