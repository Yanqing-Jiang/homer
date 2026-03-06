/**
 * Global executor concurrency limiter.
 *
 * Prevents catch-up bursts from spawning too many CLI child processes.
 * Shared between scheduler jobs, queue worker, and bot-initiated runs.
 */

const MAX_CONCURRENT = 6;

let active = 0;
const waiting: Array<() => void> = [];

/**
 * Acquire a slot. Resolves when a slot is available.
 * Returns a release function that MUST be called when done.
 */
export async function acquireSlot(): Promise<() => void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return release;
  }

  // Wait for a slot
  return new Promise<() => void>((resolve) => {
    waiting.push(() => {
      active++;
      resolve(release);
    });
  });
}

function release(): void {
  active--;
  const next = waiting.shift();
  if (next) next();
}

/**
 * Run a function with a concurrency slot.
 */
export async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  const releaseFn = await acquireSlot();
  try {
    return await fn();
  } finally {
    releaseFn();
  }
}

export function getActiveSlots(): number {
  return active;
}

export function getWaitingCount(): number {
  return waiting.length;
}
