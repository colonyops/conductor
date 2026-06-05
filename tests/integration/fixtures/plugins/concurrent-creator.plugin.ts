import { definePlugin } from "../../../../src/sdk/index.js";

export default definePlugin({
  id: "test-concurrent-creator",
  name: "Concurrent Creator",

  async init({ hive, logger }) {
    const remote = process.env.TEST_REMOTE;
    if (!remote) {
      logger.warn("concurrent-creator: TEST_REMOTE not set, skipping");
      return;
    }
    await Promise.all(Array.from({ length: 12 }, (_, i) => hive.newSession({ name: `concurrent-${i}`, remote })));
    logger.info("concurrent-creator: all 12 sessions created");
  },
});
