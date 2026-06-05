import { definePlugin } from "../../../../src/sdk/index.js";

export default definePlugin({
  id: "test-slow-init",
  name: "Slow Init",

  async init() {
    // Hangs forever — triggers the 30s INIT_TIMEOUT_MS in loadPlugins()
    await new Promise<void>(() => {});
  },
});
