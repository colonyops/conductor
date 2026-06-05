import { definePlugin } from "../../../../src/sdk/index.js";

export default definePlugin({
  id: "test-polling-dedup",
  name: "Polling Dedup",

  async init({ hive, kv, scheduler, logger }) {
    const remote = process.env.TEST_REMOTE;
    if (!remote) {
      logger.warn("polling-dedup: TEST_REMOTE not set, skipping");
      return;
    }
    scheduler.interval(50, async () => {
      if (await kv.has("done")) return;
      await hive.newSession({ name: "dedup-test", remote });
      await kv.set("done", true);
      logger.info("polling-dedup: session created and deduped");
    });
  },
});
