import type { Logger } from "./logger.js";

export interface SchedulerHandle {
  cancel(): void;
}

export interface Scheduler {
  /**
   * Fire fn immediately (default), then every intervalMs milliseconds.
   * Pass { immediate: false } to skip the first immediate fire.
   */
  interval(intervalMs: number, fn: () => Promise<void>, opts?: { immediate?: boolean }): SchedulerHandle;

  /**
   * Fire fn once per day at each specified time.
   * Times are "HH:MM" in local time (24-hour clock).
   * Misses (e.g. conductor was stopped) are skipped — fires compute from current time.
   */
  schedule(times: string[], fn: () => Promise<void>): SchedulerHandle;

  /** Cancel all registered jobs for this scheduler instance. */
  cancelAll(): void;
}

export type SchedulerJobType = "interval" | "schedule";

export interface SchedulerOptions {
  /**
   * Called after each job invocation completes (whether it resolved or threw),
   * with the job type and its wall-clock duration in milliseconds. Used to feed
   * run-count and duration metrics without coupling this module to a metrics
   * library.
   */
  onRun?: (jobType: SchedulerJobType, durationMs: number) => void;
}

/** Returns milliseconds until the next occurrence of HH:MM (local time). */
function msUntilNext(hhmm: string): number {
  const parts = hhmm.split(":");
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) {
    throw new Error(`Invalid time format (expected HH:MM): "${hhmm}"`);
  }

  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);

  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next.getTime() - now.getTime();
}

export function createScheduler(logger: Logger, schedulerOpts: SchedulerOptions = {}): Scheduler {
  const handles: SchedulerHandle[] = [];

  // Times fn(), reporting the wall-clock duration to onRun regardless of whether
  // fn resolved or threw — the job executed either way.
  async function timedRun(jobType: SchedulerJobType, fn: () => Promise<void>): Promise<void> {
    const start = Date.now();
    try {
      await fn();
    } finally {
      schedulerOpts.onRun?.(jobType, Date.now() - start);
    }
  }

  function interval(intervalMs: number, fn: () => Promise<void>, opts: { immediate?: boolean } = {}): SchedulerHandle {
    const { immediate = true } = opts;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async () => {
      if (cancelled) return;
      try {
        await timedRun("interval", fn);
      } catch (err) {
        logger.error("scheduler: interval job threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (!cancelled) {
        timer = setTimeout(run, intervalMs);
      }
    };

    if (immediate) {
      void run();
    } else {
      timer = setTimeout(run, intervalMs);
    }

    const handle: SchedulerHandle = {
      cancel() {
        cancelled = true;
        if (timer !== undefined) clearTimeout(timer);
      },
    };
    handles.push(handle);
    return handle;
  }

  function schedule(times: string[], fn: () => Promise<void>): SchedulerHandle {
    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();

    function scheduleNext(hhmm: string): void {
      if (cancelled) return;
      let ms: number;
      try {
        ms = msUntilNext(hhmm);
      } catch (err) {
        logger.error("scheduler: invalid time, skipping", {
          time: hhmm,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      const timer = setTimeout(async () => {
        timers.delete(timer);
        if (cancelled) return;
        try {
          await timedRun("schedule", fn);
        } catch (err) {
          logger.error("scheduler: scheduled job threw", {
            time: hhmm,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        scheduleNext(hhmm);
      }, ms);
      timers.add(timer);
    }

    for (const time of times) {
      scheduleNext(time);
    }

    const handle: SchedulerHandle = {
      cancel() {
        cancelled = true;
        for (const t of timers) clearTimeout(t);
      },
    };
    handles.push(handle);
    return handle;
  }

  return {
    interval,
    schedule,
    cancelAll() {
      for (const h of handles) h.cancel();
    },
  };
}
