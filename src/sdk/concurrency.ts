export interface ConcurrencyLimiter {
  /** Acquire a slot. Resolves to a release function. Queues if at capacity. */
  acquire(): Promise<() => void>;
  /** Current number of active (acquired) slots. */
  readonly active: number;
  /** Current number of callers waiting to acquire. */
  readonly waiting: number;
}

export function createConcurrencyLimiter(maxConcurrent: number): ConcurrencyLimiter {
  let activeCount = 0;
  const queue: Array<() => void> = [];

  function release(): void {
    activeCount--;
    const next = queue.shift();
    if (next) {
      activeCount++;
      next();
    }
  }

  return {
    acquire(): Promise<() => void> {
      if (activeCount < maxConcurrent) {
        activeCount++;
        return Promise.resolve(release);
      }
      return new Promise<() => void>((resolve) => {
        queue.push(() => resolve(release));
      });
    },
    get active() {
      return activeCount;
    },
    get waiting() {
      return queue.length;
    },
  };
}
