/**
 * Event-Driven Runtime Event Bus
 *
 * Priority-based event distribution for the unified agent runtime.
 * Supports both sync and async handlers with error isolation.
 */

import { logger } from "../utils/logger.js";
import type { RuntimeEvent, RuntimeEventHandler } from "./types.js";

// ============================================
// SIGNAL TYPES (inputs to the event bus)
// ============================================

export type SignalType =
  | "time"      // Scheduled triggers (replaces cron)
  | "file"      // File system changes (memory, bookmarks)
  | "webhook"   // External triggers (GitHub, etc.)
  | "telegram"  // User commands/approvals
  | "internal"; // System-generated events

export type SignalPriority = "critical" | "high" | "normal" | "low" | "batch";

export interface Signal<T = unknown> {
  id: string;
  type: SignalType;
  priority: SignalPriority;
  source: string;
  data: T;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface SignalHandler<T = unknown> {
  (signal: Signal<T>): void | Promise<void>;
}

// ============================================
// PRIORITY QUEUE
// ============================================

const PRIORITY_ORDER: Record<SignalPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
  batch: 4,
};

class PriorityQueue<T extends { priority: SignalPriority }> {
  private items: T[] = [];

  enqueue(item: T): void {
    const priority = PRIORITY_ORDER[item.priority];
    let insertIndex = this.items.length;

    // Find insertion point to maintain priority order
    for (let i = 0; i < this.items.length; i++) {
      if (PRIORITY_ORDER[this.items[i]!.priority] > priority) {
        insertIndex = i;
        break;
      }
    }

    this.items.splice(insertIndex, 0, item);
  }

  dequeue(): T | undefined {
    return this.items.shift();
  }

  peek(): T | undefined {
    return this.items[0];
  }

  get length(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  clear(): void {
    this.items = [];
  }

  toArray(): T[] {
    return [...this.items];
  }
}

// ============================================
// EVENT BUS
// ============================================

type EventType = RuntimeEvent["type"] | "*";

interface Subscription {
  id: string;
  eventType: EventType;
  handler: RuntimeEventHandler;
  once: boolean;
}

export class EventBus {
  private subscriptions: Map<EventType, Subscription[]> = new Map();
  private signalQueue: PriorityQueue<Signal> = new PriorityQueue();
  private signalHandlers: Map<SignalType, SignalHandler[]> = new Map();
  private processing = false;
  private stopped = false;
  private subscriptionCounter = 0;

  // ============================================
  // RUNTIME EVENT SUBSCRIPTIONS
  // ============================================

  /**
   * Subscribe to runtime events
   */
  on(eventType: EventType, handler: RuntimeEventHandler): string {
    const id = `sub_${++this.subscriptionCounter}`;
    const subscription: Subscription = {
      id,
      eventType,
      handler,
      once: false,
    };

    const existing = this.subscriptions.get(eventType) || [];
    existing.push(subscription);
    this.subscriptions.set(eventType, existing);

    logger.debug({ eventType, subscriptionId: id }, "Event subscription added");
    return id;
  }

  /**
   * Subscribe to a single event
   */
  once(eventType: EventType, handler: RuntimeEventHandler): string {
    const id = `sub_${++this.subscriptionCounter}`;
    const subscription: Subscription = {
      id,
      eventType,
      handler,
      once: true,
    };

    const existing = this.subscriptions.get(eventType) || [];
    existing.push(subscription);
    this.subscriptions.set(eventType, existing);

    return id;
  }

  /**
   * Unsubscribe by ID
   */
  off(subscriptionId: string): boolean {
    for (const [eventType, subs] of this.subscriptions) {
      const index = subs.findIndex((s) => s.id === subscriptionId);
      if (index !== -1) {
        subs.splice(index, 1);
        if (subs.length === 0) {
          this.subscriptions.delete(eventType);
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Emit a runtime event
   */
  async emit(event: RuntimeEvent): Promise<void> {
    const handlers: Subscription[] = [];

    // Collect matching handlers
    const specificHandlers = this.subscriptions.get(event.type) || [];
    const wildcardHandlers = this.subscriptions.get("*") || [];

    handlers.push(...specificHandlers, ...wildcardHandlers);

    // Track one-time handlers to remove
    const onceIds: string[] = [];

    // Execute handlers with error isolation
    for (const sub of handlers) {
      try {
        await sub.handler(event);
        if (sub.once) {
          onceIds.push(sub.id);
        }
      } catch (error) {
        logger.error(
          { error, eventType: event.type, subscriptionId: sub.id },
          "Event handler error (isolated)"
        );
      }
    }

    // Remove one-time handlers
    for (const id of onceIds) {
      this.off(id);
    }
  }

  // ============================================
  // SIGNAL HANDLING (Priority Queue)
  // ============================================

  /**
   * Register a signal handler
   */
  onSignal(type: SignalType, handler: SignalHandler): void {
    const existing = this.signalHandlers.get(type) || [];
    existing.push(handler);
    this.signalHandlers.set(type, existing);
  }

  /**
   * Queue a signal for processing
   */
  queueSignal<T>(signal: Signal<T>): void {
    if (this.stopped) {
      logger.warn({ signalId: signal.id }, "Signal dropped - event bus stopped");
      return;
    }

    this.signalQueue.enqueue(signal as Signal);
    logger.debug(
      { signalId: signal.id, type: signal.type, priority: signal.priority, queueLength: this.signalQueue.length },
      "Signal queued"
    );
  }

  /**
   * Create and queue a signal
   */
  signal<T>(
    type: SignalType,
    source: string,
    data: T,
    priority: SignalPriority = "normal",
    metadata?: Record<string, unknown>
  ): string {
    const id = `sig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const signal: Signal<T> = {
      id,
      type,
      priority,
      source,
      data,
      timestamp: Date.now(),
      metadata,
    };

    this.queueSignal(signal);
    return id;
  }

  /**
   * Process the next signal in queue
   */
  async processNextSignal(): Promise<boolean> {
    const signal = this.signalQueue.dequeue();
    if (!signal) {
      return false;
    }

    const handlers = this.signalHandlers.get(signal.type) || [];
    if (handlers.length === 0) {
      logger.warn({ signalType: signal.type, signalId: signal.id }, "No handlers for signal");
      return true;
    }

    logger.debug(
      { signalId: signal.id, type: signal.type, handlerCount: handlers.length },
      "Processing signal"
    );

    for (const handler of handlers) {
      try {
        await handler(signal);
      } catch (error) {
        logger.error(
          { error, signalType: signal.type, signalId: signal.id },
          "Signal handler error (isolated)"
        );
      }
    }

    return true;
  }

  /**
   * Process all queued signals
   */
  async processAllSignals(): Promise<number> {
    let processed = 0;
    while (await this.processNextSignal()) {
      processed++;
    }
    return processed;
  }

  // ============================================
  // LIFECYCLE
  // ============================================

  /**
   * Start continuous signal processing
   */
  async startProcessing(intervalMs: number = 100): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;
    this.stopped = false;
    logger.info({ intervalMs }, "Event bus started processing");

    while (this.processing) {
      try {
        const hadWork = await this.processNextSignal();

        // If no work, wait for interval
        if (!hadWork) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      } catch (error) {
        logger.error({ error }, "Event bus processing error");
        // Continue processing despite errors
      }
    }

    logger.info("Event bus stopped processing");
  }

  /**
   * Stop processing
   */
  stop(): void {
    this.processing = false;
    this.stopped = true;
    logger.info("Event bus stopping...");
  }

  /**
   * Get queue status
   */
  getStatus(): {
    queueLength: number;
    subscriptionCount: number;
    signalHandlerCount: number;
    processing: boolean;
    stopped: boolean;
  } {
    let subCount = 0;
    for (const subs of this.subscriptions.values()) {
      subCount += subs.length;
    }

    let handlerCount = 0;
    for (const handlers of this.signalHandlers.values()) {
      handlerCount += handlers.length;
    }

    return {
      queueLength: this.signalQueue.length,
      subscriptionCount: subCount,
      signalHandlerCount: handlerCount,
      processing: this.processing,
      stopped: this.stopped,
    };
  }

  /**
   * Clear all state (for testing)
   */
  reset(): void {
    this.subscriptions.clear();
    this.signalQueue.clear();
    this.signalHandlers.clear();
    this.processing = false;
    this.stopped = false;
    this.subscriptionCounter = 0;
  }
}

// ============================================
// SINGLETON INSTANCE
// ============================================

let _eventBus: EventBus | null = null;

export function getEventBus(): EventBus {
  if (!_eventBus) {
    _eventBus = new EventBus();
  }
  return _eventBus;
}

export function resetEventBus(): void {
  if (_eventBus) {
    _eventBus.stop();
    _eventBus.reset();
    _eventBus = null;
  }
}
