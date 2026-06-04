import { describe, expect, it } from "vitest";
import { createConcurrencyLimiter } from "../../src/sdk/concurrency.js";

describe("createConcurrencyLimiter", () => {
  it("resolves immediately when below capacity", async () => {
    const limiter = createConcurrencyLimiter(2);
    const release = await limiter.acquire();
    expect(limiter.active).toBe(1);
    expect(limiter.waiting).toBe(0);
    release();
  });

  it("active/waiting counters are accurate", async () => {
    const limiter = createConcurrencyLimiter(1);
    const r1 = await limiter.acquire();
    expect(limiter.active).toBe(1);
    expect(limiter.waiting).toBe(0);

    let r2Resolved = false;
    const p2 = limiter.acquire().then((r) => {
      r2Resolved = true;
      return r;
    });

    // Give the microtask queue a tick so the promise can queue
    await new Promise((r) => setTimeout(r, 0));
    expect(limiter.active).toBe(1);
    expect(limiter.waiting).toBe(1);
    expect(r2Resolved).toBe(false);

    r1();
    const r2 = await p2;
    expect(r2Resolved).toBe(true);
    expect(limiter.active).toBe(1);
    expect(limiter.waiting).toBe(0);
    r2();
  });

  it("queues callers when at capacity and unblocks in order", async () => {
    const limiter = createConcurrencyLimiter(2);
    const order: number[] = [];

    const r1 = await limiter.acquire();
    const r2 = await limiter.acquire();

    // These will queue
    const p3 = limiter.acquire().then((r) => {
      order.push(3);
      return r;
    });
    const p4 = limiter.acquire().then((r) => {
      order.push(4);
      return r;
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(limiter.waiting).toBe(2);

    r1();
    const r3 = await p3;
    expect(limiter.active).toBe(2);
    expect(limiter.waiting).toBe(1);

    r2();
    const r4 = await p4;
    expect(limiter.active).toBe(2);
    expect(limiter.waiting).toBe(0);
    expect(order).toEqual([3, 4]);

    r3();
    r4();
  });

  it("active returns to 0 after all releases", async () => {
    const limiter = createConcurrencyLimiter(3);
    const [r1, r2, r3] = await Promise.all([
      limiter.acquire(),
      limiter.acquire(),
      limiter.acquire(),
    ]);
    expect(limiter.active).toBe(3);
    r1();
    r2();
    r3();
    expect(limiter.active).toBe(0);
  });
});
