import { definePlugin } from "../../../../src/sdk/index.js";

export default definePlugin({
  id: "test-kv-scope-b",
  name: "KV Scope B",

  async init({ kv }) {
    await kv.set("probe", "from-b");
  },
});
