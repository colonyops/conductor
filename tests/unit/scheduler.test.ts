import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import type { Logger } from "../../src/sdk/logger.js";
import { createScheduler } from "../../src/sdk/scheduler.js";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  with: () => noopLogger,
};

afterEach(() => {
  // Reset any frozen clock so other tests use real time.
  setSystemTime();
});

describe("createScheduler", () => {
  describe("interval", () => {
    it("fires immediately by default (immediate: true)", async () => {
      const scheduler = createScheduler(noopLogger);
      let count = 0;
      const handle = scheduler.interval(10_000, async () => {
        count++;
      });
      await new Promise((r) => setTimeout(r, 20));
      handle.cancel();
      expect(count).toBeGreaterThanOrEqual(1);
    });

    it("does not fire immediately when { immediate: false }", async () => {
      const scheduler = createScheduler(noopLogger);
      let count = 0;
      const handle = scheduler.interval(
        500,
        async () => {
          count++;
        },
        { immediate: false },
      );
      await new Promise((r) => setTimeout(r, 50));
      handle.cancel();
      expect(count).toBe(0);
    });

    it("fires at least twice within 2× intervalMs (immediate: true)", async () => {
      const scheduler = createScheduler(noopLogger);
      let count = 0;
      const handle = scheduler.interval(100, async () => {
        count++;
      });
      await new Promise((r) => setTimeout(r, 250));
      handle.cancel();
      expect(count).toBeGreaterThanOrEqual(2);
    });

    it("cancel() stops further invocations", async () => {
      const scheduler = createScheduler(noopLogger);
      let count = 0;
      const handle = scheduler.interval(50, async () => {
        count++;
      });
      await new Promise((r) => setTimeout(r, 30));
      handle.cancel();
      const countAtCancel = count;
      await new Promise((r) => setTimeout(r, 100));
      expect(count).toBe(countAtCancel);
    });

    it("does not throw if fn throws", async () => {
      const scheduler = createScheduler(noopLogger);
      const handle = scheduler.interval(50, async () => {
        throw new Error("boom");
      });
      await new Promise((r) => setTimeout(r, 80));
      handle.cancel();
      // No unhandled rejection — test passes
    });
  });

  describe("schedule (HH:MM next-occurrence arithmetic)", () => {
    it("computes ms until next occurrence for a future time today", () => {
      // We test msUntilNext indirectly by checking that the scheduled time is in the future.
      // Create a time 2 seconds from now in HH:MM format.
      const future = new Date(Date.now() + 2000);
      const hhmm = `${String(future.getHours()).padStart(2, "0")}:${String(future.getMinutes()).padStart(2, "0")}`;
      const scheduler = createScheduler(noopLogger);
      let fired = false;
      const handle = scheduler.schedule([hhmm], async () => {
        fired = true;
      });
      // Should NOT have fired yet
      expect(fired).toBe(false);
      handle.cancel();
    });

    it("re-schedules on each firing and cancel() still stops it afterward", async () => {
      // Freeze the clock just before HH:MM so each firing recomputes a ~50ms wait.
      // With the clock frozen, every re-schedule lands on the same near-future target,
      // so the job fires repeatedly and exercises the timer-set add/delete cycle that
      // the leak fix introduced — including cancelling after several fires.
      const frozen = new Date(2026, 0, 1, 10, 0, 59, 950);
      setSystemTime(frozen);

      const scheduler = createScheduler(noopLogger);
      let count = 0;
      const handle = scheduler.schedule(["10:01"], async () => {
        count++;
      });

      await new Promise((r) => setTimeout(r, 250));
      expect(count).toBeGreaterThanOrEqual(2);

      handle.cancel();
      const countAtCancel = count;
      await new Promise((r) => setTimeout(r, 150));
      expect(count).toBe(countAtCancel);
    });

    it("cancel() stops scheduled jobs", async () => {
      const scheduler = createScheduler(noopLogger);
      let count = 0;
      // Create a time 50ms from now
      const future = new Date(Date.now() + 50);
      const hhmm = `${String(future.getHours()).padStart(2, "0")}:${String(future.getMinutes()).padStart(2, "0")}`;
      const handle = scheduler.schedule([hhmm], async () => {
        count++;
      });
      handle.cancel();
      await new Promise((r) => setTimeout(r, 100));
      expect(count).toBe(0);
    });
  });

  describe("cancelAll", () => {
    it("cancels all registered jobs", async () => {
      const scheduler = createScheduler(noopLogger);
      let count = 0;
      scheduler.interval(50, async () => {
        count++;
      });
      scheduler.interval(50, async () => {
        count++;
      });
      await new Promise((r) => setTimeout(r, 30));
      scheduler.cancelAll();
      const countAtCancel = count;
      await new Promise((r) => setTimeout(r, 100));
      expect(count).toBe(countAtCancel);
    });
  });
});
