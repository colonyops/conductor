import { definePlugin } from "../../../../src/sdk/index.js";

export default definePlugin({
  id: "test-fast-init",
  name: "Fast Init",

  async init({ logger }) {
    logger.info("fast-init: initialized successfully");
  },
});
