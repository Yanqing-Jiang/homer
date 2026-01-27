import { randomUUID } from "crypto";
import type { StateManager } from "../state/manager.js";
import { logger } from "../utils/logger.js";

export interface Reminder {
  id: string;
  chatId: number;
  message: string;
  dueAt: Date;
  context: string;
  createdAt: Date;
  sentAt: Date | null;
  status: "pending" | "sent" | "cancelled";
}

export interface CreateReminderInput {
  chatId: number;
  message: string;
  dueAt: Date;
  context?: string;
}

export class ReminderManager {
  constructor(private stateManager: StateManager) {}

  /**
   * Create a new reminder
   */
  create(input: CreateReminderInput): string {
    const id = randomUUID();
    const now = new Date();

    this.stateManager.createReminder({
      id,
      chatId: input.chatId,
      message: input.message,
      dueAt: input.dueAt.toISOString(),
      context: input.context ?? "default",
      createdAt: now.toISOString(),
    });

    logger.info(
      {
        id,
        chatId: input.chatId,
        dueAt: input.dueAt.toISOString(),
        message: input.message.slice(0, 50),
      },
      "Reminder created"
    );

    return id;
  }

  /**
   * Get all pending reminders that are due
   */
  getPendingDue(): Reminder[] {
    return this.stateManager.getPendingReminders();
  }

  /**
   * Mark a reminder as sent
   */
  markSent(id: string): void {
    this.stateManager.markReminderSent(id);
    logger.debug({ id }, "Reminder marked as sent");
  }

  /**
   * Cancel a reminder
   */
  cancel(id: string): boolean {
    const result = this.stateManager.cancelReminder(id);
    if (result) {
      logger.info({ id }, "Reminder cancelled");
    }
    return result;
  }

  /**
   * Get all reminders for a chat (including sent/cancelled)
   */
  getByChat(chatId: number, limit = 10): Reminder[] {
    return this.stateManager.getRemindersByChat(chatId, limit);
  }

  /**
   * Get pending reminders for a chat
   */
  getPendingByChat(chatId: number): Reminder[] {
    return this.stateManager.getPendingRemindersByChat(chatId);
  }

  /**
   * Get a reminder by ID
   */
  getById(id: string): Reminder | null {
    return this.stateManager.getReminderById(id);
  }
}
