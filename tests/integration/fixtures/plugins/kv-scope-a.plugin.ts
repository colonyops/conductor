import { definePlugin } from "../../../../src/sdk/index.js";

export default definePlugin({
  id: "test-kv-scope-a",
  name: "KV Scope A",

  async init({ kv }) {
    await kv.set("probe", "from-a");
  },
});
