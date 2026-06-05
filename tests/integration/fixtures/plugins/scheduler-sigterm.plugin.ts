import { definePlugin } from "../../../../src/sdk/index.js";

export default definePlugin({
  id: "test-scheduler-sigterm",
  name: "Scheduler SIGTERM",

  async init({ scheduler, logger }) {
    scheduler.interval(100, async () => {
      logger.info("scheduler-sigterm: callback started");
      // Long-running callback to be in-flight when SIGTERM arrives
      await new Promise((r) => setTimeout(r, 10_000));
      logger.info("scheduler-sigterm: callback finished");
    });
  },
});
