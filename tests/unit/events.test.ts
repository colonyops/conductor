import { EventBus } from "../../src/core/events.js";
import type { Logger } from "../../src/sdk/logger.js";

interface CapturedLog {
  msg: string;
  data?: Record<string, unknown>;
}

function makeFakeLogger(): { logger: Logger; errors: CapturedLog[] } {
  const errors: CapturedLog[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (msg, data) => {
      errors.push(data ? { msg, data } : { msg });
    },
    with: () => logger,
  };
  return { logger, errors };
}

describe("EventBus", () => {
  it("delivers payloads to registered handlers", async () => {
    const { logger } = makeFakeLogger();
    const bus = new EventBus(logger);
    let received = 0;
    bus.on("conductorStart", async () => {
      received++;
    });
    await bus.emit("conductorStart", {});
    expect(received).toBe(1);
  });

  it("routes handler errors to the structured logger instead of console", async () => {
    const { logger, errors } = makeFakeLogger();
    const bus = new EventBus(logger);
    bus.on("conductorStart", async () => {
      throw new Error("boom");
    });
    await bus.emit("conductorStart", {});
    expect(errors.length).toBe(1);
    expect(errors[0]?.msg).toBe("event handler error");
    expect(errors[0]?.data).toMatchObject({ event: "conductorStart", error: "boom" });
  });

  it("isolates handler failures so later handlers still run", async () => {
    const { logger, errors } = makeFakeLogger();
    const bus = new EventBus(logger);
    let secondRan = false;
    bus.on("conductorStart", async () => {
      throw new Error("first fails");
    });
    bus.on("conductorStart", async () => {
      secondRan = true;
    });
    await bus.emit("conductorStart", {});
    expect(secondRan).toBe(true);
    expect(errors.length).toBe(1);
  });

  it("stops delivering to a handler after it unsubscribes", async () => {
    const { logger } = makeFakeLogger();
    const bus = new EventBus(logger);
    let count = 0;
    const off = bus.on("conductorStart", async () => {
      count++;
    });
    await bus.emit("conductorStart", {});
    off();
    await bus.emit("conductorStart", {});
    expect(count).toBe(1);
  });
});
