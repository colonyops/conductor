import { definePlugin } from "../../../../src/sdk/index.js";

export default definePlugin({
  id: "test-session-creator",
  name: "Session Creator",

  async init({ hive, logger }) {
    const remote = process.env.TEST_REMOTE;
    if (!remote) {
      logger.warn("session-creator: TEST_REMOTE not set, skipping");
      return;
    }
    await hive.newSession({ name: "int-test", remote });
    logger.info("session-creator: session created");
  },
});
