export interface ConcurrencyLimiter {
  /** Acquire a slot. Resolves to a release function. Queues if at capacity. */
  acquire(): Promise<() => void>;
  /** Current number of active (acquired) slots. */
  readonly active: number;
  /** Current number of callers waiting to acquire. */
  readonly waiting: number;
}

export interface ConcurrencyLimiterOptions {
  /**
   * Called after every change to the active/waiting counts. Used to mirror the
   * limiter state into gauges without coupling this module to a metrics library.
   */
  onChange?: (active: number, waiting: number) => void;
}

export function createConcurrencyLimiter(
  maxConcurrent: number,
  opts: ConcurrencyLimiterOptions = {},
): ConcurrencyLimiter {
  let activeCount = 0;
  const queue: Array<() => void> = [];

  function notify(): void {
    opts.onChange?.(activeCount, queue.length);
  }

  function release(): void {
    activeCount--;
    const next = queue.shift();
    if (next) {
      activeCount++;
      next();
    }
    notify();
  }

  return {
    acquire(): Promise<() => void> {
      if (activeCount < maxConcurrent) {
        activeCount++;
        notify();
        return Promise.resolve(release);
      }
      return new Promise<() => void>((resolve) => {
        queue.push(() => resolve(release));
        notify();
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
